// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mqtt = require('mqtt'); // ADDED

// Services
const { readSheet } = require('./services/sheets');
const { getUser, setUser, db } = require('./services/firestore');
const { appendToCache, writeCache, readCache } = require('./services/cacheWriter');
const { exceedsThreshold } = require('./services/threshold');

// Load sheet mapping from .env or JSON
const sheetMappings = require('./sheets-credentials.json');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===== MQTT CONFIG & CLIENT =====
const MQTT_URL = process.env.MQTT_URL || ''; // e.g. 'wss://broker.hivemq.com:8000/mqtt' or 'mqtts://...'
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const MQTT_BASE_TOPIC = process.env.MQTT_BASE_TOPIC || 'climbox';
const MQTT_QOS = parseInt(process.env.MQTT_QOS || '1', 10);
const MQTT_RETAIN = (process.env.MQTT_RETAIN || 'true') === 'true';

let mqttClient = null;
if (MQTT_URL) {
  const mqttOpts = {
    username: MQTT_USERNAME || undefined,
    password: MQTT_PASSWORD || undefined,
    // keepalive: 30,
    reconnectPeriod: 5000
  };
  console.log('Attempting MQTT connect to', MQTT_URL);
  mqttClient = mqtt.connect(MQTT_URL, mqttOpts);
  mqttClient.on('connect', () => console.log('MQTT connected'));
  mqttClient.on('error', (e) => console.error('MQTT error', e && e.message ? e.message : e));
  mqttClient.on('reconnect', () => console.log('MQTT reconnecting...'));
  mqttClient.on('close', () => console.log('MQTT closed'));
} else {
  console.warn('MQTT_URL not set — MQTT disabled');
}

const MQTT_PUBLISH_LATEST_ONLY = (process.env.MQTT_PUBLISH_LATEST_ONLY || 'true') === 'true';
const MQTT_PUBLISH_LATEST_N = Math.max(1, parseInt(process.env.MQTT_PUBLISH_LATEST_N || '1', 10));


function publishLocationData(locationId, sheetName, rows) {
  if (!mqttClient || !mqttClient.connected) {
    return;
  }

  // Normalize: rows may be [] or non-array (single row)
  let totalRows = 0;
  let rowsArray = [];

  if (Array.isArray(rows)) {
    rowsArray = rows;
    totalRows = rows.length;
  } else if (rows && typeof rows === 'object') {
    rowsArray = [rows];
    totalRows = 1;
  } else {
    // nothing to publish
    return;
  }

  // Decide what to publish over MQTT: either whole array or only last N
  let publishRows;
  if (MQTT_PUBLISH_LATEST_ONLY && totalRows > 0) {
    const n = Math.min(MQTT_PUBLISH_LATEST_N, totalRows);
    publishRows = rowsArray.slice(-n);
  } else {
    publishRows = rowsArray;
  }

  const topic = `${MQTT_BASE_TOPIC}/${locationId}/latest`;
  const payloadObj = {
    locationId,
    sheetName,
    timestamp: new Date().toISOString(),
    rowCount: totalRows,    // total rows in the sheet cached
    rows: publishRows       // this will be array of 1 (or N) latest rows
  };

  const payload = JSON.stringify(payloadObj);

  mqttClient.publish(topic, payload, { qos: MQTT_QOS, retain: MQTT_RETAIN }, (err) => {
    if (err) console.error('MQTT publish error', err);
    else console.log(`Published ${topic} (publishedRows: ${Array.isArray(publishRows)?publishRows.length:'?'} totalRows: ${totalRows})`);
  });
}


// Optional: publish single ingestion messages
function publishIngest(locationId, payload) {
  if (!mqttClient || !mqttClient.connected) return;
  const topic = `${MQTT_BASE_TOPIC}/${locationId}/ingest`;
  const pl = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });
  mqttClient.publish(topic, pl, { qos: 0, retain: false }, (err) => {
    if (err) console.error('MQTT publish ingest error', err);
    else console.log('Published ingest', topic);
  });
}

// ===== Health Check =====
app.get('/', (req, res) => {
  res.send('ClimBox backend running (Hybrid: Firestore + Google Sheets) — MQTT integrated');
});

// Helper: normalize rows (if readSheet returns array-of-arrays)
function arraysToObjects(rows) {
  // rows: [headerArray, ...rowsArray] OR array-of-objects
  if (!Array.isArray(rows) || rows.length === 0) return [];
  if (Array.isArray(rows[0])) {
    const header = rows[0];
    return rows.slice(1).map(r => header.reduce((o, k, i) => { o[k] = r[i] ?? null; return o; }, {}));
  }
  // already objects
  return rows;
}

