const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

const base64 = require('base-64');

let cached = { token: null, exp: 0 };

async function getIdcsToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && now < cached.exp - 30) {
    console.log('[TOKEN] Using cached token');
    return cached.token;
  }

  console.log('[TOKEN] Fetching new IDCS token...');
  const url = `https://${process.env.IDCS_TENANT}/oauth2/v1/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: process.env.APEX_URL
  }).toString();

  const { data } = await axios.post(url, body, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${base64.encode(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`)}`
    },
  });

  cached.token = data.access_token;
  cached.exp = now + data.expires_in;
  console.log('[TOKEN] New token received');
  return cached.token;
}

app.use(express.json({ limit: '2mb' }));

/* ---------------- GLOBAL REQUEST LOGGER ---------------- */
app.use((req, res, next) => {
  const now = new Date().toISOString();
  console.log('======================================================');
  console.log(`[REQ] ${now}`);
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  console.log(`[REQ] IP: ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
  console.log(`[REQ] Host: ${req.headers.host}`);
  console.log(`[REQ] User-Agent: ${req.headers['user-agent'] || '-'}`);
  console.log(`[REQ] Content-Type: ${req.headers['content-type'] || '-'}`);
  console.log(`[REQ] Content-Length: ${req.headers['content-length'] || '-'}`);
  next();
});

/* ---------------- HEALTH CHECK ---------------- */
app.get('/health', (_req, res) => {
  console.log('[HEALTH] Health endpoint hit');
  res.status(200).send('ok');
});

/* ---------------- ERROR HANDLER FOR BAD JSON ---------------- */
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('[JSON ERROR] Invalid JSON received');
    console.error(err.message);
    return res.status(400).send({ error: 'Invalid JSON payload' });
  }
  next(err);
});

/*--------------------------------------------------*
 | Helper: make RFC-3339 timestamp in GST (+04:00)  |
 *--------------------------------------------------*/
function gstTimestamp(dateObj) {
  const gst = new Date(dateObj.getTime() + 4 * 3600 * 1000);
  return gst.toISOString().replace(/\.\d{3}Z$/, '+04:00');
}

/*--------------------------------------------------*
 | Helper: sign any Artemis POST                    |
 *--------------------------------------------------*/
function signPost(path, jsonBody) {
  const md5 = crypto.createHash('md5').update(JSON.stringify(jsonBody)).digest('base64');
  const ts = Date.now().toString();
  const s = [
    'POST', '*/*', md5, 'application/json',
    `x-ca-key:${process.env.APPKEY}`,
    `x-ca-timestamp:${ts}`,
    path
  ].join('\n');

  const sig = crypto.createHmac('sha256', process.env.APPSECRET)
    .update(s, 'utf8').digest('base64');

  console.log(`[SIGN] Path: ${path}`);
  console.log(`[SIGN] Timestamp: ${ts}`);

  return {
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json',
      'Content-MD5': md5,
      'X-Ca-Key': process.env.APPKEY,
      'X-Ca-Timestamp': ts,
      'X-Ca-Signature-Headers': 'x-ca-key,x-ca-timestamp',
      'X-Ca-Signature': sig
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  };
}

/**********************************************************************
 * 1) One-time subscription
 *********************************************************************/
app.post('/subscribe', async (_req, res) => {
  const body = {
    eventTypes: [131622],
    eventDest: `${process.env.LOCAL_IP}/anpr-event`
  };
  const path = '/artemis/api/eventService/v1/eventSubscriptionByEventTypes';

  console.log('[SUBSCRIBE] Registering subscription...');
  console.log('[SUBSCRIBE] eventDest:', body.eventDest);

  try {
    const response = await axios.post(
      `https://${process.env.HIK_HOST}${path}`,
      body,
      signPost(path, body)
    );

    console.log('[SUBSCRIBE] Success:', response.data);
    res.send('Subscription OK – HikCentral will now push ANPR events.');
  } catch (e) {
    console.error('[SUBSCRIBE] Failed:', e.response?.data || e.message);
    res.status(500).send(e.response?.data || e.message);
  }
});

/**********************************************************************
 * 2) HikCentral pushes every plate read here
 *********************************************************************/
app.post('/anpr-event', async (req, res) => {
  console.log('================ ANPR EVENT RECEIVED ================');
  console.log('[ANPR] Headers:', JSON.stringify(req.headers, null, 2));
  console.log('[ANPR] Raw body:', JSON.stringify(req.body, null, 2));

  res.send('OK');

  const evs = req.body?.params?.events || [];
  console.log(`[ANPR] Event count: ${evs.length}`);

  if (!evs.length) {
    console.log('[ANPR] No events found in payload');
    return;
  }

  const list = evs.map(ev => {
    const passageName = ev.srcName?.toUpperCase() || '';
    const isExit = passageName.includes('EXIT');
    const parkingLotCode = String(ev.srcIndex) === '8' ? 22 : ev.srcIndex;

    const mapped = {
      guid: ev.eventId,
      parking_lot_code: parkingLotCode,
      parking_lot_name: ev.srcName,
      plate_number: ev.data?.plateNo ?? '',
      car_type: ev.data?.vehicleType ?? null,
      image_url: ev.data?.vehiclePicUri ?? '',
      country: ev.data?.country ?? null,
      plate_area_name: ev.data?.plateAreaName ?? null,
      plate_category: ev.data?.plateCategory ?? null,
      enter_time: isExit ? null : ev.happenTime,
      exit_time: isExit ? ev.happenTime : null,
      allow_type: null,
      allow_result: null,
    };

    console.log('[ANPR] Mapped row:', JSON.stringify(mapped, null, 2));
    return mapped;
  });

  try {
    const token = await getIdcsToken();

    console.log('[ANPR] Posting mapped rows to APEX...');
    console.log('[ANPR] APEX_URL:', process.env.APEX_URL);
    console.log('[ANPR] Payload:', JSON.stringify({ data: list }, null, 2));

    const response = await axios.post(
      process.env.APEX_URL,
      { data: list },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        }
      }
    );

    console.log(`[ANPR] ✔ wrote ${list.length} rows to Oracle`);
    console.log('[ANPR] Oracle response:', response.data);
  } catch (e) {
    console.error('[ANPR] APEX insert failed:', e.response?.data || e.message);
  }
});

