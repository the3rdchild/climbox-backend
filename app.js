// app.js
const express = require('express');
const cors = require('cors');
const { readSheet, parseWideRows } = require('./services/sheets');

const app = express();
app.use(cors()); // biar frontend bisa akses (CORS enable)

// endpoint baca dari Google Sheet
app.get('/api/sensors', async (req, res) => {
  try {
    const sheetId = '1ArdjxcfEmBIaUZGj8EMvDi7wrbHpmXUdLNFmtYOWiu8';
    const sheetName = 'Sheet1';
    const rows = await readSheet(sheetId, sheetName);
    const parsed = parseWideRows(rows);
    res.json({ success: true, data: parsed });
  } catch (err) {
    console.error('Error fetch sheet:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// run server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
