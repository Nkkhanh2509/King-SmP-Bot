'use strict';
const BotSession = require('../core/BotSession');
const ProxyManager = require('../core/ProxyManager');
const EnvironmentDetector = require('../core/EnvironmentDetector');
const Persistence = require('../core/Persistence');
const SharedPool = require('../core/SharedPool');
const { pickTheme, TIMING, CS, CAPACITY } = require('../core/constants');
class BotManager {
  constructor(options = {}) {
    this.configPath = options.configPath || require('path').join(process.cwd(), 'config.json');
    this.autoExe = options.autoExe || false;
    this.io = options.io || null;
    this.bots = [];
    this._activeConnects = 0;
    this.envDetector = new EnvironmentDetector(this.autoExe);
    this.persistence = new Persistence(this.configPath);
    this.proxyManager = new ProxyManager(this.io, this.persistence);
    this.sharedPool = SharedPool.global();
    this.dashboard = null;
    this._config = null;
    this._poolPruneInterval = setInterval(() => this.sharedPool.pruneCache(), 10 * 60 * 1000);
  }
  async init() {
    this._config = this.persistence.load();
    this.autoExe = this._config.autoExe === true || this.autoExe;
    const { env, profile } = this.envDetector.getAdaptiveProfile();
    this.env = env;
    this.profile = profile;
    if (Array.isArray(this._config.proxies) || this._config.proxyAssignments) {
      this.proxyManager.loadFromConfig(this._config.proxies || [], this._config.proxyAssignments || {});
    }
    const botCfgs = this._config.bots || [];
    for (let i = 0; i < botCfgs.length; i++) {
      const cfg = botCfgs[i];
      const bot = this._createBotFromConfig(cfg, i);
      this.bots.push(bot);
    }
    return this;
  }
  _createBotFromConfig(cfg, index) {
    const merged = {
      host: cfg.host || this._config.host,
      port: cfg.port || this._config.port,
      version: cfg.version || this._config.version,
      username: cfg.username,
      ownerUsername: cfg.ownerUsername || this._config.ownerUsername,
      registered: cfg.registered !== undefined ? cfg.registered : false,
      botPassword: cfg.botPassword || this._config.botPassword,
      respawn: cfg.respawn !== undefined ? cfg.respawn : (this._config.respawn !== undefined ? this._config.respawn : true),
      useProxy: cfg.useProxy !== undefined ? cfg.useProxy : (this._config.useProxy !== undefined ? this._config.useProxy : false),
      autoMenu: cfg.autoMenu !== undefined ? cfg.autoMenu : (this._config.autoMenu !== undefined ? this._config.autoMenu : true),
      menuCommand: cfg.menuCommand || this._config.menuCommand || '/menu',
      clientSettings: cfg.clientSettings || null,
      sendClientSettings: cfg.sendClientSettings !== undefined ? cfg.sendClientSettings : true,
      skipValidation: cfg.skipValidation !== undefined ? cfg.skipValidation : false,
      viewDistance: cfg.viewDistance || null,
      id: cfg.id,
      theme: cfg.theme || 'teal',
    };
    const theme = pickTheme(merged.theme, index);
    const bot = new BotSession(merged, theme, this.proxyManager, { io: this.io });
    bot._manager = this;
    if (this._config.settings) {
      Object.assign(bot.settings, this._config.settings);
    }
    return bot;
  }
  _createBotFromData(data) {
    const index = this.bots.length;
    const cfg = {
      id: data.id,
      host: data.host || this._config.host,
      port: data.port || this._config.port,
      version: data.version || this._config.version,
      username: data.username,
      ownerUsername: data.ownerUsername || this._config.ownerUsername,
      botPassword: data.password || data.botPassword || this._config.botPassword,
      registered: data.registered !== undefined ? data.registered : false,
      useProxy: data.useProxy !== undefined ? data.useProxy : false,
      autoMenu: data.autoMenu !== undefined ? data.autoMenu : true,
      menuCommand: data.menuCommand || '/menu',
      clientSettings: data.clientSettings || null,
      sendClientSettings: data.sendClientSettings !== undefined ? data.sendClientSettings : true,
      skipValidation: data.skipValidation !== undefined ? data.skipValidation : false,
      viewDistance: data.viewDistance || null,
      theme: data.theme || 'teal',
    };
    const theme = pickTheme(cfg.theme, index);
    const bot = new BotSession(cfg, theme, this.proxyManager, { io: this.io });
    bot._manager = this;
    if (this._config.settings) {
      Object.assign(bot.settings, this._config.settings);
    }
    if (typeof data.proxyIdx === 'number') {
      bot.proxy = this.proxyManager.list[data.proxyIdx] || null;
      if (bot.proxy) {
        this.proxyManager.assignBot(cfg.id, data.proxyIdx);
      }
    } else if (data.proxyId) {
      bot.proxy = this.proxyManager.list.find(p => p.id === data.proxyId) || null;
      if (bot.proxy) {
        this.proxyManager.assignBot(cfg.id, data.proxyId);
      }
    }
    const savedProxy = this.proxyManager.getAssignment(cfg.id);
    if (savedProxy) {
      bot.proxy = savedProxy;
    }
    if (!this._config.bots) this._config.bots = [];
    this._config.bots.push(cfg);
    this.persistence.markDirty();
    this.persistence.saveSync();
    return bot;
  }
  createBot(data) {
    const bot = this._createBotFromData(data);
    this.bots.push(bot);
    return bot;
  }
  removeBot(id) {
    const idx = this.bots.findIndex(b => b.cfg.id.toLowerCase() === id.toLowerCase());
    if (idx === -1) return null;
    const bot = this.bots[idx];
    const actualId = bot.cfg.id;
    bot.shutdown();
    this.bots.splice(idx, 1);
    this.proxyManager.unassignBot(actualId);
    if (this._config.bots) {
      this._config.bots = this._config.bots.filter(c => c.id.toLowerCase() !== actualId.toLowerCase());
      this.persistence.markDirty();
      this.persistence.saveSync();
    }
    return bot;
  }
  findBot(id) {
    return this.bots.find(b => b.cfg.id.toLowerCase() === (id || '').toLowerCase());
  }
  startAll(filterFn = null) {
    const targets = filterFn ? this.bots.filter(filterFn) : this.bots;
    let stagger = 0;
    for (const bot of targets) {
      if (!bot.isConnected && !bot.isReconnecting && !bot._disabled) {
        bot._disabled = false;
        bot.state.reconnects = 0;
        if (stagger > 0) {
          setTimeout(() => bot.start(), stagger);
        } else {
          bot.start();
        }
        stagger += TIMING.CONNECT_STAGGER_MS || 250;
      }
    }
    return targets.length;
  }
  stopAll(filterFn = null) {
    const targets = filterFn ? this.bots.filter(filterFn) : this.bots;
    for (const bot of targets) bot.shutdown();
    return targets.length;
  }
  restartAll(filterFn = null) {
    const targets = filterFn ? this.bots.filter(filterFn) : this.bots;
    let stagger = 0;
    for (const bot of targets) {
      bot.cancelReconnect();
      bot._cleanupOnDisconnect();
      bot._destroyMc();
      bot.state.reconnects = 0;
      bot._fastKicks = 0;
      bot._disabled = false;
      bot._setState(CS.DISCONNECTED);
      if (stagger > 0) {
        setTimeout(() => bot.start(), stagger);
      } else {
        bot.start();
      }
      stagger += TIMING.CONNECT_STAGGER_MS || 250;
    }
    return targets.length;
  }
  getSummary() {
    const counts = { ONLINE: 0, CONNECTING: 0, AUTHENTICATING: 0, SPAWNING: 0, RECONNECTING: 0, DISCONNECTED: 0, STOPPING: 0 };
    let totalPpsIn = 0;
    let totalPpsOut = 0;
    let totalPing = 0;
    let pingCount = 0;
    for (const bot of this.bots) {
      const s = bot.getSummary();
      counts[s.state] = (counts[s.state] || 0) + 1;
      totalPpsIn += s.ppsIn || 0;
      totalPpsOut += s.ppsOut || 0;
      if (s.ping >= 0) {
        totalPing += s.ping;
        pingCount++;
      }
    }
    return {
      total: this.bots.length,
      counts,
      totalPpsIn,
      totalPpsOut,
      avgPing: pingCount > 0 ? Math.round(totalPing / pingCount) : -1,
      systemMetrics: this.getSystemMetrics(),
    };
  }
  getSystemMetrics() {
    const os = require('os');
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpus = os.cpus();
    const procMem = process.memoryUsage();
    return {
      totalMem, freeMem, usedMem,
      memPercent: Math.round((usedMem / totalMem) * 100),
      procHeap: procMem.heapUsed,
      procHeapTotal: procMem.heapTotal,
      procRss: procMem.rss,
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model || 'Unknown',
      loadAvg: os.loadavg(),
      uptime: os.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    };
  }
  getBotCapacity() {
    const os = require('os');
    const totalMemMB = os.totalmem() / (1024 * 1024);
    const freeMemMB = os.freemem() / (1024 * 1024);
    const procMem = process.memoryUsage();
    const usedByProcessMB = procMem.rss / (1024 * 1024);
    const availableMB = freeMemMB - CAPACITY.RESERVED_OS_MB;
    const safeMB = Math.max(0, availableMB - CAPACITY.RESERVED_SYSTEM_MB);
    const afkCount = this.bots.filter(b => b.state.afk).length;
    const activeCount = this.bots.filter(b => b.isOnline && !b.state.afk).length;
    const idleCount = this.bots.length - afkCount - activeCount;
    const avgRAMPerBot = this.bots.length > 0
      ? Math.round(usedByProcessMB / this.bots.length)
      : CAPACITY.RAM_PER_BOT_IDLE_MB;
    const maxBotsRecommended = Math.floor(safeMB / CAPACITY.RAM_PER_BOT_ACTIVE_MB);
    const maxBotsAbsolute = Math.floor(availableMB / CAPACITY.RAM_PER_BOT_IDLE_MB);
    const currentCount = this.bots.length;
    const capacityPercent = maxBotsRecommended > 0 ? Math.min(999, Math.round((currentCount / maxBotsRecommended) * 100)) : 100;
    const isWarning = capacityPercent >= CAPACITY.WARN_THRESHOLD_PCT;
    return {
      totalMemMB: Math.round(totalMemMB),
      freeMemMB: Math.round(freeMemMB),
      availableMB: Math.round(availableMB),
      safeMB: Math.round(safeMB),
      usedByProcessMB: Math.round(usedByProcessMB),
      avgRAMPerBot,
      currentBots: currentCount,
      afkBots: afkCount,
      activeBots: activeCount,
      maxRecommended: maxBotsRecommended,
      maxAbsolute: maxBotsAbsolute,
      capacityPercent,
      isWarning,
      perBotEstimate: {
        idle: CAPACITY.RAM_PER_BOT_IDLE_MB,
        afk: CAPACITY.RAM_PER_BOT_AFK_MB,
        active: CAPACITY.RAM_PER_BOT_ACTIVE_MB,
      },
      warnThresholdPct: CAPACITY.WARN_THRESHOLD_PCT,
    };
  }
  shutdown() {
    for (const bot of this.bots) bot.shutdown();
    this.persistence.shutdown();
    if (this._poolPruneInterval) clearInterval(this._poolPruneInterval);
    this.sharedPool.reset();
    this.bots = [];
  }
}
module.exports = BotManager;
