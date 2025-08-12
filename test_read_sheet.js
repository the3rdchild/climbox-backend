// test_read_sheet.js
const { google } = require("googleapis");
const fs = require("fs");

// Load credentials and mapping
const creds = require("./serviceAccount.json");
const sheetConfigs = require("./sheets-credentials.json");

async function readSheet(sheetId, sheetName) {
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  );

  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: sheetName
  });

  const rows = res.data.values;
  if (!rows || rows.length === 0) {
    console.log("No data found.");
    return;
  }

  // First row is header
  const header = rows[0];
  const dataRows = rows.slice(1);

  const parsed = dataRows.map(row => {
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = row[idx] || null;
    });
    return obj;
  });

  console.log(parsed);
}

(async () => {
  const cfg = sheetConfigs[0]; // First sheet in mapping
  await readSheet(cfg.sheetId, cfg.sheetName);
})();
