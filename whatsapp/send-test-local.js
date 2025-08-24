// whatsapp/send-test-local.js (fixed)
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

const cfgPath = path.join(__dirname, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const notifPath = path.resolve(__dirname, cfg.behavior.notif_json || './notif.json');

function nowISO() { return new Date().toISOString(); }
function sanitizeIdPart(s) { return String(s || '').trim().replace(/\s+/g, '_'); }
function fmtTimeISOToDisplay(iso) {
  try {
    return DateTime.fromISO(iso).setZone(cfg.timezone || 'Asia/Jakarta').toFormat('dd, HH:mm');
  } catch (e) { return iso; }
}

function buildMessageFromTemplate(level, data) {
  const tmpl = (cfg.templates && cfg.templates[String(level).toLowerCase()]) || '{location} {param} {value}';
  return (tmpl || '')
    .replace('{location}', data.location || '')
    .replace('{param}', data.param || '')
    .replace('{value}', data.value === undefined ? '' : String(data.value))
    .replace('{time}', data.time || '')
    .replace('{note}', data.note || '');
}

async function injectSampleFromArgs() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length < 3) {
    console.error('Usage: node send-test-local.js <location (can be multiword)> <param> <value> <level>');
    console.error('Examples:');
    console.error('  node send-test-local.js "Pulau Komodo" water_temp 35 danger');
    console.error('  node send-test-local.js Pulau_Komodo water_temp 35 danger');
    process.exit(1);
  }

  // Last 3 args are param, value, level. The rest (0..n-4) belong to location.
  const param = rawArgs[rawArgs.length - 3];
  const valueRaw = rawArgs[rawArgs.length - 2];
  const levelRaw = rawArgs[rawArgs.length - 1];

  const locationParts = rawArgs.slice(0, rawArgs.length - 3);
  const location = locationParts.join(' ').trim();

  // normalize types
  const parsedValue = Number(String(valueRaw).replace(',', '.'));
  const value = Number.isFinite(parsedValue) ? parsedValue : valueRaw;
  const level = String(levelRaw).toLowerCase();

  const t = nowISO();
  const id = `${sanitizeIdPart(location)}_${sanitizeIdPart(param)}_${sanitizeIdPart(String(value))}_${t}`;

  const data = {
    location,
    param,
    value: (typeof value === 'number') ? Number(value.toFixed(1)) : value,
    time: fmtTimeISOToDisplay(t),
    note: ''
  };

  const message = buildMessageFromTemplate(level, data);

  let arr = [];
  if (fs.existsSync(notifPath)) {
    try { arr = JSON.parse(fs.readFileSync(notifPath, 'utf8')) || []; } catch (e) { arr = []; }
  }

  const entry = {
    id,
    locationId: location,
    param,
    level,
    value: data.value,
    timestamp: t,
    message,
    sent: false,
    sentAt: null,
    attempts: 0,
    createdAt: t
  };

  arr.push(entry);
  fs.writeFileSync(notifPath, JSON.stringify(arr, null, 2), 'utf8');
  console.log('Injected sample alert to', notifPath);
  console.log('Entry:', entry);
}

injectSampleFromArgs().catch(e => { console.error('inject error', e); process.exit(2); });
