// services/sheets.js
const { google } = require('googleapis');
const path = require('path');

const sheetsCredentialsPath = process.env.SHEETS_CREDENTIALS_PATH || path.join(__dirname, '../serviceAccount.json');
const credentials = require(sheetsCredentialsPath);

const auth = new google.auth.JWT(
  credentials.client_email,
  null,
  credentials.private_key,
  ['https://www.googleapis.com/auth/spreadsheets.readonly']
);

const sheets = google.sheets({ version: 'v4', auth });

// Grup mapping
const SENSOR_GROUPS = {
  meteorologi: ["Wind Direction", "Wind Speed (km/h)", "Temp udara"],
  presipitasi: ["Rainfall (mm)", "Distance (mm)"],
  kualitas_fisika: ["Water Temp (C)", "EC (ms/cm)"],
  kualitas_kimia_dasar: ["TDS (ppm)", "pH"],
  kualitas_kimia_lanjut: ["DO (ug/L)"],
  kualitas_turbiditas: ["TSS (V)"]
};

async function readSheet(sheetId, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: sheetName
  });

  const rows = res.data.values;
  if (!rows || rows.length < 2) return [];

  const headers = rows[0];
  return rows.slice(1).map(row =>
    Object.fromEntries(headers.map((h, i) => [h, row[i] || null]))
  );
}

// Helper untuk parse data + kelompokkan berdasarkan grup
function parseWideRows(rows) {
  return rows.map(row => {
    const grouped = {
      timestamp: row.Timestamp || row.timestamp || null,
      groups: {}
    };

    // Buat grup sesuai mapping
    for (const [groupName, fields] of Object.entries(SENSOR_GROUPS)) {
      grouped.groups[groupName] = {};
      for (const field of fields) {
        let val = row[field] ?? null;
        if (val !== null && !isNaN(Number(val))) {
          val = Number(val);
        }
        grouped.groups[groupName][field] = val;
      }
    }

    return grouped;
  });
}

module.exports = { readSheet, parseWideRows, SENSOR_GROUPS };
