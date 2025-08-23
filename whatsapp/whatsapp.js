// whatsapp.js
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const http = require('http');
const { evaluateLatest } = require('./threshold');
const { DateTime } = require('luxon'); // optional, good for timezone formatting

// Load config
const confPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(confPath)) {
  console.error('config.json not found in whatsapp/ - please create from template.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(confPath,'utf8'));

// resolve paths
const backendRoot = path.resolve(__dirname, '..');
const cacheBase = path.resolve(backendRoot, cfg.cache.basePath || '../public/data');
const notifPath = path.resolve(__dirname, cfg.behavior.notif_json || './notif.json');

// helper: atomic write
async function atomicWriteJson(filePath, obj) {
  const tmp = filePath + '.tmp.' + Date.now();
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fsp.rename(tmp, filePath);
}

// load notif.json (safe)
async function loadNotif() {
  try {
    if (!fs.existsSync(notifPath)) return [];
    const txt = await fsp.readFile(notifPath, 'utf8');
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('Failed load notif.json', e.message);
    return [];
  }
}

// write notif
async function saveNotif(arr) {
  try {
    await atomicWriteJson(notifPath, arr);
  } catch (e) {
    console.error('Failed write notif.json', e.message);
  }
}

// format time
function fmtTime(ts) {
  try {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    // use Asia/Jakarta
    const dt = DateTime.fromJSDate(d).setZone(cfg.timezone || 'Asia/Jakarta');
    return dt.toFormat('dd, HH:mm');
  } catch (e) { return String(ts); }
}

// build message from template
function buildMessage(template, data) {
  return template
    .replace('{location}', data.location || '')
    .replace('{param}', data.param || '')
    .replace('{value}', data.value === undefined ? '' : String(data.value))
    .replace('{time}', data.time || '')
    .replace('{note}', data.note || '');
}

// find latest cache file for location
async function findLatestCacheFile(locationId) {
  // check today then yesterday
  const tryDays = [0,1,2]; // today, yesterday, day before
  for (const d of tryDays) {
    const dt = DateTime.local().setZone(cfg.timezone || 'Asia/Jakarta').minus({ days: d });
    const fname = `data_${dt.toISODate()}.json`;
    const candidate = path.join(cacheBase, locationId, fname);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function loadRowsFromCache(locationId) {
  const file = await findLatestCacheFile(locationId);
  if (!file) return null;
  try {
    const txt = await fsp.readFile(file, 'utf8');
    const rows = JSON.parse(txt);
    return Array.isArray(rows) ? rows : null;
  } catch (e) {
    console.warn('failed parse cache', file, e.message);
    return null;
  }
}

// scan locations from config.groups keys
function getAllLocations() {
  return Object.keys(cfg.groups || {});
}

// determine if event is already recorded in notif.json (by id)
function makeId(locationId, param, level, timestamp) {
  const t = timestamp || '';
  return `${locationId}_${param}_${level}_${t}`;
}

// check resend eligibility
function shouldResend(existingEntry, nowTs) {
  if (!existingEntry) return true;
  const resendMin = (cfg.send && cfg.send.resend_after_minutes) || 30;
  if (!existingEntry.sent) return true;
  if (!existingEntry.sentAt) return true;
  const sentAt = new Date(existingEntry.sentAt).getTime();
  const now = nowTs || Date.now();
  return (now - sentAt) >= (resendMin * 60 * 1000);
}

// create event entries from evaluateLatest results
async function produceEventsForLocation(locationId) {
  const rows = await loadRowsFromCache(locationId);
  if (!rows) return [];
  const events = evaluateLatest(rows, cfg.thresholds || {});
  // attach location/time
  return events.map(ev => Object.assign({}, ev, {
    locationId,
    timeFormatted: fmtTime(ev.timestamp),
  }));
}

// --- Baileys send helper ---
async function sendTextToJid(sock, jid, text) {
  try {
    const res = await sock.sendMessage(jid, { text });
    return { ok: true, res };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// --- Scheduler & main loop ---
let sock = null;
let authStateSaver = null;
async function startWhatsAppWorker() {
  // create auth and socket
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname,'session'));
  authStateSaver = saveCreds;
  sock = makeWASocket({ auth: state, printQRInTerminal: true });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    if (update.qr) qrcode.generate(update.qr, { small: true });
    if (update.connection === 'open') console.log('WhatsApp: connected');
    if (update.connection === 'close') console.warn('WhatsApp: disconnected', update.lastDisconnect);
  });

  // main periodic loop
  const intervalMs = (cfg.send && cfg.send.batch_interval_minutes ? cfg.send.batch_interval_minutes : 5) * 60 * 1000;
  // run immediately then schedule
  await runScanAndSchedule(sock);
  setInterval(() => { runScanAndSchedule(sock).catch(e => console.error('runScan err', e)); }, intervalMs);
}

// scan, build notif.json changes, schedule sends
async function runScanAndSchedule(sockInstance) {
  const locations = getAllLocations();
  if (!locations || locations.length === 0) return;
  let notif = await loadNotif();

  const newEntries = [];

  for (const loc of locations) {
    try {
      const evs = await produceEventsForLocation(loc);
      for (const e of evs) {
        const id = makeId(e.locationId, e.param, e.level, e.timestamp);
        const existing = notif.find(x => x.id === id);
        if (existing) {
          // already exists; skip unless resend allowed by schedule
          if (shouldResend(existing)) {
            // mark for resend by setting sent=false and attempts reset if needed
            existing.sent = false;
            existing.attempts = existing.attempts ? existing.attempts : 0;
            newEntries.push(existing);
          }
          continue;
        }
        // create new entry
        const entry = {
          id,
          locationId: e.locationId,
          param: e.param,
          level: e.level,
          value: e.value,
          timestamp: e.timestamp,
          message: buildMessage(cfg.templates[e.level] || cfg.templates.danger || '{location} {param} {value}', {
            location: e.locationId,
            param: e.param,
            value: e.value,
            time: e.timeFormatted,
            note: e.note || ''
          }),
          sent: false,
          sentAt: null,
          attempts: 0,
          createdAt: (new Date()).toISOString()
        };
        notif.push(entry);
        newEntries.push(entry);
      }
    } catch (e) {
      console.warn('produceEventsForLocation error', loc, e.message);
    }
  }

  if (newEntries.length) {
    await saveNotif(notif);
  }

  // schedule sends per location with random offset
  scheduleSends(sockInstance, notif);
}

// schedule sends: group by location, add random offsets between locations
function scheduleSends(sockInstance, notifArray) {
  // group unsent entries by location
  const unsent = notifArray.filter(n => !n.sent);
  const byLoc = {};
  for (const u of unsent) {
    byLoc[u.locationId] = byLoc[u.locationId] || [];
    byLoc[u.locationId].push(u);
  }
  const locs = Object.keys(byLoc);
  let offsetAcc = 0;
  for (const loc of locs) {
    const locEntries = byLoc[loc];
    // compute random offset for this location
    const maxRand = cfg.send && cfg.send.random_offset_seconds_max ? cfg.send.random_offset_seconds_max : 10;
    const rand = Math.floor(Math.random() * (maxRand + 1));
    offsetAcc += rand;
    // schedule send after offsetAcc seconds
    setTimeout(() => {
      sendBatchForLocation(sockInstance, loc, locEntries).catch(e => console.error('sendBatchForLocation err', e));
    }, offsetAcc * 1000);
  }
}

// send batch for single location
async function sendBatchForLocation(sockInstance, locationId, entries) {
  const groupJid = cfg.groups && cfg.groups[locationId];
  if (!groupJid) {
    console.warn('No groupJid mapping for', locationId);
    return;
  }
  for (const ent of entries) {
    // attempt send with retries
    let attempt = 0;
    const maxAttempts = cfg.send && cfg.send.retry_attempts !== undefined ? cfg.send.retry_attempts : 2;
    let sentOk = false;
    while (attempt <= maxAttempts && !sentOk) {
      attempt++;
      ent.attempts = attempt;
      const res = await sendTextToJid(sockInstance, groupJid, ent.message);
      if (res && res.ok) {
        ent.sent = true;
        ent.sentAt = (new Date()).toISOString();
        sentOk = true;
      } else {
        console.warn('Send failed attempt', attempt, 'for', ent.id, res && res.error);
        // wait retry_interval_seconds before next attempt if not last
        if (attempt <= maxAttempts) {
          const wait = (cfg.send && cfg.send.retry_interval_seconds) || 30;
          await new Promise(r => setTimeout(r, wait * 1000));
        }
      }
    }
    // update notif.json after each entry to record status
    const notifArr = await loadNotif();
    const idx = notifArr.findIndex(x => x.id === ent.id);
    if (idx >= 0) {
      notifArr[idx] = ent;
      await saveNotif(notifArr);
    }
  }
}

// --- Health HTTP server on localhost only ---
function startHealthServer() {
  const port = cfg.behavior && cfg.behavior.health_port ? cfg.behavior.health_port : 9091;
  const bind = cfg.behavior && cfg.behavior.health_bind ? cfg.behavior.health_bind : '127.0.0.1';
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      const notif = await loadNotif().catch(()=>[]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', warnings: notif.filter(n=>n.level==='warning').length, dangers: notif.filter(n=>n.level==='danger').length }));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
  server.listen(port, bind, () => {
    console.log(`Health server listening on http://${bind}:${port}/health`);
  });
}

// --- bootstrap ---
(async () => {
  try {
    startHealthServer();
    await startWhatsAppWorker();
  } catch (e) {
    console.error('Worker failed', e);
    process.exit(1);
  }
})();
