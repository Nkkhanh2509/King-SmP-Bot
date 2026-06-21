'use strict';
const fs = require('fs');
const os = require('os');
class EnvironmentDetector {
  constructor(autoExe = false) {
    this.autoExe = autoExe;
    this._profile = null;
  }
  detect() {
    if (this._profile) return this._profile;
    const env = {
      isDocker: false,
      isTermux: false,
      isWindows: process.platform === 'win32',
      isMacOS: process.platform === 'darwin',
      isLinux: process.platform === 'linux',
      isHeadless: !process.stdout.isTTY,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: os.cpus().length,
      totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
      autoExe: this.autoExe,
    };
    try {
      if (fs.existsSync('/.dockerenv')) env.isDocker = true;
      const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
      if (cgroup.includes('docker') || cgroup.includes('containerd') || cgroup.includes('lxc')) env.isDocker = true;
    } catch {  }
    if (process.env.TERMUX_VERSION ||
        process.env.PREFIX?.includes('com.termux') ||
        fs.existsSync('/data/data/com.termux')) {
      env.isTermux = true;
    }
    env.isLowResource = env.totalMemMB < 1024 || env.cpuCount <= 1;
    env.isVeryLowResource = env.totalMemMB < 512;
    this._profile = env;
    return env;
  }
  getAdaptiveProfile() {
    const env = this.detect();
    const profile = {
      pollInterval: 45000,
      pollJitter: 10000,
      healthInterval: 15000,
      healthJitter: 3000,
      statusInterval: 1500,
      metricsInterval: 3000,
      maxLogPerBot: 800,
      logBatchSize: 50,
      proxyCooldown: 30000,
      proxyMaxFailsBeforeCooldown: 3,
      gcHint: false,
    };
    if (env.isLowResource) {
      profile.pollInterval = 90000;
      profile.pollJitter = 15000;
      profile.healthInterval = 30000;
      profile.statusInterval = 3000;
      profile.metricsInterval = 5000;
      profile.maxLogPerBot = 400;
      profile.logBatchSize = 25;
    }
    if (env.isVeryLowResource) {
      profile.pollInterval = 120000;
      profile.pollJitter = 20000;
      profile.healthInterval = 45000;
      profile.statusInterval = 5000;
      profile.metricsInterval = 10000;
      profile.maxLogPerBot = 200;
      profile.logBatchSize = 15;
      profile.gcHint = true;
    }
    if (env.isTermux) {
      profile.maxLogPerBot = Math.min(profile.maxLogPerBot, 300);
      profile.statusInterval = Math.max(profile.statusInterval, 4000);
    }
    return { env, profile };
  }
  get env() { return this.detect(); }
  get profile() { return this.getAdaptiveProfile().profile; }
}
module.exports = EnvironmentDetector;
