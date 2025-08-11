// services/cacheWriter.js
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../public/data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function atomicWrite(filePath, json) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendDaily(dataObj) {
  const dateStr = (new Date(dataObj.timestamp)).toISOString().split('T')[0];
  const f = path.join(DATA_DIR, `sensorData_${dateStr}.json`);
  let arr = [];
  if (fs.existsSync(f)) {
    try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e){ arr = []; }
  }
  arr.push(dataObj);
  atomicWrite(f, arr);
}

module.exports = { appendDaily };
