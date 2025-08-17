// /home/user/climbox-backend/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mqtt = require('mqtt');
const path = require('path');
const fs = require('fs');

// Services (may export appendToCache/writeCache/readCache/PUBLIC_DATA_DIR)
const { readSheet } = require('./services/sheets');
const { getUser, setUser, db } = require('./services/firestore');
const cacheWriter = require('./services/cacheWriter'); // we'll call methods safely
const { exceedsThreshold } = require('./services/threshold');

const writeCache = cacheWriter.writeCache;
const readCache = cacheWriter.readCache;
const PUBLIC_DATA_DIR = cacheWriter.PUBLIC_DATA_DIR;
const appendToCache = cacheWriter.appendToCache; // may be undefined or different signature

// Load sheet mapping from sheets-credentials.json
let sheetMappings = [];
try {
  sheetMappings = require('./sheets-credentials.json');
} catch (e) {
  console.warn('sheets-credentials.json not found or invalid, continuing with empty mapping');
}

const app = express();
app.use(cors());
app.use(bodyParser.json());
// serve static files (public, and data)
app.use('/data', express.static(path.join(__dirname, 'public', 'data')));
app.use(express.static(path.join(__dirname, 'public')));

// ===== MQTT CONFIG & CLIENT =====
const MQTT_URL = process.env.MQTT_URL || ''; // e.g. 'wss://broker.emqx.io:8084/mqtt'
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
  mqttClient.on('connect', () => console.log('MQTT connected'));
  mqttClient.on('error', (e) => console.error('MQTT error', e && e.message ? e.message : e));
  mqttClient.on('reconnect', () => console.log('MQTT reconnecting...'));
  mqttClient.on('close', () => console.log('MQTT closed'));
} else {
  console.warn('MQTT_URL not set — MQTT disabled');
}

// In-memory dedupe map: last published key per location
const lastPublishedTs = new Map();

// ===== helpers: date & sheetName =====
function todaySheetName() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `data_${y}-${m}-${dd}`;
}

/**
 * getSheetName(mapping, explicitDate)
 * - explicitDate: 'YYYY-MM-DD' or a full sheet tab name
 * Priority:
 *  1) explicitDate provided -> use it
 *  2) otherwise -> use today's sheet name (data_YYYY-MM-DD)
 *
 * We intentionally IGNORE mapping.sheetName by default so backend always prefers today's sheet.
 */
function getSheetName(mapping, explicitDate) {
  if (explicitDate) {
    const s = String(explicitDate).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `data_${s}`;
    return s;
  }
  return todaySheetName();
}

/**
 * findRecentSheetAndRows(mapping, explicit, maxBackDays)
 * - Attempts to read today's sheet first; if empty / not found then try previous days up to maxBackDays.
 * - If explicit provided, attempts only that sheetName/date.
 * - Returns { sheetName, rows } where rows = array (maybe empty)
 */
async function findRecentSheetAndRows(mapping, explicit, maxBackDays = 3) {
  const sheetId = mapping.sheetId;
  if (!sheetId) return { sheetName: getSheetName(mapping, explicit), rows: [] };

  // explicit override (sheetName or date)
  if (explicit) {
    const sn = getSheetName(mapping, explicit);
    try {
      const raw = await readSheet(sheetId, sn, 'A:Z');
      const rows = arraysToObjects(raw || []);
      return { sheetName: sn, rows };
    } catch (err) {
      // explicit requested but read failed -> return empty rows with the explicit name
      console.warn(`findRecentSheetAndRows explicit read failed for ${sn}:`, err && err.message ? err.message : err);
      return { sheetName: sn, rows: [] };
    }
  }

  // try today then back up
  for (let i = 0; i < Math.max(1, maxBackDays); i++) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    const cand = `data_${yyyy}-${mm}-${dd}`;
    try {
      const raw = await readSheet(sheetId, cand, 'A:Z');
      const rows = arraysToObjects(raw || []);
      if (Array.isArray(rows) && rows.length > 0) {
        return { sheetName: cand, rows };
      }
      // continue if empty
    } catch (err) {
      // sheet/tab might not exist or permission issue -> continue trying previous days
      // console.debug(`readSheet failed for ${cand}:`, err && err.message ? err.message : err);
    }
  }

  // nothing found -> return today's sheetName but rows empty
  return { sheetName: todaySheetName(), rows: [] };
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

