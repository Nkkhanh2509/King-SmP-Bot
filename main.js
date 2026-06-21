'use strict';
const http = require('http');
const path = require('path');
const chalk = require('chalk');
const BotManager = require('./src/services/BotManager');
let config;
try {
  config = require('./config.json');
} catch {
  config = {};
}
const AUTO_EXE = process.env.AUTO_EXE === '1' || config.autoExe === true;
let expressApp, expressServer, io;
try {
  const express = require('express');
  const socketIo = require('socket.io');
  expressApp = express();
  expressServer = http.createServer(expressApp);
  io = new socketIo.Server(expressServer, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
    pingTimeout: 20000,
    pingInterval: 10000,
    maxHttpBufferSize: 1e6,
    connectTimeout: 30000,
    allowEIO3: true,
  });
} catch (e) {
  console.error(chalk.red('[FATAL] express/socket.io required:'), e.message);
  process.exit(1);
}
const manager = new BotManager({
  configPath: path.join(process.cwd(), 'config.json'),
  autoExe: AUTO_EXE,
  io,
});
const WebDashboard = require('./src/web/WebDashboard');
const dashboard = new WebDashboard(manager, {
  expressApp,
  io,
  expressServer,
  port: process.env.PORT || (config.settings && config.settings.webPort) || 3000,
  autoExe: AUTO_EXE,
});
manager.dashboard = dashboard;
const colors = {
  border: chalk.hex('#a78bfa'),
  accent: chalk.hex('#22d3ee'),
  title: chalk.hex('#e2e8f0'),
  muted: chalk.hex('#94a3b8'),
  key: chalk.hex('#fbbf24'),
  ok: chalk.green,
  warn: chalk.yellow,
  err: chalk.red,
};
function centerLine(text, width, color = colors.title) {
  const pad = Math.max(0, width - text.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return colors.border('║') + ' '.repeat(left) + color(text) + ' '.repeat(right) + colors.border('║');
}
function showBanner() {
  const width = 44;
  console.log('');
  console.log(colors.border('╔' + '═'.repeat(width) + '╗'));
  console.log(centerLine('✦  A N T A R E S  ✦', width, colors.accent));
  console.log(centerLine('Mine Bot Manager  •  v2.0', width, colors.title));
  console.log(colors.border('╠' + '═'.repeat(width) + '╣'));
  console.log(centerLine('Made By Antares', width, colors.muted));
  console.log(colors.border('╚' + '═'.repeat(width) + '╝'));
  console.log('');
}
function showHelp() {
  const cmds = [
    ['help, h', 'hiển thị trợ giúp này'],
    ['list', 'liệt kê tất cả bot'],
    ['start <id>', 'khởi động một bot'],
    ['stop <id>', 'dừng một bot'],
    ['cmd <id> <cmd>', 'gửi lệnh tới bot'],
    ['proxy list', 'liệt kê proxy'],
    ['proxy add <raw>', 'thêm proxy'],
    ['sys', 'thông số hệ thống'],
    ['exit, q, e', 'thoát chương trình'],
  ];
  const labelW = Math.max(...cmds.map(([l]) => l.length));
  const innerW = labelW + 4 + Math.max(...cmds.map(([, d]) => d.length));
  console.log(colors.border('╭─ Commands ' + '─'.repeat(Math.max(0, innerW - 9)) + '╮'));
  for (const [label, desc] of cmds) {
    console.log(
      colors.border('│ ') + colors.key(label.padEnd(labelW)) + colors.muted('  — ' + desc)
    );
  }
  console.log(colors.border('╰' + '─'.repeat(innerW + 2) + '╯'));
}
function statusIcon(state) {
  if (state === 'ONLINE') return colors.ok('●');
  if (['RECONNECTING', 'CONNECTING', 'SPAWNING', 'AUTHENTICATING'].includes(state)) return colors.warn('●');
  return colors.err('●');
}
function showBotList(bots) {
  if (!bots.length) {
    console.log(colors.muted('  No bots configured.'));
    return;
  }
  const idW = Math.max(2, ...bots.map(b => b.getSummary().id.length));
  const stateW = Math.max(5, ...bots.map(b => b.getSummary().state.length));
  for (const b of bots) {
    const s = b.getSummary();
    console.log(
      `  ${statusIcon(s.state)} ${colors.title(s.id.padEnd(idW))}  ` +
      `${colors.muted(s.state.padEnd(stateW))}  ` +
      `${colors.accent(s.host + ':' + s.port)}  ${colors.muted(s.username)}`
    );
  }
}
function showSysInfo(m) {
  console.log(
    colors.border('  ┌ System ──────────────────────────────') + '\n' +
    `  ${colors.muted('Memory')}   ${colors.title((m.procHeap / 1024 / 1024).toFixed(0) + 'MB')} / ${colors.muted((m.totalMem / 1024 / 1024 / 1024).toFixed(1) + 'GB')}  ${colors.accent('(' + m.memPercent + '%)')}\n` +
    `  ${colors.muted('CPU')}      ${colors.title(m.cpuModel)} ${colors.muted('(' + m.cpuCount + ' cores)')}\n` +
    `  ${colors.muted('Uptime')}   ${colors.title(Math.floor(m.uptime / 3600) + 'h ' + Math.floor((m.uptime % 3600) / 60) + 'm')}\n` +
    `  ${colors.muted('Node')}     ${colors.title(m.nodeVersion)} ${colors.muted('| ' + m.platform + ' ' + m.arch)}\n` +
    colors.border('  └──────────────────────────────────────')
  );
}
let _shuttingDown = false;
function shutdown() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(chalk.cyan('\n  Shutting down...'));
  if (dashboard) dashboard.shutdown();
  if (manager) manager.shutdown();
  if (expressServer && expressServer.listening) {
    expressServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  } else {
    process.exit(0);
  }
}
(async () => {
  try {
    showBanner();
    await manager.init();
    dashboard.start();
    if (!expressServer.listening) {
      await new Promise((resolve) => {
        expressServer.once('listening', resolve);
        setTimeout(resolve, 5000);
      });
    }
    console.log(colors.accent(`⬡  Antares Manager started — ${manager.bots.length} bots loaded, none auto-started`));
    console.log(colors.accent(`   Dashboard: http://localhost:${dashboard.port}`));
    console.log('');
    if (!AUTO_EXE && process.stdin.isTTY) {
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: colors.border('⬡ '),
        terminal: true,
      });
      rl.on('line', line => {
        const input = String(line || '').trim();
        if (!input) { rl.prompt(); return; }
        const parts = input.split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        try {
          switch (cmd) {
            case 'help':
            case 'h':
              showHelp();
              break;
            case 'list':
            case 'ls':
              showBotList(manager.bots);
              break;
            case 'start': {
              if (!args[0]) { console.log(colors.muted('  Usage: start <id>')); break; }
              const b = manager.findBot(args[0]);
              if (!b) { console.log(colors.err('  Bot not found: ' + args[0])); break; }
              if (b.isConnected || b.isReconnecting) { console.log(colors.warn('  Bot already running')); break; }
              b._disabled = false; b.state.reconnects = 0; b.start();
              console.log(colors.ok('  ✓ Started: ' + args[0]));
              break;
            }
            case 'stop': {
              if (!args[0]) { console.log(colors.muted('  Usage: stop <id>')); break; }
              const b = manager.findBot(args[0]);
              if (!b) { console.log(colors.err('  Bot not found: ' + args[0])); break; }
              b.shutdown();
              console.log(colors.err('  ✓ Stopped: ' + args[0]));
              break;
            }
            case 'cmd': {
              if (args.length < 2) { console.log(colors.muted('  Usage: cmd <id> <command>')); break; }
              const b = manager.findBot(args[0]);
              if (!b) { console.log(colors.err('  Bot not found: ' + args[0])); break; }
              b.cmd(args.slice(1).join(' '));
              break;
            }
            case 'proxy':
              if (args[0] === 'list' || args[0] === 'ls') {
                const list = manager.proxyManager.getSummaries();
                if (!list.length) { console.log(colors.muted('  No proxies')); break; }
                for (const p of list) {
                  console.log(`  ${colors.accent(p.type.padEnd(7))} ${p.host}:${p.port}  ${colors.muted(p.status)}  ${p.ping >= 0 ? p.ping + 'ms' : '-'}`);
                }
              } else if (args[0] === 'add' && args[1]) {
                const r = manager.proxyManager.add(args.slice(1).join(' '));
                console.log(r.ok ? colors.ok('  ✓ Added: ' + r.msg) : colors.err('  ✗ Error: ' + r.msg));
              } else {
                console.log(colors.muted('  Usage: proxy list | proxy add <proxy-string>'));
              }
              break;
            case 'sys':
            case 'system':
              showSysInfo(manager.getSystemMetrics());
              break;
            case 'exit':
            case 'quit':
            case 'q':
            case 'e':
              shutdown();
              return;
            default:
              console.log(colors.muted('  Unknown command. Type "help" for commands.'));
          }
        } catch (err) {
          console.error(colors.err('  Error:'), err.message);
        }
        rl.prompt();
      });
      rl.prompt(true);
    } else if (!AUTO_EXE) {
      console.log(colors.muted('   (non-TTY mode — dashboard running, CLI disabled)'));
    }
  } catch (e) {
    console.error(colors.err('[FATAL]'), e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', err => {
  console.error(colors.err('[UNCAUGHT]'), err.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error(colors.err('[UNHANDLED]'), reason?.message || reason);
});
