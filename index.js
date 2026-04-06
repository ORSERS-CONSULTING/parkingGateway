const loadConfig = require('./config/env');
(async () => {
  const config = await loadConfig();
  process.env.PORT = config.PORT
  process.env.HIK_HOST = config.HIK_HOST;
  process.env.LOCAL_IP = config.LOCAL_IP;
  process.env.APEX_URL = config.APEX_URL;
  process.env.APPKEY = config.APPKEY;
  process.env.APPSECRET = config.APPSECRET;
  process.env.CLIENT_ID = config.CLIENT_ID;
  process.env.CLIENT_SECRET = config.CLIENT_SECRET;
  process.env.IDCS_TENANT = config.IDCS_TENANT;
})();


const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const https = require('https');

const { getIdcsToken } = require("./services/idcsServices");
const app = express();
const PORT = process.env.PORT || 3000;
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
  res.send('OK');

  console.log('\n===== HIKVISION RAW EVENT =====');
  console.log(JSON.stringify(req.body, null, 2));
  console.log('===============================\n');
  const evs = req.body?.params?.events || [];
  if (!evs.length) return;
  console.log(evs)

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
      country: ev.data?.country ?? null,
      plate_area_name: ev.data?.plateAreaName ?? null,
      plate_category: ev.data?.plateCategory ?? null,
      enter_time: isExit ? null : ev.happenTime,
      exit_time: isExit ? ev.happenTime : null,
      allow_type: null,
      allow_result: null,
    };
  });

  try {
    const token = await getIdcsToken();
    console.log("token", token);
    console.log("apex", process.env.APEX_URL);
    await axios.post(process.env.APEX_URL,
      { data: list },
      {
        headers: {
          'Content-Type': 'application/json',

          Authorization: `Bearer ${token}`
        }
      });
    console.log(`✔ wrote ${list.length} rows to Oracle`);
  } catch (e) {
    console.error('APEX insert failed:', e.response?.data || e.message);
  }
});

/**********************************************************************
 * 3)  Your existing polling route – unchanged
 *********************************************************************/
app.get('/run-sync', async (_req, res) => {
  const nowUtc = new Date();
  const start = new Date(nowUtc); start.setUTCHours(0, 0, 0, 0);

  const body = {
    pageIndex: 1, pageSize: 10,
    queryInfo: {
      parkingLotIndexCode: '1',
      beginTime: gstTimestamp(start),
      endTime: gstTimestamp(nowUtc)
    }
  };

  const path = '/artemis/api/vehicle/v1/parkinglot/passageway/record';
  try {
    const r = await axios.post(`https://${process.env.HIK_HOST}${path}`,
      body, signPost(path, body));

    const list = r.data?.data?.list || [];
    if (!list.length) return res.send('No vehicle records received.');

    const token = await getIdcsToken();
    console.log("token", token);
    console.log("apex", process.env.APEX_URL);
    await axios.post(process.env.APEX_URL,
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
          country: v.carInfo.country ?? null,
          plate_area_name: v.carInfo.plateAreaName ?? null,
          plate_category: v.carInfo.plateCategory ?? null,
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
      });
    res.send(`Forwarded ${list.length} records to APEX`);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).send(e.response?.data || e.message);
  }
});

/* route for allowing to car to exits */

app.post('/confirm-from-db', async (req, res) => {
  const { plateLicense, immediatelyLeave, fee, country, plateCategory } = req.body;

  if (!plateLicense || immediatelyLeave === undefined || fee === undefined) {
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