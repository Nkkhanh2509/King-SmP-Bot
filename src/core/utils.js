'use strict';
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const jit = (base, s) => Math.max(0, base + Math.round((Math.random() * 2 - 1) * s));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const nowMs = () => Date.now();
function stripMc(s) {
  return String(s)
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/\u00a7[0-9a-fk-or]/gi, '')
    .replace(/\\u[0-9a-fA-F]{4}/g, '');
}
function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}
function _unwrapList(listLike) {
  if (!listLike) return [];
  if (Array.isArray(listLike)) return listLike;
  if (typeof listLike === 'object') {
    const v = listLike.value;
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      if (Array.isArray(v.value)) return v.value;
      return Object.values(v);
    }
    return Object.values(listLike);
  }
  return [];
}
function resolveText(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return stripMc(raw);
  try {
    const o = typeof raw === 'object' ? raw : JSON.parse(raw);
    if (o.type === 'string' && typeof o.value === 'string') {
      return stripMc(o.value);
    }
    let out = typeof o.text === 'string' ? o.text : (o.text ? resolveText(o.text) : '');
    out += _unwrapList(o.extra).map(resolveText).join('');
    out += _unwrapList(o.with).map(resolveText).join('');
    return stripMc(out);
  } catch { return stripMc(String(raw)); }
}
function parseShardNum(text) {
  if (!text) return null;
  const up = text.toUpperCase();
  if (!up.includes('SHARD') && !up.includes('MẢNH')) return null;
  for (const m of text.matchAll(/(\d[\d,.]*)\s*(k|K|M)?/g)) {
    let n = parseFloat(m[1].replace(/[,.]/g, ''));
    if (isNaN(n)) continue;
    if (m[2] === 'k' || m[2] === 'K') n *= 1e3;
    if (m[2] === 'M') n *= 1e6;
    if (n >= 1) return Math.round(n);
  }
  return null;
}
function safeJsonStringify(obj, fallback = '{}') {
  try { return JSON.stringify(obj); } catch { return fallback; }
}
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
module.exports = {
  rand, jit, sleep, clamp, nowMs,
  stripMc, stripAnsi, resolveText, parseShardNum, safeJsonStringify,
  formatUptime, formatBytes, ts,
};
