'use strict';
exports.CS = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  AUTHENTICATING: 'AUTHENTICATING',
  SPAWNING: 'SPAWNING',
  ONLINE: 'ONLINE',
  RECONNECTING: 'RECONNECTING',
  STOPPING: 'STOPPING',
});
exports.TIMING = {
  RECONNECT_DELAYS: [1000, 2000, 5000, 10000, 20000, 30000, 60000],
  MAX_RECONNECT: 10,
  STABLE_TIME: 30000,
  HEALTH_INTERVAL: 30000,
  HEALTH_JITTER: 6000,
  HEALTH_GRACE_MS: 60000,
  PROXY_TIMEOUT: 8000,
  PACKET_TIMEOUT: 120000,
  ENTITY_TIMEOUT: 90000,
  MAX_CONCURRENT_CONNECTS: 5,
  CONNECT_STAGGER_MS: 250,
  FAST_KICK_EXTRA_MS: 3000,
  FAST_KICK_EXTRA_MAX: 30000,
  RECONNECT_COOLDOWN_MS: 15000,
  RECONNECT_COOLDOWN_KICK_MS: 5000,  
  RECONNECT_MAX_IN_WINDOW: 5,
  RECONNECT_WINDOW_MS: 300000,
  PROXY_FAIL_THRESHOLD: 3,       
};
exports.IGNORED_ERRORS = [
  'PartialReadError', 'packet_world_particles', 'ECONNRESET', 'EPIPE',
  'Cannot read properties of null', 'read ECONNRESET', 'socket hang up',
  'write after end', 'This socket has been ended', 'ECONNREFUSED',
];
exports.DEFAULTS = {
  pollInterval: 45000,
  pollJitter: 10000,
  shardItemSlot: 1,
  kingSmpSlot: 24,
  afkGuiKeyword: 'KHU AFK',
  afkGuiSlots: 15,
  webPort: 3000,
};
exports.MAX_LOG_PER_BOT = 800;
exports.CAPACITY = {
  RAM_PER_BOT_IDLE_MB: 4,
  RAM_PER_BOT_AFK_MB: 6,
  RAM_PER_BOT_ACTIVE_MB: 10,
  RESERVED_SYSTEM_MB: 256,
  RESERVED_OS_MB: 512,
  WARN_THRESHOLD_PCT: 75,
};
exports.THEMES = {
  teal:   { border: [0, 200, 180],   accent: [0, 225, 150],   gA: [0, 220, 180],   gB: [80, 160, 255]  },
  blue:   { border: [70, 150, 255],  accent: [120, 185, 255], gA: [60, 140, 255],  gB: [120, 225, 255] },
  purple: { border: [150, 100, 230], accent: [195, 145, 255], gA: [150, 100, 230], gB: [255, 120, 210] },
  pink:   { border: [230, 110, 180], accent: [255, 150, 205], gA: [255, 120, 190], gB: [255, 190, 120] },
  green:  { border: [60, 200, 110],  accent: [105, 238, 155], gA: [60, 220, 140],  gB: [175, 255, 80]  },
  gold:   { border: [230, 190, 60],  accent: [255, 218, 95],  gA: [255, 205, 60],  gB: [255, 150, 60]  },
};
exports.TNAMES = Object.keys(exports.THEMES);
exports.pickTheme = (name, i) => {
  const n = (name && exports.THEMES[name]) ? name : exports.TNAMES[((i % exports.TNAMES.length) + exports.TNAMES.length) % exports.TNAMES.length];
  return { name: n, ...exports.THEMES[n] };
};
exports.TABLE_CHARS = {
  'top': '─', 'top-mid': '┬', 'top-left': '╭', 'top-right': '╮',
  'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '╰', 'bottom-right': '╯',
  'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
  'right': '│', 'right-mid': '┤', 'middle': '│',
};
