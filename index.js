// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

// Services
const { readSheet } = require('./services/sheets');
const { getUser, setUser, db } = require('./services/firestore');
const { appendToCache } = require('./services/cacheWriter'); // existing
const { exceedsThreshold } = require('./services/threshold');

// ADD THESE LINES:
const { writeCache, readCache } = require('./services/cacheWriter');

// Load sheet mapping from .env or JSON
const sheetMappings = require('./sheets-credentials.json');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===== Health Check =====
app.get('/', (req, res) => {
  res.send('ClimBox backend running (Hybrid: Firestore + Google Sheets)');
});

// Helper: normalize rows (if readSheet returns array-of-arrays)
function arraysToObjects(rows) {
  // rows: [headerArray, ...rowsArray]
  if (!Array.isArray(rows) || rows.length === 0) return [];
  if (Array.isArray(rows[0])) {
    const header = rows[0];
    return rows.slice(1).map(r => header.reduce((o, k, i) => { o[k] = r[i] ?? null; return o; }, {}));
  }
  // already objects
  return rows;
}

// POST sync-cache (force read Sheet -> write cache)
// You may want to protect this endpoint with an API key in production.
app.post('/sync-cache/:locationId', async (req, res) => {
  try {
    const loc = req.params.locationId;
    const mapping = sheetMappings.find(m => m.locationId === loc);
    if (!mapping) return res.status(404).json({ ok:false, error:'no_mapping' });

    // allow overriding sheetName via body or query (useful because you said sheetName changes daily)
    const sheetName = req.body.sheetName || req.query.sheetName || mapping.sheetName;

    const rawRows = await readSheet(mapping.sheetId, sheetName, 'A:Z');
    const rows = arraysToObjects(rawRows);

    // write cache: folder per location, file per sheetName
    writeCache(loc, sheetName, rows);

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
// Optional: prefer cache for /sensors (dashboard older code)
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
    res.json(rows);
  } catch (err) {
    console.error('/sensors error', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ===== AUTO SYNC (optional) =====
// Control via .env:
// AUTO_SYNC=true
// AUTO_SYNC_INTERVAL=3000   <-- milliseconds (you asked 3s; configure accordingly)
// WARNING: short intervals may hit Google Sheets quota. Use only for demo.
if (process.env.AUTO_SYNC === 'true') {
  const interval = parseInt(process.env.AUTO_SYNC_INTERVAL || '3000', 10);
  console.log(`Auto-sync enabled: interval ${interval} ms`);
  // build a small sync function
  async function syncAllLocationsOnce() {
    for (const mapping of sheetMappings) {
      try {
        const sheetName = mapping.sheetName; // mapping may be updated dynamically
        const raw = await readSheet(mapping.sheetId, sheetName, 'A:Z');
        const rows = arraysToObjects(raw);
        writeCache(mapping.locationId, sheetName, rows);
        // console.log per mapping
      } catch (err) {
        console.warn('auto-sync error for', mapping.locationId, err.message || err);
      }
    }
  }
  // run immediately and then setInterval
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
