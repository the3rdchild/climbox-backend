// send-test-local.js
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const notifPath = path.resolve(__dirname, cfg.behavior.notif_json || './notif.json');

function makeId(locationId, param, level, timestamp) {
  return `${locationId}_${param}_${level}_${timestamp}`;
}

function nowISO() { return new Date().toISOString(); }

async function injectSample(locationId='pulau_komodo', param='water_temp', value=33.5, level='danger') {
  const t = nowISO();
  const id = makeId(locationId, param, level, t);
  const msg = (cfg.templates && cfg.templates[level]) ? cfg.templates[level] : `${level} - {location} {param} {value}`;
  const message = msg.replace('{location}', locationId).replace('{param}', param).replace('{value}', String(value)).replace('{time}', DateTime.fromISO(t).setZone(cfg.timezone).toFormat('dd, HH:mm'));
  let arr = [];
  if (fs.existsSync(notifPath)) {
    try { arr = JSON.parse(fs.readFileSync(notifPath,'utf8')) || []; } catch(e){ arr = []; }
  }
  arr.push({
    id,
    locationId,
    param,
    level,
    value,
    timestamp: t,
    message,
    sent: false,
    sentAt: null,
    attempts: 0,
    createdAt: t
  });
  fs.writeFileSync(notifPath, JSON.stringify(arr, null, 2), 'utf8');
  console.log('Injected sample alert to', notifPath);
}

const loc = process.argv[2] || 'pulau_komodo';
injectSample(loc, process.argv[3] || 'water_temp', Number(process.argv[4] || 33.5), process.argv[5] || 'danger')
  .catch(e => console.error(e));
