// services/threshold.js
const fs = require('fs');
const path = require('path');

const NOTIF_FILE = path.join(__dirname, '../public/data/notifications_cache.json');

function loadNotifs() {
  if (!fs.existsSync(NOTIF_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(NOTIF_FILE,'utf8')); } catch(e){ return []; }
}

function saveNotifs(arr) {
  fs.writeFileSync(NOTIF_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

// dedupe: only add if not already present (sensorId + date window)
function pushNotification(notif) {
  const list = loadNotifs();
  // basic dedupe using last 1 hour for same sensor+type
  const now = Date.now();
  const exists = list.find(n => n.sensorId === notif.sensorId && n.sensorType === notif.sensorType && (now - new Date(n.timestamp).getTime()) < (60*60*1000));
  if (exists) return false;
  list.unshift(notif); // newest first
  // keep last 200
  saveNotifs(list.slice(0,200));
  return true;
}

module.exports = { pushNotification, loadNotifs };
