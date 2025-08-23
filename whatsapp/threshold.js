// threshold.js
// Evaluate latest row from a rows-array and config.thresholds
const { DateTime } = require('luxon'); // optional: helps with formatting (install luxon) or use native date

function normalizeKey(k) {
  if (!k) return '';
  return String(k).trim().toLowerCase().replace(/\(.*?\)/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
}

function pickField(row, candidates=[]) {
  if (!row) return null;
  for (const cand of candidates) {
    const norm = normalizeKey(cand);
    const key = Object.keys(row).find(k => normalizeKey(k) === norm);
    if (key) return row[key];
  }
  // fallback substring
  const lowcands = candidates.map(c => normalizeKey(c));
  for (const k of Object.keys(row)) {
    const nk = normalizeKey(k);
    for (const lc of lowcands) {
      if (nk.includes(lc) || lc.includes(nk)) return row[k];
    }
  }
  return null;
}

function asNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g,'').trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Evaluate last row and return array of events like:
 * { param, level: 'warning'|'danger', value, timestamp, note }
 */
function evaluateLatest(rows, thresholds) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const last = rows[rows.length - 1];
  const ts = last.Timestamp || last.timestamp || last.time || last.cachedAt || null;
  const events = [];

  // Wind
  const wind = asNumber(pickField(last, ['Wind Speed (km/h)','Wind Speed','wind_speed','wind speed','wind']));
  if (wind !== null) {
    const th = thresholds.wind_kmh || {};
    if (th.danger !== undefined && wind >= th.danger) events.push({ param: 'wind_kmh', level: 'danger', value: wind, timestamp: ts, note: '' });
    else if (th.warning !== undefined && wind >= th.warning) events.push({ param: 'wind_kmh', level: 'warning', value: wind, timestamp: ts, note: '' });
  }

  // Rainfall
  const rain = asNumber(pickField(last, ['Rainfall (mm)','Rainfall','rainfall','rain','Rain(mm)']));
  if (rain !== null) {
    const th = thresholds.rainfall_mm || {};
    if (th.danger !== undefined && rain >= th.danger) events.push({ param: 'rainfall_mm', level: 'danger', value: rain, timestamp: ts, note: '' });
    else if (th.warning !== undefined && rain >= th.warning) events.push({ param: 'rainfall_mm', level: 'warning', value: rain, timestamp: ts, note: '' });
  }

  // Water Temp
  const wtemp = asNumber(pickField(last, ['Water Temp (C)','Water Temp','water_temp','water temp','WaterTemp']));
  if (wtemp !== null) {
    const th = thresholds.water_temp || {};
    if ((th.low_danger !== undefined && wtemp <= th.low_danger) || (th.high_danger !== undefined && wtemp >= th.high_danger)) {
      events.push({ param: 'water_temp', level: 'danger', value: wtemp, timestamp: ts, note: '' });
    } else if ((th.low_warning !== undefined && wtemp <= th.low_warning) || (th.high_warning !== undefined && wtemp >= th.high_warning)) {
      events.push({ param: 'water_temp', level: 'warning', value: wtemp, timestamp: ts, note: '' });
    }
  }

  // TSS
  const tss = asNumber(pickField(last, ['TSS (V)','TSS','tss','turbidity','tss_v']));
  if (tss !== null) {
    const th = thresholds.tss || {};
    if (th.danger !== undefined && tss >= th.danger) events.push({ param: 'tss', level: 'danger', value: tss, timestamp: ts, note: '' });
    else if (th.warning !== undefined && tss >= th.warning) events.push({ param: 'tss', level: 'warning', value: tss, timestamp: ts, note: '' });
  }

  return events;
}

module.exports = { evaluateLatest };
