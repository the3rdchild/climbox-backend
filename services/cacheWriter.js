// services/cacheWriter.js
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '../public/data');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function appendToCache(data, filename = 'notifications.json') {
  const filePath = path.join(CACHE_DIR, filename);
  let existing = [];
  if (fs.existsSync(filePath)) {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  existing.push(data);
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
}

module.exports = { appendToCache };
