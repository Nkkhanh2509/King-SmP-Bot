'use strict';
const { DEFAULTS } = require('./constants');
const { resolveText, parseShardNum, safeJsonStringify, jit, nowMs } = require('./utils');
const WindowRouter = {
  _routes: [],
  _guiTimeout: 30000,
  register(name, matcher, handler) {
    this._routes.push({ name, matcher, handler });
  },
  route(bot, win) {
    const title = resolveText(win.title || '').toUpperCase();
    bot._clearTimer('windowTimeout');
    bot._setTimer('windowTimeout', () => {
      if (!bot.isOnline) return;
      bot.log('warn', `GUI timeout sau ${this._guiTimeout / 1000}s ở window: [${title.substring(0, 40)}] — đóng GUI`);
      try { bot.mc.closeWindow(win); } catch {}
    }, this._guiTimeout);
    let handled = false;
    for (const route of this._routes) {
      try {
        if (route.matcher(title, win)) {
          bot._clearTimer('windowTimeout');
          route.handler(bot, win);
          handled = true;
          bot.log('sys', `WindowRouter: matched [${route.name}] for [${title.substring(0, 40)}]`);
          return;
        }
      } catch (e) {
        bot.log('err', `WindowRouter lỗi route ${route.name}: ${e.message}`);
      }
    }
    if (!handled) {
      bot._clearTimer('windowTimeout');
      this._handleUnknown(bot, win, title);
    }
  },
  _handleUnknown(bot, win, title) {
    if (!title || !title.trim()) {
      if (bot.cfg.autoMenu && bot.cfg.menuCommand && !bot._menuSuccess) {
        bot.log('sys', 'WindowRouter: GUI rỗng (đang menu retry) — fall-through xử lý');
      } else {
        bot.log('sys', 'WindowRouter: GUI rỗng — đóng ngay');
        try { bot.mc.closeWindow(win) } catch {}
        return;
      }
    }
    bot.log('sys', `WindowRouter: unknown GUI [${title.substring(0, 40)}] — fallback xử lý`);
    const _firstItem = win.slots?.find(s => s)
    const _firstInfo = _firstItem
      ? `item[0]=${_firstItem.name || '?'}:${resolveText(_firstItem.customName || _firstItem.displayName || '').substring(0, 40) || '?'} x${_firstItem.count || 1}`
      : 'no items'
    bot.log('sys', `GUI debug: title="${title.substring(0, 50)}" slots=${win.slots?.length || 0} type=${win.type || '?'} ${_firstInfo}`)
    const slot = bot.settings.kingSmpSlot || DEFAULTS.kingSmpSlot;
    if (win.slots?.length > slot && win.slots[slot]) {
      const isMenu = /menu|kingsmp|mở rộng|gui/i.test(title);
      if (isMenu || bot.cfg.autoMenu) {
        bot._menuSuccess = true;
        bot.mc.clickWindow(slot, 0, 0);
        bot.log('sys', `Click slot ${slot} trong [${title}]`);
        bot._resumeIntendedStates();
      } else {
        bot.mc.closeWindow(win);
      }
    } else {
      bot.mc.closeWindow(win);
    }
  },
};
WindowRouter.register('STATS_WINDOW',
  t => t.includes('STATS') || t.includes('THỐNG KÊ'),
  (bot, win) => StatsParser.parse(bot, win),
);
const StatsParser = {
  _extractNum(sl) {
    if (!sl) return 0;
    if (sl.customLore) {
      try {
        const s = safeJsonStringify(sl.customLore);
        const m = s.match(/"text":\{"type":"string","value":"([^"]*\d[^"]*)"\}/);
        if (m) { const n = parseInt(m[1].replace(/[^\d]/g, ''), 10); if (n > 0) return n; }
        const m2 = s.match(/(\d{3,})/); if (m2) { const n = parseInt(m2[1], 10); if (n > 0) return n; }
        const m3 = s.match(/"text"\s*:\s*"([^"]*)"/);
        if (m3) { const p = parseShardNum(m3[1]); if (p !== null && p > 0) return p; }
      } catch { }
    }
    if (sl.nbt) {
      try {
        const s = safeJsonStringify(sl.nbt);
        const m = s.match(/(\d{4,})/);
        if (m) { const n = parseInt(m[1], 10); if (n > 0) return n; }
      } catch { }
    }
    const nameText = resolveText(sl.customName || sl.displayName || '');
    const p = parseShardNum(nameText);
    if (p !== null && p > 0) return p;
    return sl.count || 0;
  },
  parse(bot, win) {
    try {
      let shard = 0, money = 0;
      for (const sl of win.slots) {
        if (!sl) continue;
        const type = (sl.type || '').toLowerCase();
        const name = resolveText(sl.customName || sl.displayName || '').toLowerCase();
        if (type.includes('amethyst') || name.includes('amethyst')) { shard = this._extractNum(sl); }
        if (type.includes('emerald') || name.includes('emerald')) { money = this._extractNum(sl); }
      }
      const entity = bot.mc?.entity;
      const health = entity ? Math.ceil((entity.health || 20) / 2) : 0;
      const pos = entity?.position;
      const elapsed = bot.state.loginTime ? Math.floor((nowMs() - bot.state.loginTime) / 1000) : 0;
      const hours = Math.floor(elapsed / 3600);
      const minutes = Math.floor((elapsed % 3600) / 60);
      const seconds = elapsed % 60;
      bot.emit('stats', {
        shard, money, health,
        x: pos?.x?.toFixed(2) ?? '?',
        y: pos?.y?.toFixed(2) ?? '?',
        z: pos?.z?.toFixed(2) ?? '?',
        uptimeHours: hours, uptimeMinutes: minutes, uptimeSeconds: seconds,
      });
      if (shard > 0) bot._updateShard(shard);
    } catch (e) {
      bot.log('err', 'Lỗi StatsParser: ' + e.message);
    }
  },
};
const AfkGuiHandler = {
  handle(bot, win) {
    try {
      const max = Math.min(bot.settings.afkGuiSlots || 15, win.slots.length);
      for (let i = 0; i < max; i++) {
        const sl = win.slots[i];
        if (!sl || AfkGuiHandler._isFull(sl)) {
          if (sl) bot.log('warn', `Khu AFK #${i + 1} đầy`);
          continue;
        }
        bot.mc.clickWindow(i, 0, 0);
        bot.log('ok', `Đã chọn khu AFK #${i + 1}`);
        return;
      }
      bot.log('warn', 'Tất cả khu AFK đầy — đóng GUI');
      bot.mc.closeWindow(win);
    } catch (e) {
      bot.log('err', 'Lỗi AfkGuiHandler: ' + e.message);
    }
  },
  _isFull(sl) {
    const pieces = [resolveText(sl.customName || sl.displayName || '')];
    if (sl.customLore) try { pieces.push(safeJsonStringify(sl.customLore)); } catch { }
    if (sl.nbt) try { pieces.push(safeJsonStringify(sl.nbt)); } catch { }
    const text = pieces.join(' ');
    if (/ĐẦY|HẾT\s*CHỖ|FULL|MAX(?:IMUM)?|KHÓA|KHÔNG\s*THỂ|ĐANG\s*ĐẦY|ĐÃ\s*ĐẦY|QUÁ\s*TẢI/i.test(text)) return true;
    const m = text.match(/(\d+)\s*\/\s*(\d+)/);
    return !!(m && parseInt(m[1], 10) >= parseInt(m[2], 10));
  },
};
WindowRouter.registerAfkRoute = function (keyword) {
  WindowRouter.register('AFK_WINDOW',
    t => t.includes(keyword.toUpperCase()),
    (bot, win) => AfkGuiHandler.handle(bot, win),
  );
};
WindowRouter.register('TPA_WINDOW',
  t => t.includes('/TPA') || t.includes('TPA'),
  (bot, win) => {
    bot._setTimer('tpaConfirm', () => {
      if (!bot.isOnline) return;
      try {
        let foundSlot = -1;
        for (let i = 0; i < win.slots.length; i++) {
          const sl = win.slots[i];
          if (sl) {
            const name = (sl.name || '').toLowerCase();
            const disp = resolveText(sl.customName || sl.displayName || '').toLowerCase();
            if (name.includes('green_stained_glass_pane') ||
                (name.includes('glass') && name.includes('green')) ||
                disp.includes('xanh lá') ||
                disp.includes('green stained glass')) {
              foundSlot = i;
              break;
            }
          }
        }
        if (foundSlot !== -1) {
          const sl = win.slots[foundSlot];
          const slotName = sl ? resolveText(sl.customName || sl.displayName || sl.name || '') : '(trống)';
          bot.mc.clickWindow(foundSlot, 0, 0);
          bot.log('ok', `GUI TPA: Đã click slot ${foundSlot + 1}: "${slotName}" — Đồng ý TPA`);
        } else {
          bot.log('warn', 'GUI TPA: Không tìm thấy kính màu xanh lá để click');
          bot.mc.closeWindow(win);
        }
      } catch (e) {
        bot.log('err', 'Lỗi xử lý GUI TPA: ' + e.message);
      }
    }, jit(1800, 500));
  },
);
WindowRouter.registerAfkRoute(DEFAULTS.afkGuiKeyword);
module.exports = { WindowRouter, StatsParser, AfkGuiHandler };
