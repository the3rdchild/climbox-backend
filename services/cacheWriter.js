// services/cacheWriter.js
const fs = require('fs');
const path = require('path');

const PUBLIC_DATA_DIR = path.join(__dirname, '..', 'public', 'data');
const DEFAULT_RETENTION_DAYS = parseInt(process.env.CACHE_RETENTION_DAYS || '31', 10);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Append rows (array or single object) to per-location daily file.
 * - locationId: string
 * - rows: array-of-objects OR single object
 *
 * We store per-day ingestion in: public/data/<locationId>/sensorData_YYYY-MM-DD.json
 * and also update <locationId>/<sheetName>.json (if provided separately by caller).
 * Also write latest.json meta with sheetName & updatedAt.
 */
function appendToCache(locationId, rows, opts = {}) {
  try {
    if (!locationId) throw new Error('missing locationId');
    const locDir = path.join(PUBLIC_DATA_DIR, locationId);
    ensureDir(locDir);

    const dateStr = (opts.date || new Date().toISOString().slice(0,10)); // YYYY-MM-DD
    const dailyFile = path.join(locDir, `sensorData_${dateStr}.json`);

    // normalize rows to array
    const arr = Array.isArray(rows) ? rows : [rows];

    // load existing or []
    let fileData = [];
    if (fs.existsSync(dailyFile)) {
      try {
        const raw = fs.readFileSync(dailyFile, 'utf8');
        fileData = JSON.parse(raw) || [];
      } catch (e) {
        console.warn('appendToCache: parse error, recreating daily file', dailyFile, e.message);
        fileData = [];
      }
    }

    // append each row with a cachedAt
    for (const r of arr) {
      fileData.push(Object.assign({}, r, { cachedAt: new Date().toISOString() }));
    }

    fs.writeFileSync(dailyFile, JSON.stringify(fileData, null, 2), 'utf8');

    // also update latest.json meta (sheetName optional)
    const latestMeta = {
      sheetName: opts.sheetName || `sensorData_${dateStr}`,
      updatedAt: new Date().toISOString(),
      rowCount: fileData.length
    };
    fs.writeFileSync(path.join(locDir, 'latest.json'), JSON.stringify(latestMeta, null, 2), 'utf8');

    // retention cleanup
    try {
      cleanupOldFiles(locDir, DEFAULT_RETENTION_DAYS);
    } catch (e) {
      console.warn('appendToCache: retention cleanup failed', e.message);
    }

    return { ok: true, dailyFile, latestMeta };
  } catch (err) {
    console.error('appendToCache error', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Write full sheet cache JSON to <locDir>/<sheetName>.json
 * (used by sync-cache when reading whole sheet)
 */
function writeCache(locationId, sheetName, rows) {
  if (!locationId) throw new Error('missing locationId');
  const locDir = path.join(PUBLIC_DATA_DIR, locationId);
  ensureDir(locDir);
  const fileName = `${sheetName || 'data'}.json`;
  const filePath = path.join(locDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(rows || [], null, 2), 'utf8');

  // update latest.json meta
  const latestMeta = {
    sheetName: sheetName || 'data',
    updatedAt: new Date().toISOString(),
    rowCount: Array.isArray(rows) ? rows.length : null
  };
  fs.writeFileSync(path.join(locDir, 'latest.json'), JSON.stringify(latestMeta, null, 2), 'utf8');

  // retention not applied here (sheet files are per-day by name if chosen)
  return { ok: true, filePath, latestMeta };
}

/**
 * Read cache:
 * - if sheetName provided, return that file
 * - else try latest.json -> file with that sheetName
 * - else find newest *.json in dir (exclude latest.json) and return it
 */
function readCache(locationId, sheetName) {
  try {
    const locDir = path.join(PUBLIC_DATA_DIR, locationId);
    if (!fs.existsSync(locDir)) return null;

    if (sheetName) {
      const filePath = path.join(locDir, `${sheetName}.json`);
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    const latestPath = path.join(locDir, 'latest.json');
    if (fs.existsSync(latestPath)) {
      const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
      const target = path.join(locDir, `${latest.sheetName}.json`);
      if (fs.existsSync(target)) return JSON.parse(fs.readFileSync(target, 'utf8'));
    }

    // fallback: take newest data file by mtime (excluding latest.json)
    const files = fs.readdirSync(locDir).filter(f => f.endsWith('.json') && f !== 'latest.json');
    if (files.length === 0) return null;
    const candidate = files
      .map(f => ({ f, mtime: fs.statSync(path.join(locDir, f)).mtimeMs }))
      .sort((a,b) => b.mtime - a.mtime)[0].f;
    return JSON.parse(fs.readFileSync(path.join(locDir, candidate), 'utf8'));
  } catch (err) {
    console.error('readCache error', err);
    return null;
  }
}

/** delete files older than retentionDays in given dir (only per-location files) */
function cleanupOldFiles(locDir, retentionDays = DEFAULT_RETENTION_DAYS) {
  try {
    if (!fs.existsSync(locDir)) return;
    const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const files = fs.readdirSync(locDir).filter(f => f.endsWith('.json') && f !== 'latest.json');
    for (const f of files) {
      const full = path.join(locDir, f);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        console.log('Removed old cache file', full);
      }
    }
  } catch (e) {
    console.warn('cleanupOldFiles error', e.message);
  }
}

module.exports = { appendToCache, writeCache, readCache, PUBLIC_DATA_DIR };
