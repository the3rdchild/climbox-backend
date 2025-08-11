// services/sheets.js
const { google } = require('googleapis');
const path = require('path');

const CRED_PATH = path.join(__dirname, '../sheets-credentials.json');

function authClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CRED_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  return auth;
}

// read full sheet (sheetName or range)
async function readSheet(spreadsheetId, range) {
  const auth = authClient();
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

// helper to parse wide-format rows into objects
function parseWideRows(rows) {
  if (!rows || rows.length < 2) return [];
  const header = rows[0].map(h => h.trim());
  const data = rows.slice(1).map(r => {
    const obj = {};
    for (let i = 0; i < header.length; i++) {
      obj[header[i]] = r[i] !== undefined ? r[i] : null;
    }
    return obj;
  });
  return data;
}

module.exports = { readSheet, parseWideRows };
