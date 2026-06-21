'use strict';
const EventEmitter = require('events');
const { nowMs } = require('./utils');
class PacketMonitor extends EventEmitter {
  constructor(botId) {
    super();
    this.botId = botId;
    this.ppsIn = 0;
    this.ppsOut = 0;
    this.lastPacketAt = null;
    this._cntIn = 0;
    this._cntOut = 0;
    this._interval = null;
    this._mc = null;
    this._boundIn = null;
    this._origWrite = null;
    this._history = [];
    this._historySize = 10;
    this._alerted = { spike: false, drop: false };
  }
  attach(mc) {
    this.detach();
    this._mc = mc;
    this._cntIn = 0;
    this._cntOut = 0;
    this.ppsIn = 0;
    this.ppsOut = 0;
    this.lastPacketAt = nowMs();
    this._history = [];
    this._alerted = { spike: false, drop: false };
    this._boundIn = () => {
      this._cntIn++;
      this.lastPacketAt = nowMs();
    };
    const client = mc._client;
    if (!client) return;
    client.on('packet', this._boundIn);
    this._origWrite = client.write.bind(client);
    client.write = (...args) => {
      this._cntOut++;
      return this._origWrite(...args);
    };
    this._interval = setInterval(() => {
      this.ppsIn = this._cntIn;
      this.ppsOut = this._cntOut;
      this._cntIn = 0;
      this._cntOut = 0;
      this._checkAnomaly();
    }, 1000);
    if (this._interval.unref) this._interval.unref();
  }
  detach() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    if (this._mc?._client) {
      if (this._origWrite) {
        this._mc._client.write = this._origWrite;
        this._origWrite = null;
      }
      if (this._boundIn) {
        try { this._mc._client.removeListener('packet', this._boundIn); } catch { }
      }
    }
    this._mc = null;
    this._boundIn = null;
    this.ppsIn = 0;
    this.ppsOut = 0;
    this.lastPacketAt = null;
  }
  isStale(thresholdMs = 30000) {
    if (!this.lastPacketAt) return true;
    return (nowMs() - this.lastPacketAt) > thresholdMs;
  }
  _checkAnomaly() {
    const total = this.ppsIn + this.ppsOut;
    this._history.push({ time: nowMs(), total });
    if (this._history.length > this._historySize) this._history.shift();
    if (this._history.length < this._historySize) return;
    const values = this._history.map(h => h.total);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(values.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / values.length);
    if (stdDev > 0 && total > mean + 3 * stdDev && !this._alerted.spike) {
      this._alerted.spike = true;
      this.emit('anomaly', { id: this.botId, type: 'spike', ppsIn: this.ppsIn, ppsOut: this.ppsOut, mean: Math.round(mean) });
    } else if (total < mean * 0.1 && mean > 5 && !this._alerted.drop) {
      this._alerted.drop = true;
      this.emit('anomaly', { id: this.botId, type: 'drop', ppsIn: this.ppsIn, ppsOut: this.ppsOut, mean: Math.round(mean) });
    } else if (total >= mean * 0.5 && total <= mean + 2 * stdDev) {
      this._alerted.spike = false;
      this._alerted.drop = false;
    }
  }
}
module.exports = PacketMonitor;
