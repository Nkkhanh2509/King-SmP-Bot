'use strict';
const EventEmitter = require('events');
const mineflayer = require('mineflayer');
const { CS, TIMING, IGNORED_ERRORS, DEFAULTS } = require('./constants');
const { rand, jit, clamp, nowMs, resolveText, parseShardNum, safeJsonStringify } = require('./utils');
const PacketMonitor = require('./PacketMonitor');
const CommandRegistry = require('./CommandRegistry');
const { WindowRouter } = require('./WindowRouter');
const RingBuffer = require('./RingBuffer');
const SharedPool = require('./SharedPool');
class BotSession extends EventEmitter {
  constructor(cfg, theme, proxyManager, socketRooms = null) {
    super();
    this.cfg = cfg;
    this.theme = theme;
    this.proxyManager = proxyManager;
    this.socketRooms = socketRooms;
    this.proxy = null;
    this.mc = null;
    this.packetMgr = new PacketMonitor(cfg.id);
    this.cmdRegistry = new CommandRegistry(this);
    this._logBuffer = new RingBuffer(800);
    this.settings = { ...DEFAULTS };
    this.state = {
      connState: CS.DISCONNECTED,
      afk: null,
      intendedAfk: null,
      shard: 0,
      reconnects: 0,
      ping: -1,
      position: null,
      health: 20,
      food: 20,
      loginTime: null,
      inventory: [],
      tshard: false,
      autoStats: false,
      autoShard: false,
      autoEat: false,
    };
    this._timers = new Map();
    this._disabled = false;
    this._connectCompleted = false;
    this._menuRetryCount = 0;
    this._menuSuccess = false;
    this._firstSpawn = true;
    this._spawnTime = 0;
    this._fastKicks = 0;
    this._reconnectScheduled = false;
    this._isEating = false;
    this._isCleanedUp = false;
    this._wasKicked = false;       
    this._loginCmdDone = false;    
    this._lastReconnectTime = 0;
    this._reconnectTimestamps = [];
    this._healthProbed = false;
    this._consecutiveProxyFails = 0;
    this._proxyDisabledByFallback = false;
    this._sharedPool = SharedPool.global();
    this._packetTimeout = cfg.packetTimeout || TIMING.PACKET_TIMEOUT;
    this._entityTimeout = cfg.entityTimeout || TIMING.ENTITY_TIMEOUT;
    this._reconnectBaseDelay = cfg.reconnectBaseDelay || 1000;
    this._reconnectMaxDelay = cfg.reconnectMaxDelay || 60000;
    this._reconnectJitter = cfg.reconnectJitter ?? true;
    this._reconnectMaxRetries = cfg.reconnectMaxRetries || TIMING.MAX_RECONNECT;
    this.packetMgr.on('anomaly', data => {
      this.emit('packetAnomaly', data);
      if (this.socketRooms?.io) {
        this.socketRooms.io.emit('packetAnomaly', data);
      }
    });
    this._registerCommands();
  }
  log(level, msg) {
    const entry = { id: this.cfg.id, time: nowMs(), level, msg };
    this._logBuffer.push(entry);
    this.emit('log', { level, id: this.cfg.id, msg, theme: this.theme, entry });
    if (this.socketRooms?.io) {
      this.socketRooms.io.to(`bot:${this.cfg.id}`).emit('log', entry);
    }
  }
  getLogs() {
    return this._logBuffer.toArray();
  }
  _setTimer(key, fn, delay, repeat = false) {
    this._clearTimer(key);
    let handle;
    if (repeat) {
      handle = setInterval(fn, delay);
    } else {
      handle = setTimeout(() => {
        this._timers.delete(key);
        fn();
      }, delay);
    }
    this._timers.set(key, { handle, repeat });
    return handle;
  }
  _clearTimer(key) {
    const t = this._timers.get(key);
    if (!t) return;
    t.repeat ? clearInterval(t.handle) : clearTimeout(t.handle);
    this._timers.delete(key);
  }
  _clearAllTimers() {
    for (const [key] of this._timers) this._clearTimer(key);
  }
  static _VALID_TRANSITIONS = new Map([
    [CS.DISCONNECTED, new Set([CS.CONNECTING, CS.STOPPING])],
    [CS.CONNECTING, new Set([CS.AUTHENTICATING, CS.SPAWNING, CS.RECONNECTING, CS.DISCONNECTED, CS.STOPPING])],
    [CS.AUTHENTICATING, new Set([CS.SPAWNING, CS.ONLINE, CS.RECONNECTING, CS.DISCONNECTED, CS.STOPPING])],
    [CS.SPAWNING, new Set([CS.ONLINE, CS.RECONNECTING, CS.DISCONNECTED, CS.STOPPING])],
    [CS.ONLINE, new Set([CS.RECONNECTING, CS.DISCONNECTED, CS.STOPPING, CS.CONNECTING])],
    [CS.RECONNECTING, new Set([CS.DISCONNECTED, CS.CONNECTING, CS.STOPPING])],
    [CS.STOPPING, new Set([CS.DISCONNECTED])],
  ]);
  _setState(newState) {
    const prev = this.state.connState;
    if (prev === newState) return;
    const allowed = BotSession._VALID_TRANSITIONS.get(prev);
    if (allowed && !allowed.has(newState) && prev !== newState) {
      if (!(this._disabled && newState === CS.DISCONNECTED) && !(prev === CS.STOPPING && newState === CS.DISCONNECTED)) {
        this.emit('invalidTransition', { prev, attempted: newState, id: this.cfg.id });
      }
    }
    this.state.connState = newState;
    this.emit('stateChange', { prev, now: newState, id: this.cfg.id });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('botState', { id: this.cfg.id, state: newState });
    }
  }
  get isOnline()        { return this.state.connState === CS.ONLINE; }
  get isConnected()     { return [CS.ONLINE, CS.SPAWNING, CS.AUTHENTICATING].includes(this.state.connState); }
  get isStopping()      { return this.state.connState === CS.STOPPING; }
  get isReconnecting()  { return this.state.connState === CS.RECONNECTING; }
  get isOffline()       { return this.state.connState === CS.DISCONNECTED; }
  requireOnline(cmdName = '') {
    if (!this.isOnline) {
      this.log('warn', `Bot chưa ONLINE${cmdName ? ' — lệnh "' + cmdName + '" bị bỏ qua' : ''}`);
      return false;
    }
    return true;
  }
  _updateShard(n) {
    if (n === null || n === this.state.shard) return;
    const prev = this.state.shard;
    this.state.shard = n;
    this.emit('shard', { prev, now: n, id: this.cfg.id });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('shard', { id: this.cfg.id, shard: n });
    }
  }
  _updateInventory() {
    if (!this.mc?.inventory) return;
    try {
      const inv = [];
      const items = this.mc.inventory.items();
      for (const item of items) {
        if (!item) continue;
        inv.push({
          slot: item.slot,
          name: resolveText(item.customName || item.displayName || item.name || 'Unknown'),
          type: item.name || item.type,
          count: item.count,
          lore: item.customLore ? safeJsonStringify(item.customLore).substring(0, 200) : '',
          stackId: item.stackId,
        });
      }
      this.state.inventory = inv;
      this.emit('inventory', { id: this.cfg.id, items: inv });
      if (this.socketRooms?.io) {
        this.socketRooms.io.emit('inventory', { id: this.cfg.id, items: inv });
      }
    } catch (e) {
      this.log('err', 'Lỗi đọc inventory: ' + e.message);
    }
  }
  _cleanupOnDisconnect() {
    this._clearAllTimers();
    this.packetMgr.detach();
    this.afkStop();
    this.state.afk = null;
    this.state.intendedAfk = null;
    this.state.ping = -1;
    this.state.loginTime = null;
    this._firstSpawn = true;
    this._spawnTime = 0;
    this._isCleanedUp = true;
  }
  _destroyMc() {
    if (!this.mc) return;
    const mc = this.mc;
    this.mc = null;
    try {
      const c = mc._client;
      if (c) {
        c.removeAllListeners();
        if (this.packetMgr._origWrite && c.write === this.packetMgr._boundWrite) {
          c.write = this.packetMgr._origWrite;
        }
        c.end = () => {};
      }
    } catch { }
    try { mc.removeAllListeners(); } catch { }
    try { mc.end('cleanup'); } catch { }
    this._isCleanedUp = true;
  }
  scheduleReconnect(reason) {
    if (this._disabled || this.isStopping) return;
    if (this._reconnectScheduled) return;
    if (this.isReconnecting) return;
    const now = nowMs();
    const sinceLast = now - this._lastReconnectTime;
    const cooldownMs = this._wasKicked ? TIMING.RECONNECT_COOLDOWN_KICK_MS : TIMING.RECONNECT_COOLDOWN_MS;
    this._wasKicked = false;
    if (this._lastReconnectTime > 0 && sinceLast < cooldownMs) {
      const waitMs = cooldownMs - sinceLast;
      this.log('warn', `Reconnect bị chặn (cooldown ${Math.ceil(waitMs / 1000)}s)${reason ? ' — ' + reason : ''}`);
      this._setTimer('reconnect_cooldown', () => this.scheduleReconnect(reason), waitMs + 500);
      return;
    }
    const windowStart = now - TIMING.RECONNECT_WINDOW_MS;
    this._reconnectTimestamps = this._reconnectTimestamps.filter(t => t > windowStart);
    if (this._reconnectTimestamps.length >= TIMING.RECONNECT_MAX_IN_WINDOW) {
      this._reconnectScheduled = true;
      this.log('err', `Quá ${TIMING.RECONNECT_MAX_IN_WINDOW} lần reconnect trong ${TIMING.RECONNECT_WINDOW_MS / 60000}ph — tạm dừng 5 phút`);
      this._setState(CS.DISCONNECTED);
      this._setTimer('reconnect_rate_limited', () => {
        if (this._disabled) return;
        this._reconnectTimestamps = [];
        this._lastReconnectTime = 0;
        this.log('warn', 'Hết thời gian chờ rate-limit, thử lại...');
        this._reconnectScheduled = false;
        this.start();
      }, 5 * 60 * 1000);
      return;
    }
    this._reconnectTimestamps.push(now);
    this._lastReconnectTime = now;
    if (this._manager && this._manager._activeConnects >= TIMING.MAX_CONCURRENT_CONNECTS) {
      this._setTimer('reconnect_queued', () => this.scheduleReconnect(reason), 3000);
      return;
    }
    this._reconnectScheduled = true;
    this._setState(CS.RECONNECTING);
    const spawnAge = this._spawnTime > 0 ? nowMs() - this._spawnTime : Infinity;
    const savedFastKicks = this._fastKicks;
    this._cleanupOnDisconnect();
    this._destroyMc();
    if (this.state.reconnects >= this._reconnectMaxRetries) {
      this.log('err', `Đã đạt giới hạn ${this._reconnectMaxRetries} reconnect — thử lại sau 15 phút`);
      this._setState(CS.DISCONNECTED);
      this._reconnectScheduled = false;
      this._setTimer('reconnect_longwait', () => {
        if (this._disabled) return;
        this.log('warn', 'Thử kết nối lại sau giới hạn reconnect...');
        this.state.reconnects = 0;
        this._fastKicks = 0;
        this._reconnectScheduled = false;
        this.start();
      }, 15 * 60 * 1000);
      return;
    }
    const fastKick = spawnAge < 10000;
    if (fastKick) {
      this._fastKicks = savedFastKicks + 1;
    } else {
      this._fastKicks = 0;
    }
    const retries = Math.min(this.state.reconnects, 12);
    const expBackoff = Math.min(
      this._reconnectBaseDelay * Math.pow(2, retries),
      this._reconnectMaxDelay
    );
    const extraDelay = fastKick ? Math.min(this._fastKicks * TIMING.FAST_KICK_EXTRA_MS, TIMING.FAST_KICK_EXTRA_MAX) : 0;
    const base = expBackoff + extraDelay;
    const delay = this._reconnectJitter ? jit(base, Math.round(base * 0.3)) : base;
    this.state.reconnects++;
    const maxRetryStr = this._reconnectMaxRetries >= 999 ? '∞' : String(this._reconnectMaxRetries);
    this.log('warn', `Mất kết nối${reason ? ' (' + reason + ')' : ''}${fastKick ? ' [FAST KICK x' + this._fastKicks + ']' : ''} — thử lại lần ${this.state.reconnects}/${maxRetryStr} sau ${(delay / 1000).toFixed(1)}s (backoff)`);
    this.emit('disconnectReason', { id: this.cfg.id, reason, fastKick, retry: this.state.reconnects });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('disconnectReason', { id: this.cfg.id, reason, fastKick, retry: this.state.reconnects });
    }
    this._setTimer('reconnect', () => {
      this._reconnectScheduled = false;
      if (this._disabled || this.isStopping) return;
      this.start();
    }, delay);
  }
  cancelReconnect() {
    this._clearTimer('reconnect');
    this._clearTimer('reconnect_longwait');
    this._clearTimer('reconnect_queued');
    this._clearTimer('reconnect_cooldown');
    this._clearTimer('reconnect_rate_limited');
    this._clearTimer('start_queued');
    this._reconnectScheduled = false;
    this._reconnectTimestamps = [];
    this._lastReconnectTime = 0;
    if (this.isReconnecting) this._setState(CS.DISCONNECTED);
  }
  _disableProxyFallback() {
    if (this._proxyDisabledByFallback) return;
    this._proxyDisabledByFallback = true;
    this.proxy = null;
    this.cfg.useProxy = false;
    if (this._manager?.dashboard?._syncBotToConfig) {
      this._manager.dashboard._syncBotToConfig(this);
    }
    this.log('warn', `⚠️ Proxy đã bị tắt tự động sau ${TIMING.PROXY_FAIL_THRESHOLD} lần fail liên tiếp — chuyển sang kết nối thẳng`);
    this.emit('proxyFallback', { id: this.cfg.id });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('proxyFallback', { id: this.cfg.id });
    }
  }
  forceReconnect() {
    this.log('sys', 'Force reconnect...');
    this.cancelReconnect();
    this._onConnectComplete();
    this.state.reconnects = 0;
    this._fastKicks = 0;
    this._setState(CS.DISCONNECTED);
    this._cleanupOnDisconnect();
    this._destroyMc();
    this._lastReconnectTime = nowMs();
    this._reconnectScheduled = true;
    this._setTimer('reconnect', () => {
      this._reconnectScheduled = false;
      this.start();
    }, 500);
  }
  async start() {
    if (this._disabled || this.isStopping) return;
    if (this.isConnected) {
      this.log('warn', 'start() gọi khi bot đã kết nối — bỏ qua');
      return;
    }
    if (this._manager && this._manager._activeConnects >= TIMING.MAX_CONCURRENT_CONNECTS) {
      this._setTimer('start_queued', () => this.start(), 3000);
      return;
    }
    this._destroyMc();
    this._clearAllTimers();
    this._reconnectScheduled = false;
    this._menuRetryCount = 0;
    this._menuSuccess = false;
    this._firstSpawn = true;
    this._spawnTime = 0;
    this._healthProbed = false;
    this._loginCmdDone = false;    
    this._wasKicked = false;       
    this._proxyDisabledByFallback = false;  
    this._setState(CS.CONNECTING);
    this._connectCompleted = false;
    if (this._manager) this._manager._activeConnects = (this._manager._activeConnects || 0) + 1;
    const { cfg } = this;
    const proxy = this.proxy || (cfg.useProxy === true ? this.proxyManager.next(cfg.id) : null);
    let proxySocket = null;
    if (proxy) {
      this.log('proxy', `Kết nối qua ${proxy.type}://${proxy.host}:${proxy.port}`);
      try {
        proxySocket = await this.proxyManager.connect(proxy, cfg.host, cfg.port);
        proxySocket.on('error', () => {});
      } catch (e) {
        this._consecutiveProxyFails++;
        this.log('err', `Proxy lỗi: ${e.message} (fail ${this._consecutiveProxyFails}/${TIMING.PROXY_FAIL_THRESHOLD}) — thử kết nối thẳng`);
        if (proxySocket) { try { proxySocket.destroy(); } catch {} proxySocket = null; }
        if (this._consecutiveProxyFails >= TIMING.PROXY_FAIL_THRESHOLD) {
          this._disableProxyFallback();
        }
      }
    }
    if (this._disabled || this.isStopping) {
      if (proxySocket) { try { proxySocket.destroy(); } catch {} }
      this._onConnectComplete();
      this._setState(CS.DISCONNECTED);
      return;
    }
    try { await this._sharedPool.resolveDns(cfg.host); } catch { }
    if (proxySocket) this._sharedPool.optimizeSocket(proxySocket);
    const botOpts = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      version: cfg.version,
      respawn: false,
      hideErrors: true,
      ...(proxySocket ? { stream: proxySocket } : {}),
      noDelay: true,               
      ...(cfg.skipValidation ? { skipValidation: true } : {}),
      ...(cfg.viewDistance ? { viewDistance: cfg.viewDistance } : {}),
    };
    let mc;
    try {
      mc = mineflayer.createBot(botOpts);
    } catch (e) {
      this.log('err', 'Không tạo được bot: ' + e.message);
      if (proxySocket) { try { proxySocket.destroy(); } catch {} }
      this._onConnectComplete();
      this._setState(CS.DISCONNECTED);
      this.scheduleReconnect('createBot failed');
      return;
    }
    this.mc = mc;
    this.packetMgr.attach(mc);
    this._bindEvents(mc, proxy);
  }
  _onConnectComplete() {
    if (this._connectCompleted) return;
    this._connectCompleted = true;
    if (this._manager) this._manager._activeConnects = Math.max(0, (this._manager._activeConnects || 1) - 1);
  }
  _bindEvents(mc, proxy) {
    const { cfg, state: s } = this;
    mc.setMaxListeners(50);
    if (mc._client) mc._client.setMaxListeners(50);
    mc.once('login', () => {
      this._setState(CS.AUTHENTICATING);
      s.loginTime = nowMs();
      this.log('ok', `Đã đăng nhập → ${cfg.host}:${cfg.port}` +
        (proxy ? ` [${proxy.type}://${proxy.host}:${proxy.port}]` : ''));
      if (mc._client?.socket) {
        this._sharedPool.optimizeSocket(mc._client.socket);
      }
      if (cfg.sendClientSettings !== false && mc._client && !mc._client.ended) {
        try {
          mc._client.write('settings', cfg.clientSettings || {
            locale: 'en_US',
            viewDistance: 2,
            chatMode: 0,
            chatColors: true,
            displayedSkinParts: 255,
            mainHand: 1,
            enableTextFiltering: false,
            allowServerListings: true,
          });
          this.log('sys', 'Đã gửi client settings (vanilla profile)');
        } catch (e) {
          this.log('err', 'Lỗi settings: ' + e.message);
        }
      }
      this._setTimer('loginCmd', () => {
        if (!this.isConnected) return;
        try {
          if (!cfg.botPassword) { this._loginCmdDone = true; return; }
          if (cfg.registered === false) {
            mc.chat(`/dk ${cfg.botPassword}`);
            cfg.registered = true;
            this.log('ok', 'Đã gửi /dk');
            this._setTimer('loginDn', () => {
              if (!this.isConnected) return;
              try {
                mc.chat(`/dn ${cfg.botPassword}`);
                this.log('ok', 'Đã gửi /dn');
                this._loginCmdDone = true;
                this._startMenuIfPending();
              } catch (e) {
                this.log('err', 'Lỗi gửi /dn: ' + e.message);
                this._loginCmdDone = true;
              }
            }, rand(1500, 2500));
          } else {
            mc.chat(`/dn ${cfg.botPassword}`);
            this.log('ok', 'Đã gửi /dn');
            this._loginCmdDone = true;
            this._setTimer('loginDnDelay', () => {
              if (!this.isConnected) return;
              this._startMenuIfPending();
            }, rand(1500, 2500));
          }
        } catch (e) {
          this.log('err', 'Lỗi gửi auth cmd: ' + e.message);
        }
      }, rand(4000, 8000));
    });
    let _usedProxy = !!proxy;
    mc.on('spawn', () => {
      if (this._firstSpawn) {
        this._firstSpawn = false;
        this._onConnectComplete();
        this._setState(CS.ONLINE);
        this._spawnTime = nowMs();
        this.log('ok', 'Spawn thành công');
        if (_usedProxy && this._consecutiveProxyFails > 0) {
          this._consecutiveProxyFails = 0;
          this.log('sys', 'Proxy hoạt động — reset fail counter');
        }
        this._setTimer('stable', () => {
          if (this.isOnline) { s.reconnects = 0; this._fastKicks = 0; this._reconnectScheduled = false; this.log('sys', 'Kết nối ổn định'); }
        }, TIMING.STABLE_TIME);
        this._setTimer('poll', () => this._pollTick(),
          jit(this.settings.pollInterval, this.settings.pollJitter / 2));
        this._setTimer('healthStart', () => this._startHealthCheck(), TIMING.HEALTH_GRACE_MS);
        this._setTimer('invUpdate', () => this._updateInventory(), 3000);
        if (cfg.autoMenu && cfg.menuCommand) {
          if (!cfg.botPassword || (cfg.registered && this._loginCmdDone)) {
            this._menuRetryCount = 0;
            this._menuSuccess = false;
            this._scheduleMenuRetry();
          }
        } else {
          this._resumeIntendedStates();
        }
      } else {
        this.log('sys', 'Đã hồi sinh (respawn)');
        this._resumeIntendedStates();
      }
    });
    mc.on('death', () => {
      const d = rand(2500, 8000);
      this.log('warn', `Chết — respawn sau ${d}ms`);
      this._setTimer('respawn', () => {
        if (this.isOnline) try { mc.respawn(); } catch { }
      }, d);
    });
    mc.on('ping', p => {
      s.ping = typeof p === 'number' ? p : -1;
      this.emit('ping', { id: cfg.id, ping: s.ping });
      if (this.socketRooms?.io) {
        this.socketRooms.io.emit('ping', { id: cfg.id, ping: s.ping });
      }
    });
    mc.on('move', () => {
      if (mc.entity?.position) {
        s.position = { x: mc.entity.position.x, y: mc.entity.position.y, z: mc.entity.position.z };
      }
    });
    mc.on('health', () => {
      s.health = mc.health ?? 20;
      s.food = mc.food ?? 20;
      if (s.autoEat && mc.food !== undefined && mc.food < (this.settings.eatThreshold || 15) && !this._isEating) {
        this._eatFood().catch(() => {});
      }
      this.emit('health', { id: cfg.id, health: s.health, food: s.food });
      if (this.socketRooms?.io) {
        this.socketRooms.io.emit('health', { id: cfg.id, health: s.health, food: s.food });
      }
    });
    const scheduleInvUpdate = (delay) =>
      this._setTimer('invDebounce', () => this._updateInventory(), delay);
    mc.on('playerCollect', () => scheduleInvUpdate(500));
    mc.on('windowClose', () => scheduleInvUpdate(300));
    mc.on('setSlot', () => scheduleInvUpdate(200));
    mc.on('message', (json, pos) => {
      try {
        const text = resolveText(json?.json ?? json);
        if (!text.trim()) return;
        if (pos === 'game_info' || pos === 'action_bar') {
          this.tryChatShard(text);
          return;
        }
        this.log('chat', text);
        this.tryChatShard(text);
      } catch (e) {
        this.log('err', 'Lỗi message: ' + e.message);
      }
    });
    mc.on('messagestr', (msg, pos) => {
      try { if (pos === 'gameInfo') this.tryChatShard(msg); } catch { }
    });
    mc.on('scoreboardUpdated', () => {
      try { this._updateShard(this.readShard()); } catch { }
    });
    mc.on('windowOpen', win => {
      this._setTimer('winOpen_' + win.id, () => {
        if (!this.isOnline) return;
        try {
          const title = resolveText(win.title || '').toUpperCase();
          if (cfg.autoMenu && cfg.menuCommand && !this._menuSuccess) {
            if (title.includes('MENU') || title.includes('LOBBY') || title.includes('HUB') ||
                title.includes('CHỌN') || title.includes('KHU') || title.includes('WORLD')) {
              this._menuSuccess = true;
              this._clearTimer('menuRetry');
              this.log('ok', `Đã vào server thành công qua menu: [${title.substring(0, 40)}]`);
              WindowRouter.route(this, win);
              this._resumeIntendedStates();
              return;
            }
          }
          WindowRouter.route(this, win);
        } catch (e) {
          this.log('err', 'Lỗi windowOpen: ' + e.message);
        }
      }, jit(2000, 600));
    });
    mc.on('kicked', reason => {
      this._wasKicked = true;  
      let m = typeof reason === 'string' ? reason : resolveText(reason);
      if (!m) {
        try { m = JSON.stringify(reason).substring(0, 120); } catch { m = String(reason).substring(0, 80); }
      }
      const kickMsg = m || '(không rõ lý do)';
      this.log('warn', 'Bị kick: ' + kickMsg);
      this.emit('kicked', { id: this.cfg.id, reason: kickMsg, raw: reason });
      if (this.socketRooms?.io) {
        this.socketRooms.io.emit('kicked', { id: this.cfg.id, reason: kickMsg });
      }
    });
    mc.once('end', reason => {
      this._onConnectComplete();
      const m = typeof reason === 'string' ? reason : resolveText(reason);
      const endReason = m || 'connection ended';
      this.emit('disconnected', { id: this.cfg.id, reason: endReason });
      if (this.socketRooms?.io) {
        this.socketRooms.io.emit('botDisconnected', { id: this.cfg.id, reason: endReason });
      }
      if (_usedProxy && this._spawnTime === 0) {
        this._consecutiveProxyFails++;
        if (this._consecutiveProxyFails >= TIMING.PROXY_FAIL_THRESHOLD) {
          this._disableProxyFallback();
        }
      }
      if (this.isStopping || this.isReconnecting || !this.mc || this.mc !== mc) return;
      this.scheduleReconnect(endReason);
    });
    mc.on('error', err => {
      const m = err?.message || String(err);
      if (IGNORED_ERRORS.some(k => m.includes(k))) return;
      this.log('err', m);
      this.emit('botError', { id: this.cfg.id, error: m });
    });
  }
  _startHealthCheck() {
    this._clearTimer('health');
    this._healthProbed = false;
    const check = () => {
      if (!this.isOnline) return;
      const mc = this.mc;
      try {
        const onlineFor = this._spawnTime > 0 ? nowMs() - this._spawnTime : 0;
        if (onlineFor < TIMING.HEALTH_GRACE_MS) return;
        const client = mc?._client;
        const socketAlive = client && !client.ended && (
          (client.socket && !client.socket.destroyed && client.socket.writable) ||
          (client.stream && !client.stream.destroyed && client.stream.writable)
        );
        const packetAge = this.packetMgr.lastPacketAt ? nowMs() - this.packetMgr.lastPacketAt : Infinity;
        const halfTimeout = this._packetTimeout / 2;
        if (!socketAlive && packetAge > 15000) {
          this.log('health', 'Socket chết + không packet — reconnect');
          this.scheduleReconnect('socket dead');
          return;
        }
        if (packetAge > this._packetTimeout) {
          this.log('health', `Không nhận packet trong ${Math.round(packetAge / 1000)}s — reconnect`);
          this.scheduleReconnect('packet timeout');
          return;
        }
        if (packetAge > halfTimeout && socketAlive && !this._healthProbed) {
          this._healthProbed = true;
          this.log('health', `Không packet ${Math.round(packetAge / 1000)}s — gửi probe...`);
          try {
            if (mc._client && !mc._client.ended) {
              if (this.cfg.sendClientSettings !== false && mc._client && !mc._client.ended) {
                mc._client.write('settings', {
                  locale: 'en_US',
                  viewDistance: 2,
                  chatMode: 0,
                  chatColors: true,
                  displayedSkinParts: 255,
                  mainHand: 1,
                  enableTextFiltering: false,
                  allowServerListings: true,
                });
              } else {
                mc._client.write('tab_complete', { text: '/', assumeCommand: false });
              }
            }
          } catch (e) {
            this.log('health', 'Probe thất bại: ' + e.message);
          }
          return; 
        }
        if (packetAge > halfTimeout && this._healthProbed) {
          this.log('health', `Đã probe nhưng không phản hồi sau ${Math.round(packetAge / 1000)}s — reconnect`);
          this.scheduleReconnect('no response to probe');
          return;
        }
        if (packetAge < halfTimeout) {
          this._healthProbed = false;
        }
        if (!mc?.entity && onlineFor > this._entityTimeout && packetAge > 30000) {
          this.log('health', `Entity null sau ${Math.round(onlineFor / 1000)}s + không packet — reconnect`);
          this.scheduleReconnect('entity null + no packets');
          return;
        }
      } catch (e) {
        this.log('err', 'Lỗi health check: ' + e.message);
      }
    };
    this._setTimer('health', check, jit(TIMING.HEALTH_INTERVAL, TIMING.HEALTH_JITTER), true);
  }
  _pollTick() {
    if (!this.isOnline) return;
    this._updateShard(this.readShard());
    this._updateInventory();
    this._setTimer('poll', () => this._pollTick(),
      jit(this.settings.pollInterval, this.settings.pollJitter));
  }
  _startAutoStats() {
    this._clearTimer('autoStatsLoop');
    const loop = () => {
      if (!this.isOnline || !this.state.autoStats) return;
      try { this.mc.chat('/stats'); } catch (e) {
        this.log('err', 'Auto stats lỗi: ' + e.message);
      }
      this._setTimer('autoStatsLoop', loop, 60000);
    };
    this._setTimer('autoStatsLoop', loop, 5000);
  }
  _startAutoShard() {
    this._clearTimer('autoShardLoop');
    const loop = () => {
      if (!this.isOnline || !this.state.autoShard) return;
      try {
        const n = this.readShard();
        if (n !== null) this._updateShard(n);
      } catch (e) {
        this.log('err', 'Auto shard lỗi: ' + e.message);
      }
      this._setTimer('autoShardLoop', loop, 30000);
    };
    this._setTimer('autoShardLoop', loop, 3000);
  }
  _resumeIntendedStates() {
    if (!this.isOnline) return;
    if (this.state.intendedAfk) {
      this._setTimer('resumeAfk', () => {
        if (!this.isOnline) return;
        if (this.state.intendedAfk === 'jump') this.afkJump();
        else if (this.state.intendedAfk === 'walk') this.afkWalk();
        this.log('sys', `Đã tự động khôi phục AFK: ${this.state.intendedAfk}`);
      }, 3000);
    }
    if (this.state.tshard) {
      this._setTimer('resumeTshard', () => {
        if (!this.isOnline || !this.state.tshard) return;
        try {
          this.mc.chat('/warp afk');
          this.log('sys', 'Tự động gửi /warp afk (Treo Shard)');
        } catch (e) {
          this.log('err', 'Lỗi tự động Treo Shard: ' + e.message);
        }
      }, 5000);
    }
    if (this.state.autoStats) this._startAutoStats();
    if (this.state.autoShard) this._startAutoShard();
  }
  _startMenuIfPending() {
    if (!this.isOnline || this._menuSuccess) return;
    if (!this.cfg.autoMenu || !this.cfg.menuCommand) return;
    if (!this._loginCmdDone) return;
    this.log('sys', 'Login hoàn tất — bắt đầu menu retry...');
    this._menuRetryCount = 0;
    this._menuSuccess = false;
    this._scheduleMenuRetry();
  }
  _scheduleMenuRetry() {
    const MAX_MENU_RETRIES = 100;
    const BASE_DELAY = 8000;
    const retry = () => {
      if (!this.isOnline || this._menuSuccess || this._disabled) return;
      if (this._menuRetryCount >= MAX_MENU_RETRIES) {
        this.log('warn', `Đã thử menu ${MAX_MENU_RETRIES} lần — dừng`);
        return;
      }
      this._menuRetryCount++;
      const delay = this._menuRetryCount <= 3 ? BASE_DELAY : jit(BASE_DELAY * 2, 3000);
      this.log('sys', `Gửi menu lần ${this._menuRetryCount}: ${this.cfg.menuCommand}`);
      try {
        this.mc.chat(this.cfg.menuCommand);
      } catch (e) {
        this.log('err', 'Lỗi gửi menu: ' + e.message);
      }
      if (!this._menuSuccess) {
        this._setTimer('menuRetry', retry, delay);
      }
    };
    this._setTimer('menuRetry', retry, rand(5000, 8000));
  }
  readShard() {
    const mc = this.mc;
    if (!mc?.scoreboards) return null;
    try {
      for (const name in mc.scoreboards) {
        const sb = mc.scoreboards[name];
        if (!sb?.itemsMap) continue;
        for (const entry in sb.itemsMap) {
          let parts = [entry];
          if (mc.teamMap) {
            const team = Object.values(mc.teamMap).find(t => t.members?.includes(entry));
            if (team) parts = [resolveText(team.prefix), entry, resolveText(team.suffix)];
          }
          if (sb.itemsMap[entry]?.displayName) {
            parts.push(resolveText(sb.itemsMap[entry].displayName));
          }
          const n = parseShardNum(parts.join(' '));
          if (n !== null) {
            this.log('shard', 'Scoreboard → ' + n.toLocaleString());
            return n;
          }
        }
      }
    } catch (e) {
      this.log('err', 'Lỗi scoreboard: ' + e.message);
    }
    return null;
  }
  tryChatShard(raw) {
    try {
      const text = typeof raw === 'string' ? raw : resolveText(raw);
      const n = parseShardNum(text);
      if (n !== null) this._updateShard(n);
    } catch { }
  }
  afkJump() {
    this._clearTimer('afk');
    this._clearTimer('wafk');
    this.state.afk = 'jump';
    this.state.intendedAfk = 'jump';
    const mc = this.mc;
    const tick = () => {
      if (!this.isOnline || this.state.afk !== 'jump') return;
      try {
        mc.setControlState('jump', true);
        this._setTimer('afkJumpOff', () => {
          try { if (this.isOnline) mc.setControlState('jump', false); } catch { }
        }, rand(100, 450));
        if (Math.random() < 0.30) {
          const yaw = (mc.entity?.yaw || 0) + (Math.random() - 0.5) * 1.0;
          const pitch = (mc.entity?.pitch || 0) + (Math.random() - 0.5) * 0.4;
          mc.look(yaw, clamp(pitch, -1.4, 1.4), true);
        }
        if (Math.random() < 0.06) mc.swingArm();
        if (Math.random() < 0.03) {
          mc.setControlState('sneak', true);
          this._setTimer('afkSneak', () => {
            try { if (this.isOnline) mc.setControlState('sneak', false); } catch { }
          }, rand(300, 900));
        }
        if (Math.random() < 0.02 && mc._client) {
          try { mc._client.write('tab_complete', { text: '/', assumeCommand: false }); } catch { }
        }
        if (Math.random() < 0.03) {
          try { mc.setQuickBarSlot(rand(0, 8)); } catch { }
        }
      } catch (e) {
        this.log('err', 'AFK jump lỗi: ' + e.message);
      }
      this._setTimer('afk', tick, jit(4800, 2000));
    };
    this._setTimer('afk', tick, jit(700, 200));
    this.log('afk', 'Jump AFK bật');
    this.emit('afk', { id: this.cfg.id, mode: 'jump' });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('afk', { id: this.cfg.id, mode: 'jump' });
    }
  }
  afkWalk() {
    this._clearTimer('afk');
    this._clearTimer('wafk');
    this.state.afk = 'walk';
    this.state.intendedAfk = 'walk';
    const mc = this.mc;
    let yaw = mc.entity?.yaw || 0;
    let dir = 1;
    let step = 0;
    let lastPos = null;
    let stuckTicks = 0;
    const tick = () => {
      if (!this.isOnline || this.state.afk !== 'walk') return;
      try {
        if (Math.random() < 0.06) dir = -dir;
        yaw += rand(2, 10) * 0.09 * dir;
        mc.look(yaw, (Math.random() - 0.5) * 0.25, true);
        if (++step > rand(8, 20)) {
          step = 0;
          const keys = ['forward', 'back', 'left', 'right'];
          const k = keys[rand(0, 3)];
          mc.setControlState(k, true);
          this._setTimer('wafkKey', () => {
            try { if (this.isOnline) mc.setControlState(k, false); } catch { }
          }, rand(200, 950));
        }
        if (Math.random() < 0.04) {
          mc.setControlState('jump', true);
          this._setTimer('wafkJump', () => {
            try { if (this.isOnline) mc.setControlState('jump', false); } catch { }
          }, rand(100, 300));
        }
        if (Math.random() < 0.05) mc.swingArm();
        if (Math.random() < 0.02 && mc._client) {
          try { mc._client.write('tab_complete', { text: '/', assumeCommand: false }); } catch { }
        }
        if (Math.random() < 0.03) {
          try { mc.setQuickBarSlot(rand(0, 8)); } catch { }
        }
        const currPos = mc.entity?.position;
        if (lastPos && currPos) {
          const dist = Math.sqrt(
            Math.pow(currPos.x - lastPos.x, 2) +
            Math.pow(currPos.y - lastPos.y, 2) +
            Math.pow(currPos.z - lastPos.z, 2)
          );
          if (dist < 0.1) {
            stuckTicks++;
            if (stuckTicks > 4) { dir = -dir; yaw += Math.PI; stuckTicks = 0; }
          } else {
            stuckTicks = 0;
          }
        }
        if (currPos) lastPos = { x: currPos.x, y: currPos.y, z: currPos.z };
      } catch (e) {
        this.log('err', 'AFK walk lỗi: ' + e.message);
      }
      this._setTimer('wafk', tick, jit(480, 150));
    };
    this._setTimer('wafk', tick, jit(400, 100));
    this.log('afk', 'Walk AFK bật');
    this.emit('afk', { id: this.cfg.id, mode: 'walk' });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('afk', { id: this.cfg.id, mode: 'walk' });
    }
  }
  afkStop() {
    this._clearTimer('afk');
    this._clearTimer('wafk');
    this._clearTimer('afkJumpOff');
    this._clearTimer('afkSneak');
    this._clearTimer('wafkKey');
    this._clearTimer('wafkJump');
    this._clearTimer('resumeAfk');
    try {
      if (this.mc?.entity) {
        for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) {
          this.mc.setControlState(k, false);
        }
      }
    } catch { }
    this.state.afk = null;
    this.state.intendedAfk = null;
    this.log('sys', 'AFK đã dừng');
    this.emit('afk', { id: this.cfg.id, mode: null });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('afk', { id: this.cfg.id, mode: null });
    }
  }
  static FOODS = [
    'golden_apple', 'enchanted_golden_apple', 'cooked_beef', 'cooked_porkchop',
    'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_salmon',
    'cooked_cod', 'steak', 'porkchop', 'mutton', 'beef', 'chicken',
    'rabbit', 'salmon', 'cod', 'bread', 'apple', 'mushroom_stew',
    'beetroot_soup', 'rabbit_stew', 'suspicious_stew', 'carrot',
    'baked_potato', 'potato', 'pumpkin_pie', 'cookie', 'melon_slice',
    'dried_kelp', 'sweet_berries', 'glow_berries', 'chorus_fruit',
    'tropical_fish', 'honey_bottle',
  ];
  async _eatFood() {
    if (this._isEating || !this.mc?.entity) return;
    const mc = this.mc;
    try {
      const items = mc.inventory.items();
      if (!items.length) return;
      let foodItem = null;
      for (const name of BotSession.FOODS) {
        foodItem = items.find(i => i.name === name);
        if (foodItem) break;
      }
      if (!foodItem) {
        this.log('warn', 'Không tìm thấy thức ăn trong túi!');
        return;
      }
      this._isEating = true;
      await mc.equip(foodItem, 'hand');
      await mc.consume();
      this.log('ok', `Đã ăn: ${(foodItem.name || '?').replace(/_/g, ' ')}`);
    } catch (e) {
      this.log('err', 'Lỗi khi ăn: ' + (e?.message || String(e)));
    } finally {
      this._isEating = false;
    }
  }
  hardReset() {
    this.log('sys', 'Hard reset initiated...');
    this.cancelReconnect();
    this._cleanupOnDisconnect();
    this._onConnectComplete();
    this._destroyMc();
    this.state.reconnects = 0;
    this._fastKicks = 0;
    this._menuRetryCount = 0;
    this._menuSuccess = false;
    this._connectCompleted = false;
    this._disabled = false;
    this._isEating = false;
    this._lastReconnectTime = 0;
    this._reconnectTimestamps = [];
    this._healthProbed = false;
    this._consecutiveProxyFails = 0;
    this._proxyDisabledByFallback = false;
    this._setState(CS.DISCONNECTED);
    this.log('sys', 'Hard reset — khởi động lại sau 1.5s...');
    this._setTimer('hard_reset_start', () => {
      this.start();
    }, 1500);
  }
  shutdown() {
    this._disabled = true;
    this._setState(CS.STOPPING);
    this._cleanupOnDisconnect();
    this._onConnectComplete();
    try { this.afkStop(); } catch { }
    this._destroyMc();
    this._setState(CS.DISCONNECTED);
    this.log('sys', 'Bot đã tắt');
  }
  cmd(input) {
    const trimmed = String(input).trim();
    const parts = trimmed.split(/\s+/);
    const key = parts[0].toLowerCase();
    if (this.cmdRegistry._customCommands.has(key)) {
      if (!this.isOnline) {
        this.log('warn', 'Bot offline — không gửi được chat');
        return;
      }
      try {
        const c = this.cmdRegistry._customCommands.get(key);
        this.mc.chat(c.startsWith('/') ? c : `/${c}`);
        this.log('sys', `Custom cmd "${key}" → ${c}`);
      } catch (e) {
        this.log('err', 'Lỗi custom cmd: ' + e.message);
      }
      return;
    }
    if (!this.cmdRegistry.run(trimmed)) {
      if (!this.isOnline) {
        this.log('warn', 'Bot offline — không gửi được chat');
        return;
      }
      try {
        this.mc.chat(trimmed.startsWith('/') ? trimmed : `/${trimmed}`);
      } catch (e) {
        this.log('err', 'Lỗi gửi chat: ' + e.message);
      }
    }
  }
  _registerCommands() {
    const r = this.cmdRegistry;
    r.register('shard', 'Bật/Tắt Auto Shard', () => {
      if (!this.requireOnline('shard')) return;
      this.state.autoShard = !this.state.autoShard;
      this.log('sys', `Tự động đọc Shard: ${this.state.autoShard ? 'BẬT' : 'TẮT'}`);
      if (this.state.autoShard) this._startAutoShard();
      else this._clearTimer('autoShardLoop');
    });
    r.register('stats', 'Bật/Tắt Auto Stats', () => {
      if (!this.requireOnline('stats')) return;
      this.state.autoStats = !this.state.autoStats;
      this.log('sys', `Tự động stats: ${this.state.autoStats ? 'BẬT' : 'TẮT'}`);
      if (this.state.autoStats) this._startAutoStats();
      else this._clearTimer('autoStatsLoop');
    });
    r.register('tshard', 'Gửi /warp afk (Treo Shard)', () => {
      if (!this.requireOnline('tshard')) return;
      try { this.mc.chat('/warp afk'); this.log('sys', 'Đã gửi /warp afk'); }
      catch (e) { this.log('err', e.message); }
    });
    r.register('afk', 'Bật/Tắt AFK jump', () => {
      if (!this.requireOnline('afk')) return;
      if (this.state.afk === 'jump') this.afkStop();
      else this.afkJump();
    });
    r.register('wafk', 'Bật/Tắt AFK walk', () => {
      if (!this.requireOnline('wafk')) return;
      if (this.state.afk === 'walk') this.afkStop();
      else this.afkWalk();
    });
    r.register('stop', 'Dừng AFK', () => this.afkStop());
    r.register('autoeat', 'Bật/Tắt Tự động ăn', () => {
      if (!this.requireOnline('autoeat')) return;
      this.state.autoEat = !this.state.autoEat;
      this.log('sys', `Tự động ăn: ${this.state.autoEat ? 'BẬT' : 'TẮT'} (ngưỡng: ${this.settings.eatThreshold || 15})`);
    });
    r.register('tpa', 'TPA tới owner (tự click đồng ý)', () => {
      if (!this.requireOnline('tpa')) return;
      const TPA_CONFIRM_SLOT = 16;  
      const TPA_GUI_TIMEOUT = 10000; 
      try {
        this.mc.chat(`/tpa ${this.cfg.ownerUsername}`);
        this.log('sys', `TPA → ${this.cfg.ownerUsername} — chờ GUI xác nhận...`);
      } catch (e) { this.log('err', e.message); return; }
      let tpaGuiTimer = null;
      const onTpaWindow = (win) => {
        if (tpaGuiTimer) { clearTimeout(tpaGuiTimer); tpaGuiTimer = null; }
        this.mc.removeListener('windowOpen', onTpaWindow);
        this._setTimer('tpaConfirm', () => {
          if (!this.isOnline) return;
          try {
            if (!win.slots || win.slots.length <= TPA_CONFIRM_SLOT) {
              this.log('warn', `GUI TPA không đủ slot (có ${win.slots?.length ?? 0}, cần >${TPA_CONFIRM_SLOT})`);
              try { this.mc.closeWindow(win); } catch { }
              return;
            }
            const sl = win.slots[TPA_CONFIRM_SLOT];
            const slotName = sl ? resolveText(sl.customName || sl.displayName || sl.name || '') : '(trống)';
            this.mc.clickWindow(TPA_CONFIRM_SLOT, 0, 0);
            this.log('ok', `Đã click slot ${TPA_CONFIRM_SLOT + 1} (ô thứ ${TPA_CONFIRM_SLOT + 1}): "${slotName}" — Đồng ý TPA`);
          } catch (e) { this.log('err', 'Lỗi click TPA GUI: ' + e.message); }
        }, jit(1800, 500));
      };
      this.mc.once('windowOpen', onTpaWindow);
      tpaGuiTimer = setTimeout(() => {
        if (this.mc) this.mc.removeListener('windowOpen', onTpaWindow);
        this.log('warn', 'TPA: GUI xác nhận không xuất hiện sau 10s');
      }, TPA_GUI_TIMEOUT);
    });
    r.register('ping', 'Hiện ping', () => {
      this.log('sys', `Ping: ${this.state.ping >= 0 ? this.state.ping + 'ms' : 'N/A'}`);
    });
    r.register('pos', 'Hiện tọa độ', () => {
      const p = this.state.position;
      if (!p) { this.log('warn', 'Chưa có tọa độ'); return; }
      this.log('sys', `Vị trí: X=${p.x?.toFixed(2)} Y=${p.y?.toFixed(2)} Z=${p.z?.toFixed(2)}`);
    });
    r.register('inv', 'Xem inventory', () => {
      this._updateInventory();
      const inv = this.state.inventory;
      if (!inv.length) { this.log('warn', 'Túi đồ trống'); return; }
      inv.forEach(item => this.log('sys', `[${item.slot}] ${item.name} x${item.count}`));
    });
    r.register('status', 'Hiện trạng thái', () => this.emit('status'));
    r.register('reconnect', 'Force reconnect', () => this.forceReconnect());
    r.register('menu', 'Gửi menu command thủ công', () => {
      if (!this.requireOnline('menu')) return;
      if (!this.cfg.menuCommand) { this.log('warn', 'Chưa có menuCommand'); return; }
      try {
        this.mc.chat(this.cfg.menuCommand);
        this.log('sys', `Gửi menu: ${this.cfg.menuCommand}`);
      } catch (e) { this.log('err', e.message); }
    });
    r.register('addcmd', 'Thêm custom command: addcmd <tên> <lệnh MC>', (args) => {
      if (args.length < 2) { this.log('warn', 'Cú pháp: addcmd <tên> <lệnh>'); return; }
      const name = args[0].toLowerCase();
      const cmd = args.slice(1).join(' ');
      this.cmdRegistry.addCustom(name, cmd);
      this.log('ok', `Đã thêm lệnh "${name}" → "${cmd}"`);
    });
    r.register('delcmd', 'Xóa custom command: delcmd <tên>', (args) => {
      if (!args[0]) { this.log('warn', 'Cú pháp: delcmd <tên>'); return; }
      const name = args[0].toLowerCase();
      if (this.cmdRegistry.deleteCustom(name)) {
        this.log('ok', `Đã xóa lệnh "${name}"`);
      } else {
        this.log('warn', `Không tìm thấy lệnh "${name}"`);
      }
    });
    r.register('listcmd', 'Xem danh sách custom commands', () => {
      const cmds = this.cmdRegistry.getCustomCmds();
      if (!cmds.length) { this.log('sys', 'Chưa có custom command nào'); return; }
      cmds.forEach(c => this.log('sys', `  ${c.name} → ${c.cmd}`));
    });
  }
  getSummary() {
    const s = this.state;
    const pm = this.packetMgr;
    return {
      id: this.cfg.id,
      username: this.cfg.username,
      host: this.cfg.host,
      port: this.cfg.port,
      version: this.cfg.version,
      state: s.connState,
      afk: s.afk,
      shard: s.shard,
      ping: s.ping,
      reconnects: s.reconnects,
      health: s.health,
      food: s.food,
      position: s.position,
      tshard: s.tshard,
      autoStats: s.autoStats,
      autoShard: s.autoShard,
      autoEat: s.autoEat,
      eatThreshold: this.settings.eatThreshold || 15,
      proxy: this.proxy ? `${this.proxy.type}://${this.proxy.host}:${this.proxy.port}` : null,
      proxyId: this.proxy?.id || null,
      ppsIn: pm?.ppsIn ?? 0,
      ppsOut: pm?.ppsOut ?? 0,
      lastPacket: pm?.lastPacketAt ?? null,
      loginTime: s.loginTime,
      menuRetries: this._menuRetryCount ?? 0,
      menuSuccess: this._menuSuccess ?? false,
      registered: this.cfg.registered,
      cfg: {
        autoMenu: this.cfg.autoMenu,
        menuCommand: this.cfg.menuCommand,
        respawn: this.cfg.respawn,
        ownerUsername: this.cfg.ownerUsername,
        useProxy: this.cfg.useProxy,
        autoEat: this.state.autoEat,
      },
    };
  }
}
module.exports = BotSession;
