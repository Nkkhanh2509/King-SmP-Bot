'use strict';
const fs = require('fs');
const path = require('path');
class Persistence {
  constructor(configPath = path.join(process.cwd(), 'config.json')) {
    this._configPath = configPath;
    this._data = null;
    this._saveTimer = null;
    this._saveDebounceMs = 1000;
    this._dirty = false;
    this._writeLock = false;
    this._pendingWrite = false;
  }
  load() {
    try {
      const raw = fs.readFileSync(this._configPath, 'utf8');
      this._data = JSON.parse(raw);
      return this._data;
    } catch (e) {
      throw new Error(`Cannot load config: ${e.message}`);
    }
  }
  get data() {
    if (!this._data) this.load();
    return this._data;
  }
  markDirty() {
    this._dirty = true;
    this._scheduleSave();
  }
  saveSync() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this._dirty) return;
    if (this._writeLock) {
      this._pendingWrite = true;
      return;
    }
    this._writeLock = true;
    this._pendingWrite = false;
    try {
      const tmpPath = this._configPath + '.tmp';
      const bakPath = this._configPath + '.bak';
      const content = JSON.stringify(this._data, null, 2);
      try {
        if (fs.existsSync(this._configPath)) {
          fs.copyFileSync(this._configPath, bakPath);
        }
      } catch {
      }
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, this._configPath);
      this._dirty = false;
    } catch (e) {
      if (!process.env.SILENT_CONFIG) {
        console.error('[Persistence] Save error:', e.message);
      }
    } finally {
      this._writeLock = false;
      if (this._pendingWrite) {
        this._pendingWrite = false;
        this._dirty = true;
        this.saveSync();
      }
    }
  }
  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveSync();
    }, this._saveDebounceMs);
  }
  set(keyPath, value) {
    const keys = keyPath.split('.');
    let obj = this._data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!(keys[i] in obj)) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    this.markDirty();
  }
  get(keyPath, fallback) {
    const keys = keyPath.split('.');
    let obj = this._data;
    for (const k of keys) {
      if (obj == null || !(k in obj)) return fallback;
      obj = obj[k];
    }
    return obj;
  }
  shutdown() {
    this.saveSync();
  }
}
module.exports = Persistence;
