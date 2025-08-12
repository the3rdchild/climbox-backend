// services/sheets.js
const { google } = require('googleapis');
const fs = require('fs');
require('dotenv').config();

// Load Google Sheets API credentials
const sheetsCredentials = JSON.parse(
  fs.readFileSync('./sheets-credentials.json', 'utf-8')
);

const auth = new google.auth.JWT(
  sheetsCredentials.client_email,
  null,
  sheetsCredentials.private_key,
  ['https://www.googleapis.com/auth/spreadsheets']
);

const sheets = google.sheets({ version: 'v4', auth });

async function readSheet(sheetId, sheetName, range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!${range}`,
  });
  return res.data.values;
}

module.exports = { readSheet };
