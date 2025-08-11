// sync-sheets.js
require('dotenv').config();
const { readSheet, parseWideRows } = require('./services/sheets');
const { appendDaily } = require('./services/cacheWriter');
const { pushNotification } = require('./services/threshold');

const SPREAD_MAP = JSON.parse(process.env.SHEETS_SPREADSHEET_MAP || '{}');
const DEFAULT_THRESHOLDS = JSON.parse(process.env.DEFAULT_THRESHOLDS || '{"sst":30}');

async function syncOne(locationId) {
  const sid = SPREAD_MAP[locationId];
  if (!sid) { console.error('no sheet id for', locationId); return; }
  const rows = await readSheet(sid, 'Sheet1'); // adjust sheet name if needed
  const data = parseWideRows(rows);
  for (const row of data) {
    // ensure timestamp exists and is parseable
    let ts = row.timestamp_iso || row.timestamp || row.time;
    if (!ts) continue;
    const iso = new Date(ts).toISOString();
    // create per-sensor entries from fixed columns
    // example for sst column:
    const sstVal = Number(row.sst);
    const entry = { locationId, timestamp: iso, sst: sstVal };
    appendDaily(entry);
    if (sstVal && sstVal > (DEFAULT_THRESHOLDS.sst || 30)) {
      pushNotification({ locationId, sensorId: `${locationId}_sst`, sensorType: 'sst', value: sstVal, timestamp: iso });
    }
    // repeat for other sensors...
  }
  console.log('synced', locationId, data.length, 'rows');
}

async function syncAll() {
  for (const loc of Object.keys(SPREAD_MAP)) {
    await syncOne(loc);
  }
  console.log('all done');
}
syncAll().catch(console.error);
