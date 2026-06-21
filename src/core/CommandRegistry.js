'use strict';
class CommandRegistry {
  constructor(bot) {
    this.bot = bot;
    this._commands = new Map();
    this._customCommands = new Map();
  }
  register(name, desc, fn) {
    this._commands.set(name.toLowerCase(), { name, desc, fn });
  }
  addCustom(name, cmd) {
    this._customCommands.set(name.toLowerCase(), cmd);
  }
  deleteCustom(name) {
    return this._customCommands.delete(name.toLowerCase());
  }
  getCustomCmds() {
    const out = [];
    for (const [name, cmd] of this._customCommands) {
      out.push({ name, cmd });
    }
    return out;
  }
  run(input) {
    const trimmed = String(input).trim();
    const parts = trimmed.split(/\s+/);
    const key = parts[0].toLowerCase();
    if (this._customCommands.has(key)) {
      try {
        const c = this._customCommands.get(key);
        this.bot.log('sys', `Custom cmd "${key}" → ${c}`);
        return 'custom';
      } catch (e) {
        this.bot.log('err', `Lỗi custom cmd "${key}": ${e.message}`);
        return 'custom';
      }
    }
    const entry = this._commands.get(key);
    if (entry) {
      try {
        entry.fn(parts.slice(1));
      } catch (e) {
        this.bot.log('err', `Lỗi lệnh "${key}": ${e.message}`);
      }
      return 'system';
    }
    return false;
  }
  list() {
    return [...this._commands.values()].map(c => ({ name: c.name, desc: c.desc }));
  }
}
module.exports = CommandRegistry;
