// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

// Services
const { readSheet } = require('./services/sheets');
const { getUser, setUser, db } = require('./services/firestore');
const { appendToCache } = require('./services/cacheWriter');
const { exceedsThreshold } = require('./services/threshold');

// Load sheet mapping from .env or JSON
const sheetMappings = require('./serviceAccount.json');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===== Health Check =====
app.get('/', (req, res) => {
  res.send('ClimBox backend running (Hybrid: Firestore + Google Sheets)');
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
// Example: /sensors/pulau_komodo
app.get('/sensors/:locationId', async (req, res) => {
  try {
    const mapping = sheetMappings.find(m => m.locationId === req.params.locationId);
    if (!mapping) return res.status(404).json({ error: 'No mapping found' });

    const rows = await readSheet(mapping.sheetId, mapping.sheetName, 'A:Z');
    const [header, ...data] = rows;

    const jsonData = data.map(row =>
      header.reduce((obj, key, i) => {
        obj[key] = row[i] ?? null;
        return obj;
      }, {})
    );

    res.json(jsonData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

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
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend listening on http://localhost:${PORT}`));
