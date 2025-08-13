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

// Helper for "wide" sensor rows
function parseWideRows(rows) {
  return rows.map(row => {
    const parsed = {};
    for (const key in row) {
      const val = row[key];
      parsed[key.trim()] = isNaN(Number(val)) ? val : Number(val);
    }
    return parsed;
  });
}

module.exports = { readSheet, parseWideRows };
