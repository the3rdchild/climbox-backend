// whatsapp.js (improved: QR handling, reconnect/backoff, group mapping)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const qrcode = require('qrcode-terminal');
const { DateTime } = require('luxon');

const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const { evaluateLatest } = require('./threshold');

// --- load config ---
const confPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(confPath)) {
  console.log('Exists?', fs.existsSync(cacheBase));
  console.error('config.json not found in whatsapp/ - please create from template.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(confPath, 'utf8'));

// resolve paths
const backendRoot = path.resolve(__dirname, '..');
// resolve cache base relative to backend root; default 'public/data'
const rawCacheSetting = (cfg.cache && cfg.cache.basePath) ? cfg.cache.basePath : 'public/data';
let cacheBase;
if (path.isAbsolute(rawCacheSetting)) {
  cacheBase = rawCacheSetting;
} else {
  // strip any leading ../ segments (so ../public/data -> public/data relative to backendRoot)
  const stripped = rawCacheSetting.replace(/^(\.\.\/)+/, '');
  cacheBase = path.join(backendRoot, stripped);
}
console.log('cacheBase resolved to', cacheBase);

const notifPath = path.resolve(__dirname, cfg.behavior.notif_json || path.join(__dirname, 'notif.json'));
const groupsJsonPath = path.resolve(__dirname, 'groups.json'); // file produced by get-jids-safe.js

async function ensureNotifFile() {
  try {
    const dir = path.dirname(notifPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(notifPath)) {
      await atomicWriteJson(notifPath, []); // uses your atomicWriteJson helper
      console.log('Created empty notif.json at', notifPath);
    }
  } catch (e) {
    console.error('Could not ensure notif.json exists:', e.message || e);
  }
}
// --- helpers ---
async function atomicWriteJson(filePath, obj) {
  const tmp = filePath + '.tmp.' + Date.now();
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fsp.rename(tmp, filePath);
}

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

async function saveNotif(arr) {
  try {
    await atomicWriteJson(notifPath, arr);
  } catch (e) {
    console.error('Failed write notif.json', e.message);
  }
}

function fmtTime(ts) {
  try {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    const dt = DateTime.fromJSDate(d).setZone(cfg.timezone || 'Asia/Jakarta');
    return dt.toFormat('dd, HH:mm');
  } catch (e) { return String(ts); }
}

function buildMessage(template, data) {
  return (template || '')
    .replace('{location}', data.location || '')
    .replace('{param}', data.param || '')
    .replace('{value}', data.value === undefined ? '' : String(data.value))
    .replace('{time}', data.time || '')
    .replace('{note}', data.note || '');
}

async function findLatestCacheFile(locationId) {
  // candidate folders to try, order matters
  const candidates = [];

  // 1) original as-is
  candidates.push(locationId);

  // 2) normalized: lowercase, spaces->underscore
  candidates.push(String(locationId).toLowerCase().replace(/\s+/g, '_'));

  // 3) normalized: lowercase, remove non-alnum (used earlier)
  const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  candidates.push(normalize(locationId));

  // 4) try folderName from sheets-credentials.json if present
  try {
    const sheets = require('../sheets-credentials.json');
    const entry = (sheets || []).find(x => x.locationId === locationId);
    if (entry && entry.folderName) {
      candidates.push(entry.folderName);
      candidates.push(String(entry.folderName).toLowerCase().replace(/\s+/g, '_'));
      candidates.push(normalize(entry.folderName));
    }
  } catch (e) {
    // ignore sheets read error
  }

  // unique
  const seen = new Set();
  const finalCandidates = candidates.filter(c => {
    if (!c) return false;
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });

  // debug: log attempted folders for visibility
  console.log('findLatestCacheFile candidates for', locationId, finalCandidates);

  // try each candidate folder for the latest data file
  const tryDays = [0,1,2];
  for (const folder of finalCandidates) {
    for (const d of tryDays) {
      const dt = DateTime.local().setZone(cfg.timezone || 'Asia/Jakarta').minus({ days: d });
      const fname = `data_${dt.toISODate()}.json`;
      const candidate = path.join(cacheBase, folder, fname);
      if (fs.existsSync(candidate)) {
        console.log('Found cache file for', locationId, '->', candidate);
        return candidate;
      }
    }
    // also try latest.json in that folder
    const latestJson = path.join(cacheBase, folder, 'latest.json');
    if (fs.existsSync(latestJson)) {
      console.log('Found latest.json for', locationId, '->', latestJson);
      return latestJson;
    }
  }

  // debug: log attempted folders for visibility
  console.log('No cache file found for', locationId, 'tried folders:', finalCandidates);
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

function getAllLocations() {
  // Use sheets-credentials.json as the canonical list of locations (safer)
  try {
    const sheetsMap = require('../sheets-credentials.json'); // array
    return sheetsMap.map(m => m.locationId);
  } catch (e) {
    // fallback to cfg.groups keys if sheets not available
    return Object.keys(cfg.groups || {});
  }
}


function makeId(locationId, param, level, timestamp) {
  const t = timestamp || '';
  return `${locationId}_${param}_${level}_${t}`;
}

function shouldResend(existingEntry, nowTs) {
  if (!existingEntry) return true;
  const resendMin = (cfg.send && cfg.send.resend_after_minutes) || 30;
  if (!existingEntry.sent) return true;
  if (!existingEntry.sentAt) return true;
  const sentAt = new Date(existingEntry.sentAt).getTime();
  const now = nowTs || Date.now();
  return (now - sentAt) >= (resendMin * 60 * 1000);
}

async function produceEventsForLocation(locationId) {
  const rows = await loadRowsFromCache(locationId);
  if (!rows) return [];
  const events = evaluateLatest(rows, cfg.thresholds || {});
  return events.map(ev => Object.assign({}, ev, {
    locationId,
    timeFormatted: fmtTime(ev.timestamp),
  }));
}

// --- group mapping loader: combine config.groups + groups.json (if available) ---
function loadGroupsJson() {
  try {
    if (!fs.existsSync(groupsJsonPath)) return {};
    const raw = fs.readFileSync(groupsJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed || {};
  } catch (e) {
    console.warn('Failed to read groups.json', e.message);
    return {};
  }
}

function getGroupJid(locationId, groupsJson) {
  // helper normalizer
  const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  // 1) exact config match
  if (cfg.groups && cfg.groups[locationId]) return cfg.groups[locationId];

  // 2) normalized config match
  if (cfg.groups) {
    for (const [k, v] of Object.entries(cfg.groups)) {
      if (normalize(k) === normalize(locationId)) return v;
    }
  }

  // 3) try groups.json direct key or normalized
  if (groupsJson && typeof groupsJson === 'object') {
    // direct key
    if (groupsJson[locationId]) return groupsJson[locationId];

    // normalized subject match (key might be subject name)
    for (const [k, v] of Object.entries(groupsJson)) {
      if (normalize(k) === normalize(locationId)) return v;
      if (normalize(k).includes(normalize(locationId)) || normalize(locationId).includes(normalize(k))) return v;
    }
  }

  // 4) try matching by folder name variants (same normalization used for cache)
  const possibleFolderNames = [
    locationId,
    String(locationId).toLowerCase().replace(/\s+/g, '_'),
    String(locationId).toLowerCase().replace(/[^a-z0-9]+/g, '')
  ];
  // if sheets has folderName property, try it
  try {
    const sheets = require('../sheets-credentials.json');
    const entry = (sheets || []).find(x => x.locationId === locationId);
    if (entry && entry.folderName) {
      possibleFolderNames.push(entry.folderName);
      possibleFolderNames.push(String(entry.folderName).toLowerCase().replace(/\s+/g, '_'));
      possibleFolderNames.push(String(entry.folderName).toLowerCase().replace(/[^a-z0-9]+/g, ''));
    }
  } catch (e) {}

  for (const cand of possibleFolderNames) {
    // check if config has key equal to cand
    if (cfg.groups && cfg.groups[cand]) return cfg.groups[cand];
    // check normalized config keys again
    if (cfg.groups) {
      for (const [k, v] of Object.entries(cfg.groups)) {
        if (normalize(k) === normalize(cand)) return v;
      }
    }
  }

  // not found
  return null;
}


// --- Baileys helpers & robust connect/reconnect ---
let sock = null;
let authStateSave = null;
let connected = false;
const qrFlagPath = path.join(__dirname, 'session', 'qr_printed');
let _qrPrintedOnce = false;
try { _qrPrintedOnce = fs.existsSync(qrFlagPath); } catch (e) { _qrPrintedOnce = false; }
let _authenticated = false;
const QR_PRINT_THROTTLE_SECONDS = (cfg.behavior && cfg.behavior.qr_print_throttle_seconds) || 60;
let _lastQr = null;
let _lastQrPrintedAt = 0;

async function createSocketAndStart() {
  // fetch latest baileys version
  let versionInfo = {};
  try {
    versionInfo = await fetchLatestBaileysVersion();
    console.log('Baileys web version:', versionInfo.version, 'isLatest?', versionInfo.isLatest);
  } catch (e) {
    console.warn('fetchLatestBaileysVersion failed, using defaults', e?.message || e);
  }

  // use multi-file auth state
  const sessionDir = path.join(__dirname, 'session');
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  authStateSave = saveCreds;

  // create socket
  sock = makeWASocket({
    auth: state,
    version: versionInfo.version,
    printQRInTerminal: false, // we handle QR event ourselves
    browser: ['climbox-whatsapp-worker','Chrome','1.0.0'],
    // defaultQueryTimeoutMs: undefined
  });

  sock.ev.on('creds.update', saveCreds);

// inside createSocketAndStart() after sock.ev.on('creds.update', saveCreds);
sock.ev.on('connection.update', async (update) => {
  try {
    // QR handling (throttle + persist-once)
    if (update.qr) {
      const now = Date.now();
      const sameQr = (_lastQr && update.qr === _lastQr);
      const elapsed = now - (_lastQrPrintedAt || 0);

      if (!_authenticated && !_qrPrintedOnce && (!sameQr || elapsed >= QR_PRINT_THROTTLE_SECONDS * 1000)) {
        console.log('=== QR CODE (scan with sender account) ===');
        qrcode.generate(update.qr, { small: true });

        // persist marker (so we never spam again)
        try {
          const sessDir = path.dirname(qrFlagPath);
          if (!fs.existsSync(sessDir)) fs.mkdirSync(sessDir, { recursive: true });
          fs.writeFileSync(qrFlagPath, new Date().toISOString(), 'utf8');
          _qrPrintedOnce = true;
        } catch (e) {
          console.warn('Could not write qr flag file:', e.message || e);
          _qrPrintedOnce = true;
        }

        _lastQr = update.qr;
        _lastQrPrintedAt = now;
      } else {
        if (_qrPrintedOnce) console.log('QR suppressed: previously printed for this installation.');
        else console.log('QR suppressed (throttled).');
      }
    }

    // connection opened -> mark authenticated + connected
    if (update.connection === 'open') {
      _authenticated = true;
      connected = true;            // <-- IMPORTANT: set connected here
      _lastQr = null;
      _lastQrPrintedAt = 0;
      console.log('WhatsApp: connected (open)');

      // fetch groups and save
      try {
        const groups = await sock.groupFetchAllParticipating();
        const byName = {};
        for (const [jid, meta] of Object.entries(groups || {})) {
          const name = meta?.subject || jid;
          byName[name] = jid;
        }
        await atomicWriteJson(groupsJsonPath, byName);
        console.log('Saved groups.json with', Object.keys(byName).length, 'groups');
      } catch (e) {
        console.warn('groupFetchAllParticipating failed (ok to ignore if private account):', e?.message || e);
      }
    }

    // connection closed -> mark unauthenticated + not connected
    if (update.connection === 'close') {
      _authenticated = false;
      connected = false;           // <-- IMPORTANT: clear connected here
      console.warn('WhatsApp: disconnected', update.lastDisconnect || update);
      // keep qr_printed marker — do not clear, to avoid QR spam
    }
  } catch (e) {
    console.error('connection.update handler error', e);
  }
});

  sock.ev.on('connection.error', (err) => {
    console.error('connection.error event', err);
  });

  // optional: log messages that arrive (you can disable in prod)
  sock.ev.on('messages.upsert', async (m) => {
    // keep small: only print if group message arrives
    try {
      const messages = m.messages || (m && m.messages ? m.messages : []);
      for (const msg of messages) {
        const from = msg.key?.remoteJid;
        if (!from) continue;
        if (from.endsWith && from.endsWith('@g.us')) {
          console.log('Group message from', from, '=>', (msg.message && msg.message.conversation) || msg.pushName || '(no text)');
        }
      }
    } catch (e) { /* ignore */ }
  });

  return sock;
}

let creatingSocket = false;

async function ensureConnectedSocket() {
  let tries = 0;
  const maxTries = 30;
  while (true) {
    try {
      // if socket exists and is connected (flag), return it
      if (sock && connected) return sock;

      // if a create is already in-flight, wait and loop
      if (creatingSocket) {
        await new Promise(r => setTimeout(r, 1000));
        tries++;
        if (tries >= maxTries) throw new Error('Timeout waiting for socket creation');
        continue;
      }

      creatingSocket = true;
      console.log('Creating WA socket (attempt', tries+1, ')');
      try {
        sock = await createSocketAndStart();
      } finally {
        creatingSocket = false;
      }

      // wait a little for connection.update to set `connected`
      let waitMs = 0;
      while (waitMs < 5000) { // wait up to ~5s for open
        if (connected && sock) return sock;
        await new Promise(r => setTimeout(r, 500));
        waitMs += 500;
      }

      // if not connected after wait, continue loop (backoff)
    } catch (e) {
      console.warn('createSocketAndStart error', e?.message || e);
    }

    tries++;
    const wait = Math.min(30000, 1000 * Math.pow(2, Math.min(10, tries))); // progressive backoff to max 30s
    console.log(`Will retry create socket in ${Math.round(wait/1000)}s`);
    await new Promise(r => setTimeout(r, wait));
    if (tries >= maxTries) {
      console.error('Max socket creation attempts reached');
      throw new Error('Max socket creation attempts reached');
    }
  }
}


// send text to jid helper
async function sendTextToJid(currSock, jid, text) {
  try {
    const res = await currSock.sendMessage(jid, { text });
    return { ok: true, res };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// --- main logic: scanning and scheduling (unchanged core) ---
async function runScanAndSchedule(currSock) {
  const allLocations = getAllLocations();
  if (!allLocations || allLocations.length === 0) return;
  let notif = await loadNotif();
  const newEntries = [];

  // load fallback groups.json
  const groupsFromJson = loadGroupsJson();

  for (const loc of allLocations) {
    try {
      console.log('Checking location:', loc);
      const evs = await produceEventsForLocation(loc);
      for (const e of evs) {
        const id = makeId(e.locationId, e.param, e.level, e.timestamp);
        const existing = notif.find(x => x.id === id);
        if (existing) {
          if (shouldResend(existing)) {
            existing.sent = false;
            existing.attempts = existing.attempts || 0;
            newEntries.push(existing);
          }
          continue;
        }
        const template = cfg.templates && cfg.templates[e.level] ? cfg.templates[e.level] : (cfg.templates && cfg.templates.danger) || '{location} {param} {value}';
        const entry = {
          id,
          locationId: e.locationId,
          param: e.param,
          level: e.level,
          value: e.value,
          timestamp: e.timestamp,
          message: buildMessage(template, {
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
      console.warn('produceEventsForLocation error', loc, e?.message || e);
    }
  }

  if (newEntries.length) {
    await saveNotif(notif);
  }

  scheduleSends(currSock, notif, groupsFromJson);
}

function scheduleSends(sockInstance, notifArray, groupsFromJson) {
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
    const maxRand = (cfg.send && cfg.send.random_offset_seconds_max) || 10;
    const rand = Math.floor(Math.random() * (maxRand + 1));
    offsetAcc += rand;
    setTimeout(() => {
      sendBatchForLocation(sockInstance, loc, locEntries, groupsFromJson).catch(e => console.error('sendBatchForLocation err', e));
    }, offsetAcc * 1000);
  }
}

async function sendBatchForLocation(sockInstance, locationId, entries, groupsFromJson) {
  // resolve groupJid from config or groups.json
  const groupJid = getGroupJid(locationId, groupsFromJson);
  if (!groupJid) {
    console.warn('No groupJid mapping for', locationId);
    console.log('Resolving group jid for', locationId);
console.log('cfg.groups keys:', Object.keys(cfg.groups || {}));
console.log('groupsFromJson keys:', Object.keys(groupsFromJson || {}));

    return;
  }

  for (const ent of entries) {
    let attempt = 0;
    const maxAttempts = (cfg.send && cfg.send.retry_attempts !== undefined) ? cfg.send.retry_attempts : 2;
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
        if (attempt <= maxAttempts) {
          const wait = (cfg.send && cfg.send.retry_interval_seconds) || 30;
          await new Promise(r => setTimeout(r, wait * 1000));
        }
      }
    }
    const notifArr = await loadNotif();
    const idx = notifArr.findIndex(x => x.id === ent.id);
    if (idx >= 0) {
      notifArr[idx] = ent;
      await saveNotif(notifArr);
    }
  }
}

// --- health server (localhost only) ---
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

// helper normalize string for fuzzy compare
function normalizeName(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}

async function produceGroupCandidates() {
  try {
    // load groups.json (jid -> meta subject keys handled earlier as byName{name: jid})
    const groups = loadGroupsJson(); // returns object { 'Group Subject': 'jid@g.us', ... }
    const byName = {};
    for (const [name, jid] of Object.entries(groups || {})) {
      byName[normalizeName(name)] = { name, jid };
    }

    // load locations from sheets-credentials.json
    const sheetsMap = require('../sheets-credentials.json'); // array
    const candidates = {};
    for (const map of sheetsMap) {
      const loc = map.locationId;
      const normLoc = normalizeName(loc);
      candidates[loc] = { found: false, matches: [] };

      // exact normalized match
      if (byName[normLoc]) {
        candidates[loc].found = true;
        candidates[loc].matches.push(byName[normLoc]);
        // (optional) auto assign into cfg.groups in-memory
        // cfg.groups = cfg.groups || {};
        // cfg.groups[loc] = byName[normLoc].jid;
      } else {
        // try includes / partial match
        for (const [k, v] of Object.entries(byName)) {
          if (k.includes(normLoc) || normLoc.includes(k)) {
            candidates[loc].matches.push(v);
          }
        }
      }
    }

    // write candidates to file for manual review
    const candPath = path.resolve(__dirname, 'groups-candidates.json');
    await atomicWriteJson(candPath, candidates);
    console.log('Wrote group candidates to', candPath);
    return candidates;
  } catch (e) {
    console.warn('produceGroupCandidates failed', e?.message || e);
    return {};
  }
}


// --- bootstrap: ensure socket + periodic scan loop ---
(async () => {
  try {
    startHealthServer();
    // ensure connection available
    await ensureNotifFile();
    const sockInstance = await ensureConnectedSocket();

    // run initial scan immediately
    await runScanAndSchedule(sockInstance);

    // schedule periodic scanning using config interval
    const intervalMs = (cfg.send && cfg.send.batch_interval_minutes ? cfg.send.batch_interval_minutes : 5) * 60 * 1000;
    setInterval(async () => {
      try {
        const s = await ensureConnectedSocket();
        await runScanAndSchedule(s);
      } catch (e) {
        console.error('Periodic runScan error', e?.message || e);
      }
    }, intervalMs);
  } catch (e) {
    console.error('Worker bootstrap failed', e);
    process.exit(1);
  }
})();
