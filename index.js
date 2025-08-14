// /home/user/climbox-backend/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mqtt = require('mqtt');
const path = require('path');
const fs = require('fs');

// Services (assumed present)
const { readSheet } = require('./services/sheets');
const { getUser, setUser, db } = require('./services/firestore');
const { appendToCache, writeCache, readCache, PUBLIC_DATA_DIR } = require('./services/cacheWriter');
const { exceedsThreshold } = require('./services/threshold');

const sheetMappings = require('./sheets-credentials.json');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===== MQTT CONFIG & CLIENT =====
const MQTT_URL = process.env.MQTT_URL || ''; // e.g. 'wss://broker.emqx.io:8084/mqtt' or 'mqtt://...'
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const MQTT_BASE_TOPIC = process.env.MQTT_BASE_TOPIC || 'climbox';
const MQTT_QOS = parseInt(process.env.MQTT_QOS || '1', 10);
const MQTT_RETAIN = (process.env.MQTT_RETAIN || 'true') === 'true';
const MQTT_PUBLISH_LATEST_ONLY = (process.env.MQTT_PUBLISH_LATEST_ONLY || 'true') === 'true';
const MQTT_PUBLISH_LATEST_N = Math.max(1, parseInt(process.env.MQTT_PUBLISH_LATEST_N || '1', 10));

let mqttClient = null;
if (MQTT_URL) {
  const mqttOpts = {
    username: MQTT_USERNAME || undefined,
    password: MQTT_PASSWORD || undefined,
    reconnectPeriod: 5000
  };
  console.log('Attempting MQTT connect to', MQTT_URL);
  mqttClient = mqtt.connect(MQTT_URL, mqttOpts);
  mqttClient.on('connect', () => {
    console.log('MQTT connected');
  });
  mqttClient.on('error', (e) => console.error('MQTT error', e && e.message ? e.message : e));
  mqttClient.on('reconnect', () => console.log('MQTT reconnecting...'));
  mqttClient.on('close', () => console.log('MQTT closed'));
} else {
  console.warn('MQTT_URL not set — MQTT disabled');
}

// In-memory dedupe map: last published timestamp per location
const lastPublishedTs = new Map();

// ===== helpers: date & sheetName
function todaySheetName() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `data_${y}-${m}-${dd}`;
}

/**
 * getSheetName(mapping, explicit)
 * explicit can be:
 *  - full sheetName: 'data_2025-08-14' or 'MyTab'
 *  - date '2025-08-14' -> converted to 'data_2025-08-14'
 * If mapping.sheetName contains '{date}', it will be replaced by today's date.
 * If mapping.sheetName is like data_YYYY-MM-DD it will be replaced by today's date as well.
 */
function getSheetName(mapping, explicitDate) {
  if (explicitDate) return `data_${explicitDate}`;
  
  // cek apakah latest.json ada dan pakai sheetName-nya
  try {
    const latestPath = path.join(PUBLIC_DATA_DIR, mapping.locationId, 'latest.json');
    if (fs.existsSync(latestPath)) {
      const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
      if (latest.sheetName) return latest.sheetName;
    }
  } catch (e) {
    console.warn('read latest.json error', e);
  }

  return mapping.sheetName || todaySheetName();
}

// Normalize rows helper (preserve previous behaviour)
function arraysToObjects(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  if (Array.isArray(rows[0])) {
    const header = rows[0];
    return rows.slice(1).map(r => header.reduce((o, k, i) => { o[k] = r[i] ?? null; return o; }, {}));
  }
  return rows;
}

// publish rows to mqtt (only last N by default)
// includes dedupe: won't publish if last row timestamp equals previously published
function publishLocationData(locationId, sheetName, rows) {
  if (!mqttClient || !mqttClient.connected) return;
  if (!rows) return;

  // normalize to array
  const rowsArr = Array.isArray(rows) ? rows : [rows];
  const totalRows = rowsArr.length;
  const n = (MQTT_PUBLISH_LATEST_ONLY && totalRows > 0) ? Math.min(MQTT_PUBLISH_LATEST_N, totalRows) : totalRows;
  const publishRows = (n === totalRows) ? rowsArr : rowsArr.slice(-n);

  // attempt to find last timestamp in published rows (if there is a Timestamp column)
  const lastRow = publishRows.length ? publishRows[publishRows.length - 1] : null;
  const candidateTs = lastRow && (lastRow.Timestamp || lastRow.timestamp || lastRow.time) ? String(lastRow.Timestamp || lastRow.timestamp || lastRow.time) : null;

  // dedupe: if unchanged, skip
  if (candidateTs) {
    const prev = lastPublishedTs.get(locationId);
    if (prev === candidateTs) {
      // nothing changed -> skip publish to keep broker/logs clean
      // still optional to publish; we skip
      return;
    }
    lastPublishedTs.set(locationId, candidateTs);
  }

  const topic = `${MQTT_BASE_TOPIC}/${locationId}/latest`;
  const payloadObj = {
    locationId,
    sheetName,
    timestamp: new Date().toISOString(),
    rowCount: totalRows,
    rows: publishRows
  };
  const payload = JSON.stringify(payloadObj);
  mqttClient.publish(topic, payload, { qos: MQTT_QOS, retain: MQTT_RETAIN }, (err) => {
    if (err) console.error('MQTT publish error', err);
    else console.log(`Published ${topic} (publishedRows: ${publishRows.length} totalRows: ${totalRows})`);
  });
}

