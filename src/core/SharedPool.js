'use strict';
const dns = require('dns');
const net = require('net');
const { nowMs } = require('./utils');
class SharedPool {
  constructor() {
    this._dnsCache = new Map();
    this._dnsTtl = 5 * 60 * 1000; 
    this._dnsPending = new Map(); 
    this._dnsHits = 0;
    this._dnsMisses = 0;
  }
  static _instance = null;
  static global() {
    if (!SharedPool._instance) SharedPool._instance = new SharedPool();
    return SharedPool._instance;
  }
  async resolveDns(host) {
    if (net.isIP(host)) return host;
    const cached = this._dnsCache.get(host);
    if (cached && (nowMs() - cached.ts) < this._dnsTtl) {
      this._dnsHits++;
      return cached.ip;
    }
    const pending = this._dnsPending.get(host);
    if (pending) return pending;
    this._dnsMisses++;
    const promise = new Promise((resolve, reject) => {
      dns.lookup(host, { family: 4 }, (err, address) => {
        this._dnsPending.delete(host);
        if (err) {
          resolve(host);
        } else {
          this._dnsCache.set(host, { ip: address, ts: nowMs() });
          resolve(address);
        }
      });
    });
    this._dnsPending.set(host, promise);
    return promise;
  }
  optimizeSocket(socket, opts = {}) {
    if (!socket || socket.destroyed) return;
    try {
      socket.setNoDelay(true); 
      socket.setKeepAlive(true, opts.keepAliveMs || 30000); 
    } catch {  }
  }
  getStats() {
    return {
      hits: this._dnsHits,
      misses: this._dnsMisses,
      cacheSize: this._dnsCache.size,
    };
  }
  pruneCache() {
    const now = nowMs();
    for (const [host, { ts }] of this._dnsCache) {
      if (now - ts > this._dnsTtl) this._dnsCache.delete(host);
    }
  }
  reset() {
    this._dnsCache.clear();
    this._dnsPending.clear();
    this._dnsHits = 0;
    this._dnsMisses = 0;
  }
}
module.exports = SharedPool;
