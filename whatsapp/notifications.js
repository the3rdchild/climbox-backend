// routes/notifications.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const { checkAndNotify } = require('./threshold');

const NOTIF_PATH = path.resolve(__dirname, '..', 'whatsapp', 'notif.json');

// trigger check for all mapped sheets
const SHEETS = require('../sheets-credentials.json');

router.post('/run/:locationId', async (req, res) => {
  const loc = req.params.locationId;
  try {
    const out = await checkAndNotify(loc);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const raw = await fs.readFile(NOTIF_PATH, 'utf8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.json([]);
  }
});

router.post('/run-all', async (req, res) => {
  const results = {};
  for (const map of SHEETS) {
    try {
      results[map.locationId] = await checkAndNotify(map.locationId);
    } catch (e) {
      results[map.locationId] = { error: e.message };
    }
  }
  res.json(results);
});

module.exports = router;