// Safe appendToCache wrapper: tolerant to different cacheWriter implementations
async function safeAppendToCache(locationId, rows, meta = {}) {
  if (!appendToCache) {
    // nothing to call
    return;
  }
  try {
    // If appendToCache expects (locationId, rows, meta)
    if (appendToCache.length >= 2) {
      // try with locationId, rows, meta
      try {
        await appendToCache(locationId, rows, meta);
        return;
      } catch (e) {
        // try fallback below
      }
    }

    // fallback: call with single object
    const payload = {
      locationId,
      rows,
      meta,
      cachedAt: new Date().toISOString()
    };
    await appendToCache(payload);
  } catch (err) {
    console.warn('safeAppendToCache failed', err && err.message ? err.message : err);
  }
}

// publish rows to mqtt (only last N by default) with dedupe
function publishLocationData(locationId, sheetName, rows, opts = {}) {
  if (!mqttClient || !mqttClient.connected) return;
  if (!rows) return;

  const rowsArr = Array.isArray(rows) ? rows : [rows];
  const totalRows = rowsArr.length;
  const n = (MQTT_PUBLISH_LATEST_ONLY && totalRows > 0) ? Math.min(MQTT_PUBLISH_LATEST_N, totalRows) : totalRows;
  const publishRows = (n === totalRows) ? rowsArr : rowsArr.slice(-n);

  const lastRow = publishRows.length ? publishRows[publishRows.length - 1] : null;
  const candidateTs = lastRow && (lastRow.Timestamp || lastRow.timestamp || lastRow.time) ? String(lastRow.Timestamp || lastRow.timestamp || lastRow.time) : null;

  const dedupeKey = `${sheetName || ''}|${candidateTs || ''}`;
  const force = !!opts.force;

  if (!force && candidateTs) {
    const prev = lastPublishedTs.get(locationId);
    if (prev === dedupeKey) {
      console.log(`Skipping publish for ${locationId} — dedupe matched (${dedupeKey})`);
      return;
    }
    lastPublishedTs.set(locationId, dedupeKey);
  } else if (force && candidateTs) {
    lastPublishedTs.set(locationId, dedupeKey);
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
    else console.log(`Published ${topic} (publishedRows: ${publishRows.length} totalRows: ${totalRows}) sheet:${sheetName} lastRowTs:${candidateTs} force:${force}`);
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

// GET /locations -> mapping for frontend
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

// POST /sync-cache/:locationId -> force read sheet and update cache + publish
app.post('/sync-cache/:locationId', async (req, res) => {
  try {
    const loc = req.params.locationId;
    const mapping = sheetMappings.find(m => m.locationId === loc);
    if (!mapping) return res.status(404).json({ ok:false, error:'no_mapping' });

    const explicit = req.body.sheetName || req.query.sheetName || req.query.date;
    // find recent sheet (today then back up)
    const { sheetName, rows } = await findRecentSheetAndRows(mapping, explicit, parseInt(process.env.SHEETS_LOOKBACK_DAYS || '3', 10));

    // write cache file(s)
    writeCache(loc, sheetName, rows);

    // append last row into ingestion cache (if appendToCache exists)
    try {
      const lastRows = Array.isArray(rows) && rows.length ? rows.slice(-1) : rows;
      await safeAppendToCache(loc, lastRows, { sheetName });
    } catch (e) {
      console.warn('appendToCache warning', e && e.message ? e.message : e);
    }

    // publish to MQTT (force if requested)
    const forceFlag = req.query.force === '1' || req.body && req.body.force === true;
    try { publishLocationData(loc, sheetName, rows, { force: forceFlag }); } catch (e) { console.warn('publish error', e); }

    return res.json({ ok:true, location: loc, sheetName, rows: Array.isArray(rows) ? rows.length : null });
  } catch (err) {
    console.error('sync-cache error', err);
    res.status(500).json({ ok:false, error: err.message || 'server_error' });
  }
});

// debug helper: read raw from sheet (explicit optional)
app.get('/debug/sensors/:locationId/raw', async (req, res) => {
  try {
    const mapping = sheetMappings.find(m => m.locationId === req.params.locationId);
    if (!mapping) return res.status(404).json({ ok:false, error:'no_mapping' });
    const explicit = req.query.sheetName || req.query.date;
    const { sheetName, rows } = await findRecentSheetAndRows(mapping, explicit, parseInt(process.env.SHEETS_LOOKBACK_DAYS || '3', 10));
    res.json({ ok: true, sheetName, sample: (rows && rows[0]) || null, rowCount: Array.isArray(rows) ? rows.length : 0 });
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

// ===== Sensor Data (HTTP) - prefer cache, fallback to sheet via findRecentSheetAndRows
app.get('/sensors/:locationId', async (req, res) => {
  try {
    const loc = req.params.locationId;
    const mapping = sheetMappings.find(m => m.locationId === loc);
    if (!mapping) return res.status(404).json({error:'no_mapping'});

    const explicit = req.query.sheetName || req.query.date;
    const desiredSheet = getSheetName(mapping, explicit);

    // Try to return cache if it already points to desired sheet
    try {
      const locDir = path.join(PUBLIC_DATA_DIR, loc);
      const latestPath = path.join(locDir, 'latest.json');
      if (fs.existsSync(latestPath)) {
        const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
        if (latest && latest.sheetName === desiredSheet) {
          const cached = readCache(loc);
          if (cached) return res.json(cached);
        }
      }
    } catch (e) {
      console.warn('warning checking latest.json for cache validation', e && e.message ? e.message : e);
    }

    // fallback: find recent sheet and read live
    const { sheetName, rows } = await findRecentSheetAndRows(mapping, explicit, parseInt(process.env.SHEETS_LOOKBACK_DAYS || '3', 10));

    // write cache pointing to found sheet
    writeCache(loc, sheetName, rows);

    // publish latest
    try { publishLocationData(loc, sheetName, rows); } catch (e) { console.warn('publish error', e); }

    res.json(rows);
  } catch (err) {
    console.error('/sensors error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ===== AUTO SYNC (optional) =====
if (process.env.AUTO_SYNC === 'true') {
  const interval = parseInt(process.env.AUTO_SYNC_INTERVAL || '30000', 10);
  const lookback = parseInt(process.env.SHEETS_LOOKBACK_DAYS || '3', 10);
  console.log(`Auto-sync enabled: interval ${interval} ms, lookbackDays ${lookback}`);
  async function syncAllLocationsOnce() {
    for (const mapping of sheetMappings) {
      try {
        const { sheetName, rows } = await findRecentSheetAndRows(mapping, null, lookback);
        writeCache(mapping.locationId, sheetName, rows);
        try { publishLocationData(mapping.locationId, sheetName, rows); } catch (e) { console.warn('publish error', e); }
      } catch (err) {
        console.warn('auto-sync error for', mapping.locationId, err && err.message ? err.message : err);
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

    // append to ingest cache (single object payload)
    try {
      // Many appendToCache implementations expect a single object (payload)
      if (appendToCache && appendToCache.length <= 1) {
        await appendToCache({ ...payload, timestamp: new Date().toISOString() });
      } else {
        // else call safe wrapper with location
        await safeAppendToCache(payload.locationId, [{ ...payload, timestamp: new Date().toISOString() }], {});
      }
    } catch (e) {
      console.warn('appendToCache (ingest) failed', e && e.message ? e.message : e);
    }

    // publish ingest message (non-retain)
    try { publishIngest(payload.locationId, payload); } catch (e) { console.warn('ingest publish error', e); }

    // Threshold check
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
