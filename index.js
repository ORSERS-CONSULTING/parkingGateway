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
  if (cached.token && now < cached.exp - 30) return cached.token;


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
  return cached.token;
}
app.use(express.json({ limit: '2mb' }));      // parse HikCentral JSON


/*--------------------------------------------------*
 | Helper: make RFC-3339 timestamp in GST (+04:00)  |
 *--------------------------------------------------*/
function gstTimestamp(dateObj) {
  const gst = new Date(dateObj.getTime() + 4 * 3600 * 1000);
  return gst.toISOString()         // 2025-07-07T15:36:54.123Z
    .replace(/\.\d{3}Z$/, '+04:00'); // 2025-07-07T15:36:54+04:00
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

  return {
    headers: {
      Accept: '*/*', 'Content-Type': 'application/json', 'Content-MD5': md5,
      'X-Ca-Key': process.env.APPKEY, 'X-Ca-Timestamp': ts,
      'X-Ca-Signature-Headers': 'x-ca-key,x-ca-timestamp',
      'X-Ca-Signature': sig
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  };
}


/**********************************************************************
 * 1)  One-time (or on reboot) subscription
 *********************************************************************/
app.post('/subscribe', async (_req, res) => {
  const body = {
    eventTypes: [131622],                                     // ANPR
    eventDest: `${process.env.LOCAL_IP}/anpr-event`
  };
  const path = '/artemis/api/eventService/v1/eventSubscriptionByEventTypes';

  try {
    await axios.post(`https://${process.env.HIK_HOST}${path}`,
      body, signPost(path, body));
    res.send('Subscription OK – HikCentral will now push ANPR events.');
  } catch (e) {
    res.status(500).send(e.response?.data || e.message);
  }
});

/**********************************************************************
 * 2)  HikCentral pushes every plate read here
 *********************************************************************/
app.post('/anpr-event', async (req, res) => {
  try {
    console.log('===== ANPR EVENT RECEIVED =====');
    console.log('Headers:', req.headers);
    console.log('Body:', JSON.stringify(req.body, null, 2));

    const evs = req.body?.params?.events || [];
    if (!evs.length) {
      console.log('No events found in payload');
      return res.status(400).send({ error: 'No events found in payload' });
    }

    const list = evs.map(ev => {
      const passageName = ev.srcName?.toUpperCase() || '';
      const isExit = passageName.includes('EXIT');

      return {
        guid: ev.eventId,
        parking_lot_code: ev.srcIndex,
        parking_lot_name: ev.srcName,
        plate_number: ev.data?.plateNo ?? '',
        car_type: ev.data?.vehicleType ?? null,
        image_url: ev.data?.vehiclePicUri ?? '',
        enter_time: isExit ? null : ev.happenTime,
        exit_time: isExit ? ev.happenTime : null,
        allow_type: null,
        allow_result: null,
      };
    });

    console.log('Mapped list:', JSON.stringify(list, null, 2));
    console.log('APEX_URL:', process.env.APEX_URL);

    const token = await getIdcsToken();
    console.log('Token fetched successfully');

    const r = await axios.post(
      process.env.APEX_URL,
      { data: list },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        }
      }
    );

    console.log('Oracle response:', JSON.stringify(r.data, null, 2));
    console.log(`✔ wrote ${list.length} rows to Oracle`);

    return res.status(200).send({
      message: 'Inserted successfully',
      sent: list
    });
  } catch (e) {
    console.error('===== APEX INSERT FAILED =====');
    console.error('Message:', e.message);
    console.error('Response data:', e.response?.data);
    console.error('Response status:', e.response?.status);
    console.error('Stack:', e.stack);

    return res.status(500).send({
      error: e.response?.data || e.message
    });
  }
});
/**********************************************************************
 * 3)  Your existing polling route – unchanged
 *********************************************************************/
app.get('/run-sync', async (_req, res) => {
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

  try {
    const r = await axios.post(
      `https://${process.env.HIK_HOST}${path}`,
      body,
      signPost(path, body)
    );

    const list = r.data?.data?.list || [];
    if (!list.length) return res.send('No vehicle records received.');

    const token = await getIdcsToken();

    await axios.post(
      process.env.APEX_URL,
      {
        data: list.map(v => ({
          guid: v.guid,
          parking_lot_code: v.parkingLotInfo.parkingLotIndexCode,
          parking_lot_name: v.parkingLotInfo.parkingLotName,
          passageway_code: v.passagewayInfo.passagewayIndexCode,
          passageway_name: v.passagewayInfo.passagewayName,
          lane_code: v.laneInfo.laneIndexCode,
          lane_name: v.laneInfo.laneName,
          lane_direction: v.laneInfo.direction,
          plate_number: v.carInfo.plateLicense,
          car_type: v.carInfo.carType,
          image_url: v.carInfo.ImageUrl,
          enter_time: v.carInfo.EnterTime,
          exit_time: v.carInfo.ExitTime,
          allow_type: v.allowType,
          allow_result: v.allowResult
        }))
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        }
      }
    );

    res.send(`Forwarded ${list.length} records to APEX`);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).send(e.response?.data || e.message);
  }
});

/* route for allowing to car to exits */

app.post('/confirm-from-db', async (req, res) => {
  const { plateLicense,
    immediatelyLeave,
    fee } = req.body;

  if (!plateLicense || immediatelyLeave === undefined || fee === undefined) {
    return res.status(400).send({ error: 'Missing plateLicense, immediatelyLeave, or fee' });
  }

  const confirmBody = {
    plateLicense,
    immediatelyLeave,
    fee
  };

  const path = '/artemis/api/vehicle/v1/parkingfee/confirm';

  try {
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
    await axios.post(`http://localhost:${PORT}/subscribe`);
    console.log('🔗 ensured ANPR subscription is registered');
  } catch (e) {
    console.error('❌ failed to register subscription (will retry on next start):', e.message);
  }
})();

/**********************************************************************/
app.listen(PORT, () =>
  console.log(`🟢 Listener up on http://0.0.0.0:${PORT}
  POST /subscribe   – register callback  (run once)
  POST /anpr-event  – HikCentral pushes
  POST /confirm-from-db  – Oracle/PLSQL tells us to confirm & open gate
  GET  /run-sync    – manual backfill\n`));