// index.js
require('dotenv').config();
const express = require('express');
const { loadNotifs } = require('./services/threshold');
const path = require('path');
const app = express();
app.use(express.json());

// serve static cached data
app.use('/data', express.static(path.join(__dirname, 'public', 'data')));

// sensors: read cached daily files and filter (simple implementation)
app.get('/sensors/:locationId', (req,res) => {
  const loc = req.params.locationId;
  // naive: read last 7 days files and aggregate — implement as needed
  const dataDir = path.join(__dirname,'public','data');
  // ... implement reading files matching prefix sensorData_*.json and filter by location
  res.json({ ok: false, message: 'implement reading cache' });
});

// get notifications
app.get('/notifications', (req,res) => {
  res.json(loadNotifs());
});

// trigger manual sync (protect with API_KEY)
app.post('/sync-sheets', (req,res) => {
  if (req.headers['x-api-key'] !== process.env.API_KEY) return res.status(403).json({ error:'no' });
  // spawn or run sync-sheets.js logic (or require and call)
  require('./sync-sheets'); // simple
  res.json({ ok: true });
});

app.get('/health', (req,res) => res.send('ok'));

const PORT = process.env.PORT || 4000;
app.listen(PORT, ()=> console.log('listening', PORT));