/**********************************************************************
 * 3) Existing polling route
 *********************************************************************/
app.get('/run-sync', async (_req, res) => {
  console.log('================ RUN SYNC START ================');

  const nowUtc = new Date();
  const start = new Date(nowUtc);
  start.setUTCHours(0, 0, 0, 0);

  const body = {
    pageIndex: 1,
    pageSize: 10,
    queryInfo: {
      parkingLotIndexCode: '1',
      beginTime: gstTimestamp(start),
      endTime: gstTimestamp(nowUtc)
    }
  };

  const path = '/artemis/api/vehicle/v1/parkinglot/passageway/record';

  console.log('[RUN-SYNC] Request body:', JSON.stringify(body, null, 2));

  try {
    const r = await axios.post(
      `https://${process.env.HIK_HOST}${path}`,
      body,
      signPost(path, body)
    );

    console.log('[RUN-SYNC] Hikvision response received');
    console.log('[RUN-SYNC] Hikvision raw data:', JSON.stringify(r.data, null, 2));

    const list = r.data?.data?.list || [];
    console.log(`[RUN-SYNC] Record count: ${list.length}`);

    if (!list.length) {
      console.log('[RUN-SYNC] No vehicle records received');
      return res.send('No vehicle records received.');
    }

    const token = await getIdcsToken();

    const mappedPayload = {
      data: list.map(v => ({
        guid: v.guid,
        parking_lot_code:
          String(v.parkingLotInfo?.parkingLotIndexCode) === '8'
            ? 22
            : v.parkingLotInfo?.parkingLotIndexCode,
        parking_lot_name: v.parkingLotInfo?.parkingLotName,
        passageway_code: v.passagewayInfo?.passagewayIndexCode,
        passageway_name: v.passagewayInfo?.passagewayName,
        lane_code: v.laneInfo?.laneIndexCode,
        lane_name: v.laneInfo?.laneName,
        lane_direction: v.laneInfo?.direction,
        plate_number: v.carInfo?.plateLicense,
        car_type: v.carInfo?.carType,
        image_url: v.carInfo?.ImageUrl,
        country: v.carInfo?.country ?? null,
        plate_area_name: v.carInfo?.plateAreaName ?? null,
        plate_category: v.carInfo?.plateCategory ?? null,
        enter_time: v.carInfo?.EnterTime,
        exit_time: v.carInfo?.ExitTime,
        allow_type: v.allowType,
        allow_result: v.allowResult
      }))
    };

    console.log('[RUN-SYNC] Posting mapped payload to APEX...');
    console.log(JSON.stringify(mappedPayload, null, 2));

    const apexResponse = await axios.post(
      process.env.APEX_URL,
      mappedPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        }
      }
    );

    console.log('[RUN-SYNC] Oracle response:', apexResponse.data);
    res.send(`Forwarded ${list.length} records to APEX`);
  } catch (e) {
    console.error('[RUN-SYNC] Failed:', e.response?.data || e.message);
    res.status(500).send(e.response?.data || e.message);
  }
});

/* route for allowing car to exit */
app.post('/confirm-from-db', async (req, res) => {
  console.log('================ CONFIRM FROM DB ================');
  console.log('[CONFIRM] Body:', JSON.stringify(req.body, null, 2));

  const { plateLicense, immediatelyLeave, fee, country, plateCategory } = req.body;

  if (!plateLicense || immediatelyLeave === undefined || fee === undefined) {
    console.error('[CONFIRM] Missing required fields');
    return res.status(400).send({ error: 'Missing plateLicense, immediatelyLeave, or fee' });
  }

  const confirmBody = {
    plateLicense,
    immediatelyLeave,
    fee,
    ...(country != null ? { country } : {}),
    ...(plateCategory != null ? { plateCategory } : {}),
  };

  const path = '/artemis/api/vehicle/v1/parkingfee/confirm';

  try {
    console.log('[CONFIRM] Sending to Hikvision:', JSON.stringify(confirmBody, null, 2));

    const response = await axios.post(
      `https://${process.env.HIK_HOST}${path}`,
      confirmBody,
      signPost(path, confirmBody)
    );

    console.log('✅ Confirmation sent to Hikvision:', response.data);
    res.status(200).send({ message: 'Confirmation sent', result: response.data });
  } catch (e) {
    console.error('❌ Confirm API failed:', e.response?.data || e.message);
    res.status(500).send({ error: e.response?.data || e.message });
  }
});

(async () => {
  try {
    console.log('[BOOT] Triggering self-subscribe...');
    await axios.post(`http://localhost:${PORT}/subscribe`);
    console.log('🔗 ensured ANPR subscription is registered');
  } catch (e) {
    console.error('❌ failed to register subscription (will retry on next start):', e.message);
  }
})();

app.listen(PORT, () =>
  console.log(`🟢 Listener up on http://0.0.0.0:${PORT}
  GET  /health         – health check
  POST /subscribe      – register callback
  POST /anpr-event     – HikCentral pushes
  POST /confirm-from-db – Oracle/PLSQL tells us to confirm & open gate
  GET  /run-sync       – manual backfill\n`)
);