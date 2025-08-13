// services/cacheWriter.js
const fs = require('fs');
const path = require('path');

const PUBLIC_DATA_DIR = path.join(__dirname, '..', 'public', 'data');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeCache(locationId, sheetName, rows) {
  try {
    const locDir = path.join(PUBLIC_DATA_DIR, locationId);
    ensureDir(locDir);

    const fileName = `${sheetName || 'data'}.json`;
    const filePath = path.join(locDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(rows, null, 2), 'utf8');

    const latestPath = path.join(locDir, 'latest.json');
    const latestPayload = {
      sheetName: sheetName || 'data',
      updatedAt: new Date().toISOString(),
      rowCount: Array.isArray(rows) ? rows.length : null
    };
    fs.writeFileSync(latestPath, JSON.stringify(latestPayload, null, 2), 'utf8');

    return { ok: true, filePath, latestPath };
  } catch (err) {
    console.error('writeCache error:', err);
    throw err;
  }
}

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
    if (!fs.existsSync(latestPath)) {
      const files = fs.readdirSync(locDir)
        .filter(f => f.endsWith('.json') && f !== 'latest.json')
        .map(f => ({ f, mtime: fs.statSync(path.join(locDir, f)).mtimeMs }))
        .sort((a,b) => b.mtime - a.mtime);
      if (files.length === 0) return null;
      const candidate = path.join(locDir, files[0].f);
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    }

    const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    const target = path.join(locDir, `${latest.sheetName}.json`);
    if (!fs.existsSync(target)) return null;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    console.error('readCache error:', err);
    return null;
  }
}

module.exports = { writeCache, readCache, PUBLIC_DATA_DIR };
