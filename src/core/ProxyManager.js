'use strict';
const net = require('net');
const tls = require('tls');
const http = require('http');
const { TIMING } = require('./constants');
const { nowMs } = require('./utils');
class ProxyManager {
  constructor(io = null, persistence = null) {
    this.list = [];
    this.index = 0;
    this._idCounter = 1;
    this.io = io;
    this.persistence = persistence;
    this.assignments = new Map();
    this._geoCache = new Map();
    this._geoCacheTTL = 300000; 
  }
  parse(raw) {
    raw = String(raw).trim();
    if (!raw || raw.startsWith('#')) return null;
    const schemaPatterns = {
      http: /^http:\/\/([a-zA-Z0-9.\-\[\]]+):(\d{1,5})$/,
      https: /^https:\/\/([a-zA-Z0-9.\-\[\]]+):(\d{1,5})$/,
      socks4: /^socks4:\/\/([a-zA-Z0-9.\-\[\]]+):(\d{1,5})$/,
      socks5: /^socks5:\/\/([a-zA-Z0-9.\-\[\]]+):(\d{1,5})$/,
      httpAuth: /^https?:\/\/([^:]+):([^@]+)@([a-zA-Z0-9.\-\[\]]+):(\d{1,5})$/,
      socks4Auth: /^socks4:\/\/([^:]+):([^@]+)@([a-zA-Z0-9.\-\[\]]+):(\d{1,5})$/,
      socks5Auth: /^socks5:\/\/([^:]+):([^@]+)@([a-zA-Z0-9.\-\[\]]+):(\d{1,5})$/,
    };
    for (const [type, pattern] of Object.entries(schemaPatterns)) {
      const m = raw.match(pattern);
      if (m) {
        if (type.includes('Auth')) {
          const baseType = type.replace('Auth', '');
          return {
            type: baseType,
            host: m[3],
            port: parseInt(m[4], 10),
            user: decodeURIComponent(m[1]),
            pass: decodeURIComponent(m[2]),
            tag: null,
            raw,
          };
        }
        return {
          type: type,
          host: m[1],
          port: parseInt(m[2], 10),
          user: null,
          pass: null,
          tag: null,
          raw,
        };
      }
    }
    try {
      let str = raw;
      let explicitType = true;
      if (!str.includes('://')) {
        const parts = str.split(':');
        if (parts.length === 4) {
          str = `unknown://${str}`;
          explicitType = false;
        } else if (parts.length === 3) {
          str = `unknown://${str}`;
          explicitType = false;
        } else {
          str = 'unknown://' + str;
          explicitType = false;
        }
      } else if (!/^(https?|socks[45]):\/\//i.test(str)) {
        str = 'unknown://' + str;
        explicitType = false;
      }
      const u = new URL(str);
      const type = u.protocol.replace(':', '').toLowerCase();
      if (!['http', 'https', 'socks4', 'socks5', 'unknown'].includes(type)) return null;
      const host = u.hostname;
      const port = parseInt(u.port, 10) || (type === 'https' ? 443 : 1080);
      if (!host || port < 1 || port > 65535) return null;
      return {
        type,
        host,
        port,
        user: u.username ? decodeURIComponent(u.username) : null,
        pass: u.password ? decodeURIComponent(u.password) : null,
        tag: null,
        raw,
      };
    } catch { return null; }
  }
  add(raw, tag = null) {
    const p = this.parse(raw);
    if (!p) return { ok: false, msg: 'Proxy không hợp lệ: ' + raw };
    if (this.list.find(x => x.host === p.host && x.port === p.port)) {
      return { ok: false, msg: 'Proxy đã tồn tại: ' + p.host + ':' + p.port };
    }
    const entry = this._initEntry(p);
    if (tag) entry.tag = tag;
    entry.id = 'pxy_' + (this._idCounter++);
    this.list.push(entry);
    this._broadcast();
    this._persist();
    if (entry.type === 'unknown') {
      this._detectInBackground(entry);
    }
    return { ok: true, msg: `${entry.type}://${entry.host}:${entry.port}`, entry: { id: entry.id } };
  }
  async _detectInBackground(entry) {
    try {
      const raw = entry.user
        ? `${entry.host}:${entry.port}:${entry.user}:${entry.pass || ''}`
        : `${entry.host}:${entry.port}`;
      const res = await this.detectType(raw);
      const idx = this.list.findIndex(x => x.id === entry.id);
      if (idx === -1) return;
      if (res.ok) {
        this.list[idx].type = res.type;
        this.markLive(idx, res.ping);
      } else {
        this.markDead(idx, 'die');
      }
      this._persist();
    } catch {
    }
  }
  _initEntry(p) {
    return {
      ...p,
      status: 'unknown',
      ping: -1,
      failCount: 0,
      lastChecked: null,
      cooldownUntil: null,
      geo: null,
      quality: 'unknown',
    };
  }
  removeByIndex(index) {
    if (index < 0 || index >= this.list.length) return null;
    const removed = this.list.splice(index, 1)[0];
    for (const [botId, proxyId] of this.assignments) {
      if (proxyId === removed.id) this.assignments.delete(botId);
    }
    this._broadcast();
    this._persist();
    return removed;
  }
  removeById(proxyId) {
    const idx = this.list.findIndex(p => p.id === proxyId);
    if (idx === -1) return null;
    return this.removeByIndex(idx);
  }
  remove(index) {
    if (typeof index === 'string') return this.removeById(index);
    return this.removeByIndex(index);
  }
  assignBot(botId, proxyIndexOrId) {
    let proxy;
    if (typeof proxyIndexOrId === 'number') {
      if (proxyIndexOrId < 0 || proxyIndexOrId >= this.list.length) return false;
      proxy = this.list[proxyIndexOrId];
    } else {
      proxy = this.list.find(p => p.id === proxyIndexOrId);
      if (!proxy) return false;
    }
    this.assignments.set(botId, proxy.id);
    this._persist();
    return true;
  }
  getAssignment(botId) {
    const proxyId = this.assignments.get(botId);
    if (proxyId === undefined) return null;
    return this.list.find(p => p.id === proxyId) || null;
  }
  unassignBot(botId) {
    const existed = this.assignments.delete(botId);
    if (existed) this._persist();
    return existed;
  }
  next(botId = null) {
    if (botId) {
      const assigned = this.getAssignment(botId);
      if (assigned && this._isUsable(assigned)) return assigned;
    }
    const live = this._getLiveProxies();
    if (!live.length) return null;
    const p = live[this.index % live.length];
    this.index++;
    return p;
  }
  _getLiveProxies() {
    return this.list.filter(p => this._isUsable(p));
  }
  _isUsable(p) {
    if (p.type === 'unknown') return false;
    if (p.status === 'die' || p.status === 'auth_fail') return false;
    if (p.cooldownUntil && nowMs() < p.cooldownUntil) return false;
    return true;
  }
  markLive(idx, ping = -1) {
    const p = this.list[idx];
    if (!p) return;
    p.status = 'live';
    p.ping = ping;
    p.failCount = 0;
    p.lastChecked = nowMs();
    p.cooldownUntil = null;
    this._broadcast();
  }
  markDead(idx, reason = 'die') {
    const p = this.list[idx];
    if (!p) return;
    p.status = reason;
    p.failCount++;
    p.lastChecked = nowMs();
    const cooldown = Math.min(30000 * Math.pow(2, p.failCount - 1), 300000);
    p.cooldownUntil = nowMs() + cooldown;
    this._broadcast();
  }
  async testAll(concurrency = 10) {
    const results = [];
    for (let i = 0; i < this.list.length; i += concurrency) {
      const batch = this.list.slice(i, i + concurrency).map((p, j) =>
        this.test(i + j).then(r => ({ idx: i + j, result: r })).catch(e => ({ idx: i + j, result: { ok: false, error: e.message } }))
      );
      const batchResults = await Promise.allSettled(batch);
      for (const r of batchResults) {
        results.push(r.value || { idx: -1, result: { ok: false, error: 'settled error' } });
      }
    }
    return results;
  }
  async test(idx) {
    const p = this.list[idx];
    if (!p) return { ok: false, error: 'Invalid index' };
    const start = nowMs();
    let sock = null;
    try {
      sock = await this.connect(p, '1.1.1.1', 80);
      const ping = nowMs() - start;
      try { sock.destroy(); } catch {}
      this.markLive(idx, ping);
      return { ok: true, ping, type: p.type, quality: ProxyManager.gradeQuality(ping) };
    } catch (e) {
      if (sock) { try { sock.destroy(); } catch {} }
      const status = e.message.includes('auth') ? 'auth_fail' :
                     e.message.includes('timeout') ? 'timeout' : 'die';
      this.markDead(idx, status);
      return { ok: false, error: e.message, status };
    }
  }
  async connect(proxy, targetHost, targetPort) {
    if (proxy.type === 'unknown') {
      const detect = await this.detectType(proxy.host, proxy.port);
      if (!detect.ok) throw new Error('Không xác định được loại proxy — thử Upgrade trước');
      proxy.type = detect.type;
    }
    switch (proxy.type) {
      case 'http': return this._connectHttp(proxy, targetHost, targetPort, false);
      case 'https': return this._connectHttp(proxy, targetHost, targetPort, true);
      case 'socks4': return this._connectSocks4(proxy, targetHost, targetPort);
      case 'socks5': return this._connectSocks5(proxy, targetHost, targetPort);
      default: throw new Error('Loại proxy không hỗ trợ: ' + proxy.type);
    }
  }
  _connectHttp(proxy, targetHost, targetPort, useTls = false) {
    const timeout = proxy.timeout || TIMING.PROXY_TIMEOUT;
    return new Promise((resolve, reject) => {
      let settled = false;
      const sock = useTls
        ? tls.connect(proxy.port, proxy.host, { rejectUnauthorized: false })
        : net.connect(proxy.port, proxy.host);
      const timer = setTimeout(() => {
        try { sock.destroy(); } catch { }
        settle(new Error('HTTP proxy timeout'));
      }, timeout);
      const settle = (err, res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(res);
      };
      sock.once('connect', () => {
        try {
          let req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
          if (proxy.user) {
            const cred = Buffer.from(`${proxy.user}:${proxy.pass || ''}`).toString('base64');
            req += `Proxy-Authorization: Basic ${cred}\r\n`;
          }
          req += '\r\n';
          sock.write(req);
        } catch (e) { settle(e); }
      });
      let buf = '';
      sock.on('data', d => {
        buf += d.toString('latin1');
        if (!buf.includes('\r\n\r\n')) return;
        if (/^HTTP\/1\.[01] 200/i.test(buf)) settle(null, sock);
        else { sock.destroy(); settle(new Error('HTTP proxy: ' + buf.split('\r\n')[0])); }
      });
      sock.once('error', settle);
      sock.once('close', () => settle(new Error('HTTP proxy đóng sớm')));
    });
  }
  _connectSocks4(proxy, targetHost, targetPort) {
    const timeout = proxy.timeout || TIMING.PROXY_TIMEOUT;
    return new Promise((resolve, reject) => {
      let settled = false;
      const sock = net.connect(proxy.port, proxy.host);
      const timer = setTimeout(() => {
        try { sock.destroy(); } catch { }
        settle(new Error('SOCKS4 timeout'));
      }, timeout);
      const settle = (err, res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(res);
      };
      sock.once('connect', () => {
        try {
          const user = Buffer.from(proxy.user || '');
          const domain = Buffer.from(targetHost + '\\0');
          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(targetPort, 0);
          sock.write(Buffer.concat([
            Buffer.from([0x04, 0x01]), portBuf, Buffer.from([0, 0, 0, 1]),
            user, Buffer.from([0x00]), domain,
          ]));
        } catch (e) { settle(e); }
      });
      sock.once('data', d => {
        if (d.length >= 2 && d[1] === 0x5a) settle(null, sock);
        else { sock.destroy(); settle(new Error('SOCKS4 từ chối: ' + (d.length > 1 ? d[1] : '?'))); }
      });
      sock.once('error', settle);
      sock.once('close', () => settle(new Error('SOCKS4 đóng sớm')));
    });
  }
  _connectSocks5(proxy, targetHost, targetPort) {
    const timeout = proxy.timeout || TIMING.PROXY_TIMEOUT;
    return new Promise((resolve, reject) => {
      let settled = false;
      let step = 0;
      const sock = net.connect(proxy.port, proxy.host);
      const timer = setTimeout(() => {
        try { sock.destroy(); } catch { }
        settle(new Error('SOCKS5 timeout'));
      }, timeout);
      const settle = (err, res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(res);
      };
      const sendConnect = () => {
        const host = Buffer.from(targetHost);
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(targetPort, 0);
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, portBuf]));
      };
      const onData = d => {
        try {
          if (step === 0) {
            if (d[1] === 0xff) { sock.destroy(); settle(new Error('SOCKS5: không có auth phù hợp')); return; }
            if (d[1] === 0x02 && proxy.user) {
              const u = Buffer.from(proxy.user || '');
              const p = Buffer.from(proxy.pass || '');
              sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
              step = 1;
            } else { sendConnect(); step = 2; }
          } else if (step === 1) {
            if (d[1] !== 0x00) { sock.destroy(); settle(new Error('SOCKS5 auth thất bại')); return; }
            sendConnect(); step = 2;
          } else if (step === 2) {
            if (d[1] !== 0x00) { sock.destroy(); settle(new Error('SOCKS5 từ chối: ' + d[1])); return; }
            sock.removeListener('data', onData);
            settle(null, sock);
          }
        } catch (e) { settle(e); }
      };
      sock.once('connect', () => {
        try {
          const method = proxy.user ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
          sock.write(method);
        } catch (e) { settle(e); }
      });
      sock.on('data', onData);
      sock.once('error', settle);
      sock.once('close', () => settle(new Error('SOCKS5 đóng sớm')));
    });
  }
  async detectType(hostOrRaw, port = null) {
    let host, proxyPort, user, pass;
    if (port === null && typeof hostOrRaw === 'string') {
      const parsed = this.parse(hostOrRaw);
      if (!parsed) return { ok: false, error: 'Không parse được proxy' };
      host = parsed.host;
      proxyPort = parsed.port;
      user = parsed.user;
      pass = parsed.pass;
    } else {
      host = hostOrRaw;
      proxyPort = port;
    }
    const types = user ? ['socks5', 'http', 'https', 'socks4'] : ['socks5', 'socks4', 'http', 'https'];
    const results = [];
    for (const type of types) {
      const p = { type, host, port: proxyPort, user, pass };
      const start = nowMs();
      let sock = null;
      try {
        sock = await this.connect(p, '1.1.1.1', 80);
        const ping = nowMs() - start;
        try { sock.destroy(); } catch {}
        results.push({ type, ping, ok: true });
        break;
      } catch (e) {
        if (sock) { try { sock.destroy(); } catch {} }
        results.push({ type, error: e.message, ok: false });
      }
    }
    const best = results.find(r => r.ok);
    if (best) {
      return { ok: true, type: best.type, ping: best.ping, allResults: results };
    }
    return { ok: false, error: 'Không kết nối được proxy nào', allResults: results };
  }
  async autoAdd(raw, tag = null) {
    const detection = await this.detectType(raw);
    if (!detection.ok) {
      return { ok: false, msg: detection.error, detection };
    }
    const str = raw.trim();
    if (str.includes('://')) {
      return this.add(detection.type + '://' + str.split('://')[1], tag);
    }
    const parts = str.split(':');
    if (parts.length === 4) {
      return this.add(`${detection.type}://${parts[0]}:${parts[1]}@${parts[2]}:${parts[3]}`, tag);
    } else if (parts.length === 3) {
      return this.add(`${detection.type}://${parts[0]}:${parts[1]}`, tag);
    } else {
      return this.add(`${detection.type}://${str}`, tag);
    }
  }
  static gradeQuality(ping) {
    if (ping < 0) return 'unknown';
    if (ping < 50) return 'excellent';
    if (ping < 150) return 'good';
    if (ping < 300) return 'fair';
    return 'slow';
  }
  async _fetchGeo(host) {
    const cached = this._geoCache.get(host);
    if (cached && (Date.now() - cached.time) < this._geoCacheTTL) {
      return cached.data;
    }
    try {
      return await new Promise((resolve, reject) => {
        const req = http.get(`http://ip-api.com/json/${encodeURIComponent(host)}?fields=country,countryCode,city,isp,org,region,timezone`, { timeout: 5000 }, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.status === 'fail') { reject(new Error(json.message || 'Geo lookup failed')); return; }
              this._geoCache.set(host, { data: json, time: Date.now() });
              resolve(json);
            } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Geo lookup timeout')); });
        req.end();
      });
    } catch {
      return null;
    }
  }
  async enrichGeo(idx) {
    const p = this.list[idx];
    if (!p) return { ok: false, error: 'Invalid index' };
    try {
      p.geo = await this._fetchGeo(p.host);
      this._broadcast();
      this._persist();
      return { ok: true, geo: p.geo };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  async upgrade(idx) {
    const p = this.list[idx];
    if (!p) return { ok: false, error: 'Invalid index' };
    const result = {
      ok: false,
      type: p.type,
      ping: -1,
      status: 'unknown',
      quality: 'unknown',
      geo: null,
    };
    const start = nowMs();
    let sock = null;
    try {
      sock = await this.connect(p, '1.1.1.1', 80);
      const ping = nowMs() - start;
      try { sock.destroy(); } catch {}
      result.ping = ping;
      result.status = 'live';
      result.quality = ProxyManager.gradeQuality(ping);
      this.markLive(idx, ping);
    } catch (e) {
      if (sock) { try { sock.destroy(); } catch {} }
      result.status = e.message.includes('auth') ? 'auth_fail' :
                      e.message.includes('timeout') ? 'timeout' : 'die';
      this.markDead(idx, result.status);
    }
    if (result.status !== 'live') {
      const detect = await this.detectType(p.host, p.port);
      if (detect.ok && detect.type !== p.type) {
        p.type = detect.type;
        result.type = detect.type;
        result.ping = detect.ping;
        result.status = 'live';
        result.quality = ProxyManager.gradeQuality(detect.ping);
        this.markLive(idx, detect.ping);
      }
    }
    try {
      p.geo = await this._fetchGeo(p.host);
      result.geo = p.geo;
    } catch {}
    if (result.quality === 'unknown' && result.ping >= 0) {
      result.quality = ProxyManager.gradeQuality(result.ping);
    }
    p.quality = result.quality;
    result.ok = result.status === 'live';
    this._broadcast();
    this._persist();
    return result;
  }
  async upgradeAll() {
    const results = [];
    for (let i = 0; i < this.list.length; i++) {
      results.push(await this.upgrade(i));
      if (this.list.length > 40 && i < this.list.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    return results;
  }
  _broadcast() {
    if (this.io) {
      this.io.emit('proxyList', this.list.map((p, i) => this._summarize(p, i)));
    }
  }
  _summarize(p, idx = null) {
    return {
      id: p.id,
      idx: idx !== null ? idx : this.list.indexOf(p),
      type: p.type, host: p.host, port: p.port,
      user: p.user ? '✓' : null,
      tag: p.tag,
      status: p.status, ping: p.ping,
      quality: p.quality || ProxyManager.gradeQuality(p.ping),
      failCount: p.failCount,
      lastChecked: p.lastChecked,
      cooldownUntil: p.cooldownUntil,
      geo: p.geo || null,
    };
  }
  getSummaries() {
    return this.list.map((p, i) => this._summarize(p, i));
  }
  _persist() {
    if (this.persistence) {
      this.persistence.set('proxies', this.list.map(p => ({
        id: p.id,
        type: p.type, host: p.host, port: p.port,
        user: p.user, pass: p.pass,
        tag: p.tag, status: p.status, ping: p.ping,
        quality: p.quality, geo: p.geo,
        failCount: p.failCount, lastChecked: p.lastChecked,
      })));
      const assignments = {};
      for (const [botId, proxyId] of this.assignments) {
        assignments[botId] = proxyId;
      }
      this.persistence.set('proxyAssignments', assignments);
      this.persistence.saveSync();
    }
  }
  loadFromConfig(proxies, assignments = {}) {
    this.list = [];
    if (Array.isArray(proxies)) {
      for (const p of proxies) {
        const entry = this._initEntry({
          type: p.type || 'unknown',
          host: p.host,
          port: p.port,
          user: p.user || null,
          pass: p.pass || null,
          tag: p.tag || null,
        });
        entry.id = p.id || ('pxy_' + (this._idCounter++));
        entry.status = p.status || 'unknown';
        entry.ping = p.ping ?? -1;
        entry.quality = p.quality || 'unknown';
        entry.geo = p.geo || null;
        entry.failCount = p.failCount || 0;
        entry.lastChecked = p.lastChecked || null;
        this.list.push(entry);
      }
    }
    if (assignments && typeof assignments === 'object') {
      for (const [botId, proxyId] of Object.entries(assignments)) {
        if (this.list.some(p => p.id === proxyId)) {
          this.assignments.set(botId, proxyId);
        }
      }
    }
  }
}
module.exports = ProxyManager;
