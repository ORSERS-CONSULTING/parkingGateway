/**********************************************************************
 *  anpr-gateway-dev.js  –  run:  node anpr-gateway-dev.js
 *********************************************************************/
require('dotenv/config');
const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');
const https   = require('https');

const app  = express();
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
  const ts  = Date.now().toString();
  const s   = [
    'POST','*/*',md5,'application/json',
    `x-ca-key:${process.env.APPKEY}`,
    `x-ca-timestamp:${ts}`,
    path
  ].join('\n');
  const sig = crypto.createHmac('sha256', process.env.APPSECRET)
                    .update(s, 'utf8').digest('base64');

  return {
    headers : {
      Accept:'*/*','Content-Type':'application/json','Content-MD5':md5,
      'X-Ca-Key':process.env.APPKEY,'X-Ca-Timestamp':ts,
      'X-Ca-Signature-Headers':'x-ca-key,x-ca-timestamp',
      'X-Ca-Signature':sig
    },
    httpsAgent : new https.Agent({ rejectUnauthorized:false })
  };
}

/**********************************************************************
 * 1)  One-time (or on reboot) subscription
 *********************************************************************/
app.post('/subscribe', async (_req, res) => {
  const body = {
    eventTypes : [131622],                                     // ANPR
    eventDest  : `${process.env.LOCAL_IP}:${PORT}/anpr-event`
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
  res.send('OK');                                 // ACK quickly
  const evs = req.body?.params?.events || [];
  if (!evs.length) return;

  const list = evs.map(ev => ({
    guid              : ev.eventId,
    parking_lot_code  : ev.srcIndex,
    parking_lot_name  : ev.srcName,
    lane_direction    : ev.data?.vehicleDirectionType ?? null,
    plate_number      : ev.data?.plateNo ?? '',
    car_type          : ev.data?.vehicleType ?? null,
    image_url         : ev.data?.vehiclePicUri ?? '',
    enter_time        : ev.happenTime,
    exit_time         : null,
    allow_type        : null,
    allow_result      : null
  }));

  try {
    await axios.post(process.env.APEX_URL,
                     { data: list },
                     { headers:{'Content-Type':'application/json'} });
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
  const start  = new Date(nowUtc); start.setUTCHours(0,0,0,0);

  const body = {
    pageIndex:1, pageSize:10,
    queryInfo:{
      parkingLotIndexCode:'1',
      beginTime: gstTimestamp(start),
      endTime  : gstTimestamp(nowUtc)
    }
  };

  const path = '/artemis/api/vehicle/v1/parkinglot/passageway/record';
  try {
    const r  = await axios.post(`https://${process.env.HIK_HOST}${path}`,
                                body, signPost(path, body));
    const list = r.data?.data?.list || [];
    if (!list.length) return res.send('No vehicle records received.');

    await axios.post(process.env.APEX_URL,
                     { data:list.map(v => ({
                       guid:v.guid,
                       parking_lot_code:v.parkingLotInfo.parkingLotIndexCode,
                       parking_lot_name:v.parkingLotInfo.parkingLotName,
                       passageway_code:v.passagewayInfo.passagewayIndexCode,
                       passageway_name:v.passagewayInfo.passagewayName,
                       lane_code:v.laneInfo.laneIndexCode,
                       lane_name:v.laneInfo.laneName,
                       lane_direction:v.laneInfo.direction,
                       plate_number:v.carInfo.plateLicense,
                       car_type:v.carInfo.carType,
                       image_url:v.carInfo.ImageUrl,
                       enter_time:v.carInfo.EnterTime,
                       exit_time:v.carInfo.ExitTime,
                       allow_type:v.allowType,
                       allow_result:v.allowResult
                     }))},
                     { headers:{'Content-Type':'application/json'} });
    res.send(`Forwarded ${list.length} records to APEX`);
  } catch(e){
    console.error(e.response?.data||e.message);
    res.status(500).send(e.response?.data||e.message);
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
  GET  /run-sync    – manual backfill\n`));