function publishIngest(locationId, payload) {
  if (!mqttClient || !mqttClient.connected) return;
  const topic = `${MQTT_BASE_TOPIC}/${locationId}/ingest`;
  const pl = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });
  mqttClient.publish(topic, pl, { qos: 0, retain: false }, (err) => {
    if (err) console.error('MQTT publish ingest error', err);
    else console.log('Published ingest', topic);
  });
}

// ===== simple health
app.get('/', (req, res) => {
  res.send('ClimBox backend running (Hybrid: Firestore + Google Sheets) — MQTT integrated');
});

// GET /locations -> read from sheetMappings
app.get('/locations', (req, res) => {
  try {
    const out = (sheetMappings || []).map(m => ({
      locationId: m.locationId,
      displayName: m.displayName || m.locationId,
      coords: m.coords || null,
      country: m.country || null,
      sheetId: m.sheetId || null,
      sheetNamePattern: m.sheetName || null,
      type: m.type || null
    }));
    res.json(out);
  } catch (e) {
    console.error('GET /locations error', e);
    res.status(500).json({ ok:false, error: e.message || 'server_error' });
  }
});

// POST /sync-cache/:locationId  -> force read sheet and update cache + publish
app.post('/sync-cache/:locationId', async (req, res) => {
  try {
    const loc = req.params.locationId;
    const mapping = sheetMappings.find(m => m.locationId === loc);
    if (!mapping) return res.status(404).json({ ok:false, error:'no_mapping' });

    const explicit = req.body.sheetName || req.query.sheetName || req.query.date;
    const sheetName = getSheetName(mapping, explicit);

    const rawRows = await readSheet(mapping.sheetId, sheetName, 'A:Z');
    const rows = arraysToObjects(rawRows);

    writeCache(loc, sheetName, rows);

    try { publishLocationData(loc, sheetName, rows); } catch (e) { console.warn('publish error', e); }

    return res.json({ ok:true, location: loc, sheetName, rows: rows.length });
  } catch (err) {
    console.error('sync-cache error', err);
    res.status(500).json({ ok:false, error: err.message || 'server_error' });
  }
});

// debug helper: read raw from sheet
app.get('/debug/sensors/:locationId/raw', async (req, res) => {
  try {
    const mapping = sheetMappings.find(m => m.locationId === req.params.locationId);
    if (!mapping) return res.status(404).json({ ok:false, error:'no_mapping' });
    const explicit = req.query.sheetName || req.query.date;
    const sheetName = getSheetName(mapping, explicit);
    const out = await readSheet(mapping.sheetId, sheetName, 'A:Z');
    res.json({ ok: true, sheetName, sample: (out && out[0]) || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ===== User APIs (Firestore)
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

// ===== Sensor Data (HTTP) - prefer cache
app.get('/sensors/:locationId', async (req, res) => {
  try {
    const loc = req.params.locationId;
    const mapping = sheetMappings.find(m => m.locationId === loc);
    if (!mapping) return res.status(404).json({ error: 'no_mapping' });

    // Determine desired sheetName (supports ?sheetName=... or ?date=YYYY-MM-DD)
    const explicit = req.query.sheetName || req.query.date;
    const desiredSheet = getSheetName(mapping, explicit);

    // Try read latest.json to see what cache points to (if any)
    try {
      const locDir = path.join(PUBLIC_DATA_DIR, loc);
      const latestPath = path.join(locDir, 'latest.json');
      if (fs.existsSync(latestPath)) {
        const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
        // if latest refers to the desired sheet, return cached rows
        if (latest && latest.sheetName === desiredSheet) {
          const cached = readCache(loc); // returns rows from the cached target file
          if (cached) return res.json(cached);
        }
      }
    } catch (e) {
      console.warn('warning checking latest.json for cache validation', e && e.message ? e.message : e);
      // fallthrough -> we'll read sheet live
    }

    // fallback: read sheet live (this will use desiredSheet)
    const raw = await readSheet(mapping.sheetId, desiredSheet, 'A:Z');
    const rows = arraysToObjects(raw || []);

    // write cache (overwrites latest.json pointing to desiredSheet)
    writeCache(loc, desiredSheet, rows);

    // publish latest over MQTT if enabled
    try { publishLocationData(loc, desiredSheet, rows); } catch (e) { console.warn('publish error', e); }

    res.json(rows);
  } catch (err) {
    console.error('/sensors error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ===== AUTO SYNC (optional)
if (process.env.AUTO_SYNC === 'true') {
  const interval = parseInt(process.env.AUTO_SYNC_INTERVAL || '30000', 10);
  console.log(`Auto-sync enabled: interval ${interval} ms`);
  async function syncAllLocationsOnce() {
    for (const mapping of sheetMappings) {
      try {
        const sheetName = getSheetName(mapping);
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

// ===== Ingest New Sensor Reading (from device)
app.post('/ingest', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload.locationId || !payload.sensorId || !payload.sensorType || payload.value === undefined) {
      return res.status(400).json({ error: 'missing required fields' });
    }

    appendToCache({
      timestamp: new Date().toISOString(),
      ...payload
    });

    try { publishIngest(payload.locationId, payload); } catch (e) { console.warn('ingest publish error', e); }

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