// POST sync-cache (force read Sheet -> write cache)
app.post('/sync-cache/:locationId', async (req, res) => {
  try {
    const loc = req.params.locationId;
    const mapping = sheetMappings.find(m => m.locationId === loc);
    if (!mapping) return res.status(404).json({ ok:false, error:'no_mapping' });

    // allow overriding sheetName via body or query
    const sheetName = req.body.sheetName || req.query.sheetName || mapping.sheetName;

    const rawRows = await readSheet(mapping.sheetId, sheetName, 'A:Z');
    const rows = arraysToObjects(rawRows);

    // write cache: folder per location, file per sheetName
    writeCache(loc, sheetName, rows);

    // publish to MQTT (if enabled)
    try { publishLocationData(loc, sheetName, rows); } catch (e) { console.warn('publish error', e); }

    return res.json({ ok:true, location: loc, sheetName, rows: rows.length });
  } catch (err) {
    console.error('sync-cache error', err);
    res.status(500).json({ ok:false, error: err.message || 'server_error' });
  }
});

// ==== Debug
app.get('/debug/sensors/:locationId/raw', async (req, res) => {
  try {
    const mapping = sheetMappings.find(m => m.locationId === req.params.locationId);
    const out = await readSheet(mapping.sheetId, mapping.sheetName, 'A:Z');
    console.log('DEBUG readSheet first item type:', Array.isArray(out) ? 'array' : typeof out, out && out[0]);
    res.json({ ok: true, sample: out && out[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ===== User APIs (Firestore) =====
app.get('/user/:uid', async (req, res) => {
  try {
    const data = await getUser(req.params.uid);
    if (!data) return res.status(404).json({ error: 'User not found' });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/user/:uid', async (req, res) => {
  try {
    await setUser(req.params.uid, req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ===== Sensor Data (Google Sheets) =====
// prefer cache for /sensors (dashboard older code)
app.get('/sensors/:locationId', async (req, res) => {
  try {
    const loc = req.params.locationId;
    // Try cache first
    const cached = readCache(loc);
    if (cached) return res.json(cached);

    // fallback to reading sheet live
    const mapping = sheetMappings.find(m => m.locationId === loc);
    if (!mapping) return res.status(404).json({error:'no_mapping'});
    const raw = await readSheet(mapping.sheetId, mapping.sheetName, 'A:Z');
    const rows = arraysToObjects(raw);
    // optionally write cache now
    writeCache(loc, mapping.sheetName, rows);

    // publish after writing cache
    try { publishLocationData(loc, mapping.sheetName, rows); } catch (e) { console.warn('publish error', e); }

    res.json(rows);
  } catch (err) {
    console.error('/sensors error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ===== AUTO SYNC (optional) =====
// AUTO_SYNC=true in .env to enable (careful with Sheets quota)
if (process.env.AUTO_SYNC === 'true') {
  const interval = parseInt(process.env.AUTO_SYNC_INTERVAL || '3000', 10);
  console.log(`Auto-sync enabled: interval ${interval} ms`);
  async function syncAllLocationsOnce() {
    for (const mapping of sheetMappings) {
      try {
        const sheetName = mapping.sheetName;
        const raw = await readSheet(mapping.sheetId, sheetName, 'A:Z');
        const rows = arraysToObjects(raw);
        writeCache(mapping.locationId, sheetName, rows);
        try { publishLocationData(mapping.locationId, sheetName, rows); } catch (e) { console.warn('publish error', e); }
      } catch (err) {
        console.warn('auto-sync error for', mapping.locationId, err.message || err);
      }
    }
  }
  syncAllLocationsOnce().catch(e=>console.warn(e));
  setInterval(syncAllLocationsOnce, interval);
}

// ===== Ingest New Sensor Reading =====
app.post('/ingest', async (req, res) => {
  try {
    const payload = req.body;

    if (!payload.locationId || !payload.sensorId || !payload.sensorType || payload.value === undefined) {
      return res.status(400).json({ error: 'missing required fields' });
    }

    // Append to cache (for notifications)
    appendToCache({
      timestamp: new Date().toISOString(),
      ...payload
    });

    // publish ingest message (non-retain)
    try { publishIngest(payload.locationId, payload); } catch (e) { console.warn('ingest publish error', e); }

    // Threshold check (no Firestore store for sensor data)
    if (exceedsThreshold(payload.value, payload.threshold || 30)) {
      console.log(`ALERT: ${payload.locationId} ${payload.sensorType}=${payload.value}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend listening on http://localhost:${PORT}`));
