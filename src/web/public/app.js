'use strict';
const ST = {
  bots: [],
  activeId: null,
  activeTab: 'overview',
  serverEnv: {},
  proxies: [],
  _sysMetrics: {},
  _proxyViewMode: 'list',
  _proxySort: { col: null, asc: true },
  _proxyFilter: 'all',
  _proxySearch: '',
  _selectedBots: new Set(),
  _lastToastTime: {},
  _logFilter: 'all',
  _logPaused: false,
  _logSearch: '',
  _cmdHistory: [],
  _cmdHistoryIdx: -1,
  _cmdInputVal: '',
  _pingHistory: {},
  _pktHistory: {},
  _debounceTimer: null,
  _capacity: null,
};
const SOCK = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
});
const $ = id => document.getElementById(id);
function openModal(id) { const el = $(id); if (el) el.classList.add('open'); }
function closeModal(id) { const el = $(id); if (el) { el.classList.remove('open'); if (id === 'overlay-capacity-warn') _pendingAddBot = null; } }
function closeMobileSidebar() {
  DOM.sidebar.classList.remove('open');
  DOM.sidebarBackdrop.classList.remove('show');
  DOM.menuToggle.setAttribute('aria-expanded','false');
}
function updateMobileNav(tab) {
  document.querySelectorAll('.mobile-nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.mtab === tab);
  });
}
function showGlobalDashboard() {
  ST.activeId = null;
  DOM.noSel.style.display = 'none';
  DOM.botView.style.display = '';
  DOM.tabs.style.display = 'none';
  DOM.actionBar.innerHTML = '';
  renderGlobalDashboard();
  closeMobileSidebar();
  updateMobileNav('home');
}
function openBotsSidebar() {
  ST.activeId = null;
  DOM.noSel.style.display = '';
  DOM.botView.style.display = 'none';
  DOM.tabs.style.display = 'none';
  DOM.actionBar.innerHTML = '';
  if (window.innerWidth < 900) {
    DOM.sidebar.classList.add('open');
    DOM.sidebarBackdrop.classList.add('show');
    DOM.menuToggle.setAttribute('aria-expanded','true');
  }
  updateMobileNav('bots');
}
function showManagerTab() {
  ST.activeId = null;
  DOM.noSel.style.display = 'none';
  DOM.botView.style.display = '';
  DOM.tabs.style.display = 'none';
  DOM.actionBar.innerHTML = '';
  ST.activeTab = 'manager';
  renderManager();
  closeMobileSidebar();
  updateMobileNav('manager');
}
function showSystemTab() {
  ST.activeId = null;
  DOM.noSel.style.display = 'none';
  DOM.botView.style.display = '';
  DOM.tabs.style.display = 'none';
  DOM.actionBar.innerHTML = '';
  ST.activeTab = 'system';
  renderSystem();
  closeMobileSidebar();
  updateMobileNav('system');
}
function showConsoleTab() {
  if (!ST.activeId) {
    ST.activeTab = 'logs';
    const onlineBots = ST.bots.filter(b => b.state === 'ONLINE');
    if (onlineBots.length > 0) { selectBot(onlineBots[0].id); }
    else if (ST.bots.length > 0) { selectBot(ST.bots[0].id); }
    else { toast('Chưa có bot nào', 'warn'); return; }
    updateMobileNav('console');
    return;
  }
  ST.activeTab = 'logs';
  DOM.noSel.style.display = 'none';
  DOM.botView.style.display = '';
  DOM.tabs.style.display = '';
  renderActionBar();
  renderActiveTab();
  closeMobileSidebar();
  updateMobileNav('console');
}
const DOM = {
  get sbList() { return $('sb-list'); },
  get sbSearch() { return $('sb-search'); },
  get hdrCount() { return $('hdr-count'); },
  get hdrTime() { return $('hdr-time'); },
  get hdrLive() { return $('hdr-live'); },
  get noSel() { return $('no-sel'); },
  get botView() { return $('bot-view'); },
  get tabs() { return $('tabs'); },
  get tabContent() { return $('tab-content'); },
  get actionBar() { return $('action-bar'); },
  get bulkBar() { return $('bulk-bar'); },
  get sidebar() { return $('sidebar'); },
  get menuToggle() { return $('menu-toggle'); },
  get sidebarBackdrop() { return $('sidebar-backdrop'); },
  get toast() { return $('toast'); },
  get dcBanner() { return $('dc-banner'); },
  get dcReason() { return $('dc-reason'); },
};
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function timeStr(ts) { if (!ts) return '--:--:--'; const d = new Date(ts); return [d.getHours(),d.getMinutes(),d.getSeconds()].map(n=>String(n).padStart(2,'0')).join(':'); }
function fmtUptime(s) { if (!s||s<0) return '--'; const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60); if(d>0)return d+'d '+h+'h'; if(h>0)return h+'h '+m+'m'; return m+'m '+(s%60)+'s'; }
function fmtBytes(b) { if(!b)return'0 B'; const k=1024,sizes=['B','KB','MB','GB']; const i=Math.floor(Math.log(b)/Math.log(k)); return (b/Math.pow(k,i)).toFixed(1)+' '+sizes[i]; }
function fmtMem(b) { return (b/1024/1024).toFixed(0)+' MB'; }
function stateClass(s) { return (s||'DISCONNECTED').toLowerCase(); }
function fmtShortUptime(s) { if(!s||s<0)return'--'; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); if(h>0)return h+'h '+m+'m'; return m+'m'; }
let toastTimer;
function toast(msg, type = 'success', detail = null) {
  const t = DOM.toast;
  const icons = { success: '✓', error: '✕', warn: '⚠' };
  const icon = icons[type] || '';
  const throttleKey = type + ':' + (detail || msg);
  const now = Date.now();
  if (ST._lastToastTime[throttleKey] && now - ST._lastToastTime[throttleKey] < 5000) return;
  ST._lastToastTime[throttleKey] = now;
  t.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${esc(msg)}</span>${detail ? `<button class="toast-detail" onclick="showDetailModal('${esc(detail.title||'Chi tiết')}','${esc(detail.body||'')}')">Chi tiết</button>` : ''}`;
  t.className = 'toast ' + type + ' show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); }, 3500);
}
function showDetailModal(title, body) {
  const m = $('overlay-msg');
  const t = $('msg-title');
  const b = $('overlay-msg-body');
  if (t) t.textContent = title;
  if (b) b.innerHTML = body;
  if (m) m.classList.add('open');
}
SOCK.on('connect', () => {
  DOM.dcBanner.style.display = 'none';
  DOM.hdrLive.className = 'status-badge live';
  DOM.hdrLive.innerHTML = '<span class="status-dot"></span><span>LIVE</span>';
  if (ST.activeId) { SOCK.emit('subscribe', ST.activeId); }
  SOCK.emit('getSystemMetrics');
  renderSB();
  if (ST.activeId) { renderActiveTab(); renderActionBar(); }
});
SOCK.on('disconnect', reason => {
  DOM.dcBanner.style.display = 'flex';
  DOM.dcReason.textContent = reason || 'unknown';
  DOM.hdrLive.className = 'status-badge off';
  DOM.hdrLive.innerHTML = '<span class="status-dot"></span><span>OFFLINE</span>';
});
SOCK.on('reconnect_attempt', n => {
  DOM.dcReason.textContent = 'Đang kết nối lại... (lần ' + n + ')';
});
SOCK.on('connect_error', err => {
  console.warn('[Socket] Connect error:', err.message);
});
function renderSB() {
  const list = DOM.sbList;
  if (!list) return;
  list.innerHTML = '';
  const groups = { ONLINE: [], IDLE: [], OFFLINE: [] };
  for (const b of ST.bots) {
    const s = b.state || 'DISCONNECTED';
    if (s === 'ONLINE') groups.ONLINE.push(b);
    else if (['RECONNECTING','CONNECTING','AUTHENTICATING','SPAWNING'].includes(s)) groups.IDLE.push(b);
    else groups.OFFLINE.push(b);
  }
  const search = (DOM.sbSearch?.value || '').toLowerCase();
  const groupOrder = ['ONLINE', 'IDLE', 'OFFLINE'];
  const groupLabels = { ONLINE: 'ONLINE', IDLE: 'IDLE', OFFLINE: 'OFFLINE' };
  for (const g of groupOrder) {
    const items = groups[g] || [];
    if (!items.length) continue;
    const filtered = search
      ? items.filter(b => b.id.toLowerCase().includes(search) || (b.host||'').toLowerCase().includes(search) || (b.username||'').toLowerCase().includes(search) || (b.proxy||'').toLowerCase().includes(search))
      : items;
    if (!filtered.length) continue;
    const groupDiv = document.createElement('div');
    groupDiv.className = 'sb-group';
    groupDiv.innerHTML = `<div class="sb-group-hdr" onclick="this.parentElement.classList.toggle('collapsed')"><span class="sb-group-dot ${g.toLowerCase()}"></span><span class="sb-group-label">${groupLabels[g]}</span><span class="sb-group-cnt">${filtered.length}</span><span class="sb-group-arrow">▾</span></div>`;
    const itemsDiv = document.createElement('div');
    itemsDiv.className = 'sb-group-items';
    for (const b of filtered) {
      const div = document.createElement('div');
      div.className = 'sb-item' + (ST.activeId === b.id ? ' active' : '');
      const gLower = g.toLowerCase();
      const chkId = 'chk_' + b.id;
      div.innerHTML =
        `<div class="sb-item-row bulk">
          <input type="checkbox" class="sb-chk" id="${chkId}" ${ST._selectedBots.has(b.id)?'checked':''} onclick="event.stopPropagation();toggleBulkSelect('${esc(b.id)}')" aria-label="Chọn bot ${esc(b.id)}">
        </div>
        <div class="sb-item-row" onclick="selectBot('${esc(b.id)}')">
          <div class="sb-dot ${gLower}"></div>
          <div class="sb-name">${esc(b.id)}</div>
          ${b.registered===false?'<span class="sb-reg unreg">Chưa ĐK</span>':b.registered===true?'<span class="sb-reg reg">Đã ĐK</span>':''}
        </div>
        <div class="sb-meta" onclick="selectBot('${esc(b.id)}')">
          <span>${esc(b.host)}:${b.port}</span>
          <span>${esc(b.username)}</span>
        </div>
        ${b.ppsIn>0||b.ppsOut>0?`<div class="sb-pkt" onclick="selectBot('${esc(b.id)}')">↓${b.ppsIn} ↑${b.ppsOut}/s</div>`:''}`;
      itemsDiv.appendChild(div);
    }
    groupDiv.appendChild(itemsDiv);
    list.appendChild(groupDiv);
  }
  const total = ST.bots.length;
  const online = ST.bots.filter(b=>b.state==='ONLINE').length;
  DOM.hdrCount.textContent = total + ' Bot' + (total !== 1 ? 's' : '') + ' Online';
  DOM.hdrLive.style.display = total > 0 ? '' : 'none';
  renderBulkBar();
  renderSidebarStats();
}
function renderSidebarStats() {
  const m = ST._sysMetrics || {};
  const ramPct = m.memPercent || 0;
  const ramEl = $('sb-ram-pct'), ramFill = $('sb-ram-fill');
  if (ramEl) { ramEl.textContent = ramPct + '%'; }
  if (ramFill) { ramFill.style.width = Math.min(ramPct, 100) + '%'; ramFill.className = 'stat-bar-fill' + (ramPct > 80 ? ' danger' : ramPct > 60 ? ' warn' : ''); }
  const cap = ST._capacity;
  const botPctEl = $('sb-bot-pct'), botFill = $('sb-bot-fill');
  if (botPctEl && cap) {
    botPctEl.textContent = (cap.currentBots || 0) + '/' + (cap.maxRecommended || 0);
    const bp = cap.maxRecommended > 0 ? Math.min(100, Math.round((cap.currentBots / cap.maxRecommended) * 100)) : 0;
    if (botFill) { botFill.style.width = bp + '%'; botFill.className = 'stat-bar-fill' + (bp > 90 ? ' danger' : bp > 75 ? ' warn' : ''); }
  }
  const netEl = $('sb-net-val'), netFill = $('sb-net-fill');
  const totalPps = ST.bots.reduce((a, b) => a + (b.ppsIn || 0) + (b.ppsOut || 0), 0);
  if (netEl) netEl.textContent = totalPps + ' pps';
  if (netFill) {
    const np = Math.min(100, totalPps / 5);
    netFill.style.width = np + '%';
  }
  const cpuEl = $('sb-cpu-pct'), cpuFill = $('sb-cpu-fill');
  const load = m.loadAvg ? m.loadAvg[0] : 0;
  const cpuPct = m.cpuCount ? Math.min(100, Math.round((load / m.cpuCount) * 100)) : 0;
  if (cpuEl) cpuEl.textContent = cpuPct + '%';
  if (cpuFill) {
    cpuFill.style.width = cpuPct + '%';
    cpuFill.className = 'stat-bar-fill' + (cpuPct > 80 ? ' danger' : cpuPct > 60 ? ' warn' : '');
  }
}
function toggleBulkSelect(id) {
  if (ST._selectedBots.has(id)) ST._selectedBots.delete(id);
  else ST._selectedBots.add(id);
  renderBulkBar();
}
function selectAllBots() {
  const allIds = ST.bots.map(b => b.id);
  if (ST._selectedBots.size === allIds.length) ST._selectedBots.clear();
  else allIds.forEach(id => ST._selectedBots.add(id));
  renderSB();
}
function renderBulkBar() {
  const bar = DOM.bulkBar;
  if (!bar) return;
  const n = ST._selectedBots.size;
  if (n === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = `<span class="bulk-label">Đã chọn ${n} bot</span>
    <span class="sp"></span>
    <button class="btn btn-success btn-sm" onclick="bulkStart()" aria-label="Start các bot đã chọn">▶ Start (${n})</button>
    <button class="btn btn-danger btn-sm" onclick="bulkStop()" aria-label="Stop các bot đã chọn">■ Stop (${n})</button>
    <button class="btn btn-primary btn-sm" onclick="bulkRestart()" aria-label="Restart các bot đã chọn">↻ Restart</button>
    <button class="btn btn-warn btn-sm" onclick="bulkDelete()" aria-label="Xóa các bot đã chọn">✕ Delete</button>
    <button class="btn btn-ghost btn-sm" onclick="ST._selectedBots.clear();renderSB()">Bỏ chọn</button>`;
}
function bulkStart() {
  for (const id of ST._selectedBots) SOCK.emit('startBot', { id }, r => { if (r&&!r.ok) toast(r.message, 'error'); });
  ST._selectedBots.clear(); renderSB();
}
function bulkStop() {
  if (!confirm('Dừng ' + ST._selectedBots.size + ' bot?')) return;
  for (const id of ST._selectedBots) SOCK.emit('stopBot', { id });
  ST._selectedBots.clear(); renderSB();
}
function bulkRestart() {
  if (!confirm('Restart ' + ST._selectedBots.size + ' bot?')) return;
  SOCK.emit('restartAll', { filterFn: null }, r => { toast('Đã gửi restart ' + ST._selectedBots.size + ' bot', 'warn'); });
  ST._selectedBots.clear(); renderSB();
}
function bulkDelete() {
  if (!confirm('XÓA ' + ST._selectedBots.size + ' bot? Không thể hoàn tác!')) return;
  for (const id of ST._selectedBots) SOCK.emit('removeBot', { id });
  ST._selectedBots.clear(); renderSB();
}
function selectBot(id) {
  if (!ST.bots.find(b=>b.id===id)) return;
  if (ST.activeId && ST.activeId !== id) SOCK.emit('unsubscribe', ST.activeId);
  ST.activeId = id;
  DOM.noSel.style.display = 'none';
  DOM.botView.style.display = '';
  DOM.tabs.style.display = '';
  if (['manager','proxy','system','stats'].includes(ST.activeTab)) ST.activeTab = 'overview';
  renderSB();
  renderActionBar();
  renderActiveTab();
  SOCK.emit('subscribe', id);
  closeMobileSidebar();
  updateMobileNav('console');
}
function renderGlobalDashboard() {
  const bots = ST.bots;
  DOM.noSel.style.display = 'none';
  DOM.botView.style.display = '';
  DOM.tabs.style.display = 'none';
  DOM.actionBar.innerHTML = '';
  let html = `<div class="sec-label">Global Dashboard (${bots.length} bots)</div>`;
  html += '<div class="gd-grid">';
  for (const b of bots) {
    const cls = stateClass(b.state);
    const gCls = b.state === 'ONLINE' ? 'online' : ['RECONNECTING','CONNECTING','AUTHENTICATING','SPAWNING'].includes(b.state) ? 'idle' : 'offline';
    const isOnline = b.state === 'ONLINE';
    const pingStr = b.ping >= 0 ? b.ping + 'ms' : '—';
    const uptime = b.loginTime ? fmtShortUptime((Date.now()-b.loginTime)/1000) : '—';
    const miniSpark = b._pktHistory && b._pktHistory.length > 1
      ? `<canvas class="mini-spark" data-bot="${esc(b.id)}" width="80" height="20" style="width:80px;height:20px"></canvas>`
      : '';
    html += `<div class="gd-card ${gCls}" onclick="selectBot('${esc(b.id)}')">
      <div class="gd-card-top">
        <div class="gd-dot ${gCls}"></div>
        <div class="gd-name">${esc(b.id)}</div>
        <div class="gd-state ${gCls}">${b.state}</div>
      </div>
      <div class="gd-metrics">
        <div class="gd-metric"><span class="gd-m-l">Ping</span><span class="gd-m-v">${pingStr}</span></div>
        <div class="gd-metric"><span class="gd-m-l">Uptime</span><span class="gd-m-v">${uptime}</span></div>
        <div class="gd-metric"><span class="gd-m-l">Shard</span><span class="gd-m-v">${b.shard>0?b.shard.toLocaleString():'—'}</span></div>
      </div>
      <div class="gd-pkt">↓${b.ppsIn||0} ↑${b.ppsOut||0}/s</div>
      ${miniSpark}
    </div>`;
  }
  html += '</div>';
  DOM.tabContent.innerHTML = html;
  requestAnimationFrame(() => {
    for (const b of bots) {
      if (b._pktHistory && b._pktHistory.length > 1) {
        drawMiniSpark(b.id, b._pktHistory);
      }
    }
  });
}
function cssVar(name, fallback) {
  try {
    const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return val || fallback;
  } catch { return fallback; }
}
function drawMiniSpark(botId, data) {
  const canvas = document.querySelector(`.mini-spark[data-bot="${botId}"]`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  const max = Math.max(...data, 1);
  ctx.strokeStyle = cssVar('--accent', '#5EEAD4');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * (w - 2) + 1;
    const y = h - 1 - (data[i] / max) * (h - 2);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
function renderActiveTab() {
  if (ST.activeId) renderBotTabs();
  else renderGlobalDashboard();
}
function renderBotTabs() {
  const tabs = DOM.tabs.querySelectorAll('.tab');
  tabs.forEach(t=>{
    const isActive = t.dataset.tab === ST.activeTab;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  const b = ST.bots.find(x=>x.id===ST.activeId);
  if (!b) return;
  switch (ST.activeTab) {
    case 'overview': renderOverview(b); break;
    case 'manager':  renderManager(); break;
    case 'logs':     renderLogs(b); break;
    case 'inventory':renderInventory(b); break;
    case 'commands': renderCommands(b); break;
    case 'config':   renderConfig(b); break;
    case 'proxy':    renderProxyTab(b); break;
    case 'stats':    renderStats(b); break;
    case 'system':   renderSystem(); break;
    default:         renderOverview(b);
  }
}
function renderOverview(b) {
  const s = b;
  const pingChartHtml = s._pingHistory && s._pingHistory.length > 1
    ? `<div class="mini-chart-wrap"><canvas class="mini-chart" id="ping-chart" width="320" height="50"></canvas><div class="mini-chart-label">Ping 30s</div></div>`
    : '';
  const pktChartHtml = s._pktHistory && s._pktHistory.length > 1
    ? `<div class="mini-chart-wrap"><canvas class="mini-chart" id="pkt-chart" width="320" height="50"></canvas><div class="mini-chart-label">Packet rate 30s</div></div>`
    : '';
  const stateCls = s.state === 'ONLINE' ? 'online' : 'offline';
  let html = `${pingChartHtml}${pktChartHtml}
    <div class="stat-grid">
      ${statCard('Trạng thái', s.state, stateCls)}
      ${statCard('Ping', s.ping>=0?s.ping+'ms':'—', 'accent')}
      ${statCard('Shard', s.shard>0?s.shard.toLocaleString():'—', 'accent')}
      ${statCard('Reconnects', s.reconnects, 'warn')}
      ${statCard('Máu', (s.health??20)+' ❤', 'offline')}
      ${statCard('Thức ăn'+(s.autoEat?' (Auto)':''), (s.food??20)+' '+(s.autoEat?'🍖':'🍗'), s.autoEat?'success':'warn')}
      ${statCard('Proxy', s.proxy||'—', 'accent')}
      ${statCard('Phiên bản', s.version||'—', 'accent')}
    </div>
    <div class="pkt-row">
      <div class="pkt-box in"><div class="pkt-ico">📥</div><div class="pkt-info"><div class="pkt-lbl">Gói vào</div><div><span class="pkt-val">${s.ppsIn??0}</span><span class="pkt-unit">/s</span></div></div></div>
      <div class="pkt-box out"><div class="pkt-ico">📤</div><div class="pkt-info"><div class="pkt-lbl">Gói ra</div><div><span class="pkt-val">${s.ppsOut??0}</span><span class="pkt-unit">/s</span></div></div></div>
    </div>
    ${s.cfg?.autoMenu?`<div class="menu-box"><div class="menu-dot ${s.menuSuccess?'success':s.menuRetries>0?'retrying':'idle'}"></div><div class="menu-info"><div class="menu-label">Tự động Menu</div><div class="menu-val">${s.menuSuccess?'Thành công':s.menuRetries>0?'Đang thử lại ('+s.menuRetries+')':'Đang chờ...'}</div></div></div>`:''}
    <div class="coord-box"><div class="coord-lbl">Tọa độ</div><div class="coord-row">${s.position?`<div class="coord-item"><span class="coord-key">X</span><span class="coord-val">${s.position.x?.toFixed(1)??'?'}</span></div><div class="coord-item"><span class="coord-key">Y</span><span class="coord-val">${s.position.y?.toFixed(1)??'?'}</span></div><div class="coord-item"><span class="coord-key">Z</span><span class="coord-val">${s.position.z?.toFixed(1)??'?'}</span></div>`:'<span style="color:var(--text-3)">—</span>'}</div></div>`;
  html += `<div class="sec-label">Thông tin kết nối</div>
    <div class="conn-grid">
      <div class="conn-item"><span class="conn-label">Server Address</span><span class="conn-value">${esc(s.host)}:${s.port}</span></div>
      <div class="conn-item"><span class="conn-label">Version</span><span class="conn-value">${esc(s.version||'—')}</span></div>
      <div class="conn-item"><span class="conn-label">Username</span><span class="conn-value">${esc(s.username||'—')}</span></div>
      <div class="conn-item"><span class="conn-label">Proxy</span><span class="conn-value">${esc(s.proxy||'—')}</span></div>
      <div class="conn-item"><span class="conn-label">Authentication</span><span class="conn-value">${s.registered===false?'Chưa ĐK':s.registered===true?'Đã ĐK':'—'}</span></div>
      <div class="conn-item"><span class="conn-label">Uptime</span><span class="conn-value">${s.loginTime?fmtShortUptime((Date.now()-s.loginTime)/1000):'—'}</span></div>
      <div class="conn-item"><span class="conn-label">Latency</span><span class="conn-value">${s.ping>=0?s.ping+'ms':'—'}</span></div>
      <div class="conn-item"><span class="conn-label">State</span><span class="conn-value">${esc(s.state)}</span></div>
    </div>`;
  DOM.tabContent.innerHTML = html;
  requestAnimationFrame(() => {
    if (s._pingHistory && s._pingHistory.length > 1) drawLineChart('ping-chart', s._pingHistory, 'var(--accent)', 'ms');
    if (s._pktHistory && s._pktHistory.length > 1) drawLineChart('pkt-chart', s._pktHistory, 'var(--online)', '/s');
  });
}
function drawLineChart(canvasId, data, color, suffix) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  ctx.strokeStyle = cssVar('--border', '#232938');
  ctx.lineWidth = 0.5;
  for (let i = 0; i < 4; i++) {
    const y = (i / 3) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.strokeStyle = color.startsWith('var(') ? cssVar(color.slice(4, -1), color) : color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * (w - 4) + 2;
    const y = h - 2 - ((data[i] - min) / Math.max(max - min, 1)) * (h - 6);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
function statCard(label, value, cls='') {
  return `<div class="stat-card"><div class="stat-card-label">${label}</div><div class="stat-card-value ${cls}">${esc(String(value))}</div></div>`;
}
function renderActionBar() {
  const b = ST.bots.find(x=>x.id===ST.activeId);
  if (!b) { DOM.actionBar.innerHTML=''; return; }
  const isOnline = b.state==='ONLINE';
  const isActive = b.state!=='DISCONNECTED'&&b.state!=='STOPPING';
  const stateCls = b.state==='ONLINE'?'online':['RECONNECTING','CONNECTING','SPAWNING','AUTHENTICATING'].includes(b.state)?'idle':'offline';
  DOM.actionBar.innerHTML =
    `<span class="bot-label">${esc(b.id)}</span>
    <span class="bot-state ${stateCls}">${b.state}</span>
    <span class="sp"></span>
    ${b.autoEat?`<span class="topbar-pill" style="border-color:rgba(52,211,153,0.35);color:var(--online);background:var(--online-dim)" title="Auto Eat đang bật">🍖 Auto Eat</span>`:''}
    ${!isActive?`<button class="btn btn-success btn-sm" onclick="startBot('${b.id}')" aria-label="Start bot">▶ Start</button>`:
      `<button class="btn btn-danger btn-sm" onclick="stopBot('${b.id}')" aria-label="Stop bot">■ Stop</button>`}
    ${isOnline?`<button class="btn btn-primary btn-sm" onclick="reconnectBot('${b.id}')" aria-label="Reconnect bot">↻ Reconnect</button>`:''}
    ${isOnline?`<button class="btn btn-sm ${b.tshard?'btn-success':'btn-primary'}" onclick="toggleTshard('${b.id}')" aria-label="Treo Shard">💤 ${b.tshard?'Đang Treo':'Treo Shard'}</button>`:''}
    <button class="btn btn-primary btn-sm" onclick="openEditModal('${esc(b.id)}')" aria-label="Sửa bot">✏ Edit</button>
    <button class="btn btn-warn btn-sm" onclick="removeBot('${b.id}')" aria-label="Xóa bot">✕ Remove</button>`;
}
function renderManager() {
  const summary = ST._summary;
  let html = '';
  if (summary) {
    html += `<div class="summary-bar"><span class="summary-total">Tổng: ${summary.total}</span>
      <span class="summary-stat online">● ${summary.counts?.ONLINE||0} online</span>
      <span class="summary-stat idle">● ${(summary.counts?.RECONNECTING||0)+(summary.counts?.CONNECTING||0)} connecting</span>
      <span class="summary-stat offline">● ${(summary.counts?.DISCONNECTED||0)+(summary.counts?.STOPPING||0)} offline</span>
      <span class="summary-stat" style="color:var(--accent)">${summary.totalPpsIn+summary.totalPpsOut} pps</span>
      ${summary.avgPing>=0?`<span class="summary-stat" style="color:var(--online)">${summary.avgPing}ms avg</span>`:''}
    </div>`;
  }
  html += `<div class="sec-label">All Bots (${ST.bots.length})</div><div class="mgr-grid">`;
  for (const s of ST.bots) {
    const gCls = s.state==='ONLINE'?'online':['RECONNECTING','CONNECTING','SPAWNING','AUTHENTICATING'].includes(s.state)?'idle':'offline';
    const isRunning = s.state!=='DISCONNECTED'&&s.state!=='STOPPING';
    const regBadge = s.registered===false?'<span class="sb-reg unreg" style="margin-left:auto">Chưa ĐK</span>':(s.registered===true?'<span class="sb-reg reg" style="margin-left:auto">Đã ĐK</span>':'');
    html += `<div class="mgr-card ${gCls}">
      <div class="mgr-card-h" onclick="selectBot('${esc(s.id)}')"><div class="mgr-dot ${gCls}"></div><div class="mgr-id">${esc(s.id)}</div>${regBadge}<div class="mgr-state ${gCls}">${s.state}</div></div>
      <div class="mgr-info" onclick="selectBot('${esc(s.id)}')">
        <div class="mgr-info-item"><span class="mgr-info-l">Server</span><span class="mgr-info-v">${esc(s.host)}:${s.port}</span></div>
        <div class="mgr-info-item"><span class="mgr-info-l">User</span><span class="mgr-info-v">${esc(s.username)}</span></div>
        <div class="mgr-info-item"><span class="mgr-info-l">Ping</span><span class="mgr-info-v">${s.ping>=0?s.ping+'ms':'—'}</span></div>
        <div class="mgr-info-item"><span class="mgr-info-l">Shard</span><span class="mgr-info-v">${s.shard>0?s.shard.toLocaleString():'—'}</span></div>
      </div>
      ${s.proxy?`<div class="mgr-proxy-line"><span class="mgr-info-l">Proxy</span><span style="color:var(--accent);font-family:var(--font-mono);font-size:10px">${esc(s.proxy)}</span></div>`:''}
      ${s.ppsIn>0||s.ppsOut>0?`<div class="mgr-pkt"><span style="color:var(--online);font-weight:600">↓${s.ppsIn}</span><span style="color:var(--accent);font-weight:600">↑${s.ppsOut}</span><span style="color:var(--text-3)">/s</span><span style="margin-left:auto;color:var(--text-3);font-size:9px">${s.version||''}</span></div>`:`<div class="mgr-pkt" style="justify-content:flex-end"><span style="color:var(--text-3);font-size:9px">${s.version||''}</span></div>`}
      <div class="mgr-actions">${!isRunning?`<button class="btn btn-success btn-sm" onclick="startBot('${esc(s.id)}')" aria-label="Start">▶ Start</button>`:`<button class="btn btn-danger btn-sm" onclick="stopBot('${esc(s.id)}')" aria-label="Stop">■ Stop</button>`}${s.state==='ONLINE'?`<button class="btn btn-primary btn-sm" onclick="reconnectBot('${esc(s.id)}')" aria-label="Reconnect">↻ Reconnect</button>`:''}<button class="btn btn-primary btn-sm" onclick="openEditModal('${esc(s.id)}')" aria-label="Sửa">✏ Edit</button><button class="btn btn-warn btn-sm" onclick="removeBot('${esc(s.id)}')" aria-label="Xóa">✕</button></div>
    </div>`;
  }
  html += `</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      <button class="btn btn-success" onclick="startAll()" aria-label="Start tất cả bot">▶ Start All</button>
      <button class="btn btn-danger" onclick="stopAll()" aria-label="Stop tất cả bot">■ Stop All</button>
      <button class="btn btn-primary" onclick="openModal('overlay-add-bot')" aria-label="Thêm bot mới">＋ Add Bot</button>
    </div>`;
  DOM.tabContent.innerHTML = html;
}
function renderLogs(b) {
  ST._logFilter = 'all'; ST._logPaused = false; ST._logSearch = '';
  DOM.tabContent.innerHTML =
    `<div class="log-wrap">
      <div class="log-toolbar">
        <span style="font-size:10px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px">Live Console</span>
        <span id="log-cnt" style="font-size:10px;color:var(--text-3);font-family:var(--font-mono)"></span>
        <span class="sp"></span>
        <input id="log-search" class="log-search-inline" placeholder="🔍 Tìm..." oninput="ST._logSearch=this.value;reloadLogs()">
        <select id="log-filter" class="log-filter-select" onchange="ST._logFilter=this.value;reloadLogs()">
          <option value="all">All</option><option value="ok">OK</option><option value="warn">Warn</option><option value="err">Error</option><option value="chat">Chat</option><option value="sys">System</option>
        </select>
        <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-2);cursor:pointer">
          <input type="checkbox" id="log-autoscroll" checked> Auto-scroll
        </label>
        <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-2);cursor:pointer">
          <input type="checkbox" id="log-pause" onchange="ST._logPaused=this.checked"> Pause
        </label>
        <button class="btn btn-ghost btn-sm" onclick="clearLogs()" aria-label="Xóa log">🗑 Clear</button>
        <button class="btn btn-ghost btn-sm" onclick="copyLogs()" aria-label="Copy log">📋 Copy</button>
        <button class="btn btn-ghost btn-sm" onclick="downloadLogs()" aria-label="Download log">⬇ Download</button>
      </div>
      <div class="log-box" id="log-box"></div>
      <div class="cmd-row">
        <input class="cmd-input" id="cmd-input" placeholder="Gõ lệnh chat hoặc command..." onkeydown="handleCmdKey(event)">
        <button class="btn btn-primary" onclick="sendCmd()" aria-label="Gửi lệnh">Send</button>
      </div>
    </div>`;
  const logBox = $('log-box');
  if (logBox && b) {
    const logs = b._logs || [];
    for (const l of logs) appendLogLine(logBox, l, false);
  }
  updateLogCount();
}
function reloadLogs() {
  const b = ST.bots.find(x=>x.id===ST.activeId);
  if (!b) return;
  const box = $('log-box');
  if (!box) return;
  box.innerHTML = '';
  const logs = b._logs || [];
  for (const l of logs) {
    if (ST._logFilter !== 'all' && l.level !== ST._logFilter) continue;
    if (ST._logSearch && !(l.msg||'').toLowerCase().includes(ST._logSearch.toLowerCase())) continue;
    appendLogLine(box, l, false);
  }
  updateLogCount();
}
function appendLogLine(container, entry, animate=true) {
  if (!container) return;
  if (ST._logFilter !== 'all' && entry.level !== ST._logFilter) return;
  if (ST._logSearch && !(entry.msg||'').toLowerCase().includes(ST._logSearch.toLowerCase())) return;
  const div = document.createElement('div');
  div.className = 'log-line '+(entry.level||'sys')+(animate?' new':'');
  div.innerHTML = `<span class="log-time">${timeStr(entry.time)}</span><span class="log-badge">${entry.level||'·'}</span><span class="log-msg">${esc(entry.msg||'')}</span>`;
  container.appendChild(div);
  while (container.children.length > 800) container.firstChild.remove();
}
function updateLogCount() {
  const box = $('log-box'); const cnt = $('log-cnt');
  if (cnt && box) cnt.textContent = box.children.length + ' lines';
}
function clearLogs() { const box=$('log-box'); if(box)box.innerHTML=''; updateLogCount(); }
function copyLogs() {
  const box = $('log-box');
  if (!box) return;
  const text = Array.from(box.children).map(c => c.textContent).join('\n');
  navigator.clipboard.writeText(text).then(() => toast('Đã copy log','success')).catch(() => toast('Copy thất bại','error'));
}
function downloadLogs() {
  const b = ST.bots.find(x=>x.id===ST.activeId);
  if (!b) return;
  const text = (b._logs || []).map(l => `[${timeStr(l.time)}] [${l.level}] ${l.msg}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `logs-${b.id}-${new Date().toISOString().slice(0,10)}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Đã tải log','success');
}
function sendCmd() {
  const input = $('cmd-input');
  if (!input||!ST.activeId) return;
  const cmd = input.value.trim();
  if (!cmd) return;
  ST._cmdHistory.push(cmd);
  ST._cmdHistoryIdx = ST._cmdHistory.length;
  SOCK.emit('cmd', { id: ST.activeId, cmd });
  input.value = '';
}
function handleCmdKey(e) {
  if (e.key === 'Enter') { e.preventDefault(); sendCmd(); return; }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (ST._cmdHistoryIdx === ST._cmdHistory.length) ST._cmdInputVal = e.target.value;
    if (ST._cmdHistoryIdx > 0) { ST._cmdHistoryIdx--; e.target.value = ST._cmdHistory[ST._cmdHistoryIdx]; }
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (ST._cmdHistoryIdx < ST._cmdHistory.length - 1) { ST._cmdHistoryIdx++; e.target.value = ST._cmdHistory[ST._cmdHistoryIdx]; }
    else if (ST._cmdHistoryIdx === ST._cmdHistory.length - 1) { ST._cmdHistoryIdx++; e.target.value = ST._cmdInputVal; }
  }
}
function renderInventory(b) {
  const items = b._inventory || [];
  if (!items.length) {
    DOM.tabContent.innerHTML = `<div class="inv-empty"><div style="font-size:48px;opacity:0.15;margin-bottom:12px">🎒</div><div style="font-size:14px;font-weight:600;color:var(--text-3);margin-bottom:4px">Túi đồ trống</div><div style="font-size:11px;color:var(--text-3)">Bot chưa nhận được dữ liệu inventory</div></div>`;
    return;
  }
  let html = `<div class="inv-header"><span class="inv-header-count">${items.length} món</span><span class="inv-header-hint">Hotbar = 🟡 vàng</span></div><div class="inv-grid">`;
  for (const item of items) {
    const icon = itemIcon(item); const slotColor = itemSlotColor(item.slot);
    const slotNum = parseInt(item.slot,10);
    const isHotbar = !isNaN(slotNum)&&slotNum<9;
    const isArmor = /helmet|chestplate|leggings|boots|mũ|nón|áo|giáp|quần|giày/i.test(item.name||'');
    const durability = item.durability !== undefined ? `<span style="color:var(--warn);font-family:var(--font-mono);font-size:9px">Durability: ${item.durability}</span>` : '';
    const metadata = item.metadata ? `<span style="color:var(--text-3);font-family:var(--font-mono);font-size:9px">${esc(JSON.stringify(item.metadata).slice(0, 50))}</span>` : '';
    html += `<div class="inv-item ${isHotbar?'hotbar':''} ${isArmor?'armor':''}">
      <div class="inv-slot-bg" style="border-color:${slotColor};background:${slotColor}15"><span class="inv-slot" style="color:${slotColor}">${item.slot}</span></div>
      <span class="inv-icon">${icon}</span>
      <div class="inv-detail"><div class="inv-name">${esc(item.name||'Vật phẩm')}</div>${item.type?`<div class="inv-type">${esc(item.type)}</div>`:''}${durability}${metadata}</div>
      <div class="inv-count">${item.count>1?'×'+item.count.toLocaleString():''}</div>
    </div>`;
  }
  html += '</div>';
  DOM.tabContent.innerHTML = html;
}
function itemIcon(item) {
  const name = (item.name||'').toLowerCase();
  if (/sword|kiếm|gươm/i.test(name)) return '⚔️'; if (/pickaxe|pick/i.test(name)) return '⛏️'; if (/axe|rìu/i.test(name)) return '🪓'; if (/shovel|xẻng/i.test(name)) return '🪪'; if (/hoe|cuốc/i.test(name)) return '🌿';
  if (/helmet|mũ|nón/i.test(name)) return '🪖'; if (/chestplate|áo|giáp|chest/i.test(name)) return '👕'; if (/leggings|quần|legging/i.test(name)) return '👖'; if (/boots|giày|boot|dày/i.test(name)) return '👟';
  if (/bow|cung/i.test(name)) return '🏹'; if (/food|thức ăn|apple|táo|steak|bread|bánh|meat|thịt|cá|fish|cake/i.test(name)) return '🍖';
  if (/block|đất|dirt|stone|đá|sand|cát|wood|gỗ|plank|ván/i.test(name)) return '🧱'; if (/ore|quặng|iron|sắt|gold|vàng|diamond|kim cương|coal|than|emerald|lapis/i.test(name)) return '💎';
  if (/potion|thuốc/i.test(name)) return '🧪'; if (/book|sách/i.test(name)) return '📖'; if (/totem/i.test(name)) return '💿'; if (/elytra/i.test(name)) return '🪷'; if (/shield|khiên/i.test(name)) return '🛡️';
  return '📦';
}
function itemSlotColor(slot) {
  const s = parseInt(slot,10);
  if (isNaN(s)) return 'var(--text-3)'; if (s<9) return 'var(--warn)'; if (s<36) return 'var(--text-2)'; return 'var(--text-3)';
}
function renderCommands(b) {
  const customCmds = b._customCmds || [];
  let html = '<div class="cmd-section"><div class="cmd-section-title">Lệnh hệ thống</div><div class="cmd-list">';
  const sysCommands = [
    { name:'shard',label:'Shard',desc:'Bật/tắt tự động đập shard',icon:'💠'},{ name:'stats',label:'Stats',desc:'Bật/tắt tự động xem stats',icon:'📊'},
    { name:'tshard',label:'Treo Shard',desc:'Gửi /warp afk (Treo Shard)',icon:'💤'},{ name:'afk',label:'AFK Jump',desc:'Bật/tắt nhảy AFK',icon:'🤸'},
    { name:'wafk',label:'AFK Walk',desc:'Bật/tắt đi bộ AFK',icon:'🚶'},{ name:'autoeat',label:'Auto Eat',desc:'Bật/tắt tự động ăn khi đói',icon:'🍖'},
    { name:'stop',label:'Dừng AFK',desc:'Dừng mọi hoạt động AFK',icon:'⏹️'},{ name:'tpa',label:'TPA',desc:'Gửi yêu cầu TPA đến chủ',icon:'📬'},
    { name:'ping',label:'Ping',desc:'Hiển thị độ trễ mạng',icon:'📡'},{ name:'pos',label:'Vị trí',desc:'Hiển thị tọa độ hiện tại',icon:'📍'},
    { name:'inv',label:'Inventory',desc:'Hiển thị đồ trong túi',icon:'🎒'},{ name:'status',label:'Trạng thái',desc:'Hiển thị trạng thái bot',icon:'👓'},
    { name:'reconnect',label:'Reconnect',desc:'Ngắt kết nối và kết nối lại',icon:'🔄'},
    { name:'menu',label:'Menu',desc:'Gửi lệnh menu',icon:'📋'},
  ];
  for (const c of sysCommands) {
    html += `<div class="cmd-item" onclick="SOCK.emit('cmd',{id:'${esc(b.id)}',cmd:'${c.name}'});toast('Đã gửi: ${c.label}')"><span class="cmd-icon">${c.icon}</span><span class="cmd-name">${c.label}</span><span class="cmd-arrow">→</span><span class="cmd-value">${c.desc}</span><span class="cmd-tag">/${c.name}</span></div>`;
  }
  html += '</div></div><div class="cmd-section"><div class="cmd-section-title">Lệnh tùy chỉnh</div><div class="cmd-list" id="custom-cmd-list">';
  if (customCmds.length) {
    for (const c of customCmds) {
      html += `<div class="cmd-item"><span class="cmd-icon">⭐</span><span class="cmd-name">${esc(c.name)}</span><span class="cmd-arrow">→</span><span class="cmd-value">${esc(c.cmd)}</span><span class="cmd-del" onclick="event.stopPropagation();delCustomCmd('${esc(c.name)}')" title="Xóa">✕</span></div>`;
    }
  } else {
    html += '<div style="color:var(--text-3);font-size:11px;padding:8px">Chưa có lệnh tùy chỉnh nào</div>';
  }
  html += '</div><div class="cmd-add-row"><input id="new-cmd-name" placeholder="tên lệnh" maxlength="20"><input id="new-cmd-val" placeholder="nội dung lệnh"><button class="btn btn-primary btn-sm" onclick="addCustomCmd()">+ Thêm</button></div></div>';
  DOM.tabContent.innerHTML = html;
}
function addCustomCmd() {
  const name = ($('new-cmd-name')?.value||'').trim(); const cmd = ($('new-cmd-val')?.value||'').trim();
  if (!name||!cmd||!ST.activeId) return;
  SOCK.emit('addCustomCmd', { id:ST.activeId, name, cmd }); toast('Đã thêm: '+name,'success');
}
function delCustomCmd(name) { if(!ST.activeId)return; SOCK.emit('delCustomCmd',{id:ST.activeId,name}); toast('Đã xóa: '+name,'warn'); }
function renderConfig(b) {
  DOM.tabContent.innerHTML =
    `<div class="cfg-section"><div class="cfg-section-title">Cấu hình Bot</div>
      <div class="cfg-row"><span class="cfg-label">Tự động Menu</span><label class="toggle"><input type="checkbox" ${b.cfg?.autoMenu?'checked':''} onchange="updateCfg('autoMenu',this.checked)"><span class="toggle-slider"></span></label></div>
      <div class="cfg-row"><span class="cfg-label">Dùng Proxy</span><label class="toggle"><input type="checkbox" ${b.cfg?.useProxy?'checked':''} onchange="updateCfg('useProxy',this.checked)"><span class="toggle-slider"></span></label></div>
      <div class="cfg-row"><span class="cfg-label">Gửi Settings Packet</span><label class="toggle"><input type="checkbox" ${b.cfg?.sendClientSettings!==false?'checked':''} onchange="updateCfg('sendClientSettings',this.checked)"><span class="toggle-slider"></span></label></div>
      <div class="cfg-row"><span class="cfg-label">Bỏ qua Validate Packet</span><label class="toggle"><input type="checkbox" ${b.cfg?.skipValidation?'checked':''} onchange="updateCfg('skipValidation',this.checked)"><span class="toggle-slider"></span></label></div>
      <div class="cfg-row"><span class="cfg-label">View Distance Tiny</span><label class="toggle"><input type="checkbox" ${b.cfg?.viewDistance==='tiny'?'checked':''} onchange="updateCfg('viewDistance',this.checked?'tiny':null)"><span class="toggle-slider"></span></label></div>
      <div class="cfg-row"><span class="cfg-label">Lệnh Menu</span><input class="cfg-input" value="${esc(b.cfg?.menuCommand||'')}" onchange="updateCfg('menuCommand',this.value)"></div>
      <div class="cfg-row"><span class="cfg-label">Tên chủ bot</span><input class="cfg-input" value="${esc(b.cfg?.ownerUsername||'')}" onchange="updateCfg('ownerUsername',this.value)"></div>
      <div class="cfg-row"><span class="cfg-label">Mật khẩu bot</span><input class="cfg-input" value="${esc(b.cfg?.botPassword||'')}" onchange="updateCfg('botPassword',this.value)" type="password"></div>
    </div>
    <div class="cfg-section"><div class="cfg-section-title">Thông tin máy chủ</div>
      <div class="cfg-row"><span class="cfg-label">Địa chỉ</span><span style="font-family:var(--font-mono);color:var(--accent)">${esc(b.host)}:${b.port}</span></div>
      <div class="cfg-row"><span class="cfg-label">Tài khoản</span><span style="font-family:var(--font-mono);color:var(--text)">${esc(b.username)}</span></div>
      <div class="cfg-row"><span class="cfg-label">Phiên bản</span><span style="font-family:var(--font-mono);color:var(--text-2)">${esc(b.version||'—')}</span></div>
    </div>`;
}
function updateCfg(key,value) {
  if(!ST.activeId)return;
  fetch('/api/bots/'+ST.activeId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({[key]:value})})
    .then(r=>r.json()).then(d=>{
      if(d.ok){ const label=typeof value==='boolean'?(value?'BẬT: ':'TẮT: '):'Đã cập nhật: ';
        toast(d.needsRestart?label+key+' ⚠️ Cần restart':label+key+' ✔ Đã lưu',d.needsRestart?'warn':'success'); }
      else toast('Lỗi: '+(d.error||'không xác định'),'error');
    }).catch(()=>toast('Cập nhật thất bại','error'));
}
function countryFlag(code) {
  if(!code||code.length!==2) return '🌐'; const a=0x1F1E6-0x41+code.charCodeAt(0),b=0x1F1E6-0x41+code.charCodeAt(1); return String.fromCodePoint(a,b);
}
function qualityLabel(q) {
  switch(q){ case'excellent':return{text:'⚡ Excellent',cls:'ql-excellent'}; case'good':return{text:'✓ Good',cls:'ql-good'}; case'fair':return{text:'△ Fair',cls:'ql-fair'}; case'slow':return{text:'✗ Slow',cls:'ql-slow'}; default:return{text:'',cls:''}; }
}
function qualityScore(q) { switch(q){ case'excellent':return 0; case'good':return 1; case'fair':return 2; case'slow':return 3; default:return 99; } }
function statusScore(s) { switch(s){ case'live':return 0; case'unknown':return 1; case'timeout':return 2; case'die':return 3; case'auth_fail':return 4; default:return 9; } }
function getFilteredProxies() {
  const filter=ST._proxyFilter,search=(ST._proxySearch||'').toLowerCase();
  return ST.proxies.filter(p=>{
    if(filter==='live'&&p.status!=='live') return false;
    if(filter==='dead'&&(p.status==='live'||p.status==='unknown')) return false;
    if(filter==='unknown'&&p.status!=='unknown') return false;
    if(search){ const hay=(p.host+':'+p.port+' '+p.type+' '+(p.tag||'')+' '+(p.geo?.country||'')+' '+(p.geo?.city||'')).toLowerCase(); if(!hay.includes(search))return false; }
    return true;
  });
}
function getSortedProxies(list) {
  const {col,asc}=ST._proxySort; if(!col||!list.length)return list;
  return [...list].sort((a,b)=>{
    let va,vb;
    switch(col){ case'ping':va=a.ping<0?Infinity:a.ping;vb=b.ping<0?Infinity:b.ping;break; case'quality':va=qualityScore(a.quality);vb=qualityScore(b.quality);break; case'country':va=(a.geo?.country||'\uffff').toLowerCase();vb=(b.geo?.country||'\uffff').toLowerCase();break; case'type':va=a.type||'';vb=b.type||'';break; case'host':va=(a.host||'')+':'+(a.port||'');vb=(b.host||'')+':'+(b.port||'');break; case'status':va=statusScore(a.status);vb=statusScore(b.status);break; case'tag':va=a.tag||'';vb=b.tag||'';break; default:return 0; }
    if(va<vb)return asc?-1:1; if(va>vb)return asc?1:-1; return 0;
  });
}
function setProxySort(col) { if(ST._proxySort.col===col){ if(ST._proxySort.asc)ST._proxySort.asc=false; else{ST._proxySort.col=null;ST._proxySort.asc=true} }else{ST._proxySort.col=col;ST._proxySort.asc=true} renderProxyTab(); }
function sortIcon(col) { if(ST._proxySort.col!==col)return'<span class="sort-arrow">△▽</span>'; return ST._proxySort.asc?'<span class="sort-arrow asc">▲</span>':'<span class="sort-arrow desc">▼</span>'; }
function setProxyFilter(filter) { ST._proxyFilter=filter; renderProxyTab(); }
function setProxySearch(val) { ST._proxySearch=val; renderProxyTab(); }
let _proxyTestProgress = false;
function renderProxyTab(botParam) {
  const b = botParam || null;
  const proxies = ST.proxies;
  const filtered = getFilteredProxies();
  const sorted = getSortedProxies(filtered);
  const liveCount = proxies.filter(p=>p.status==='live').length;
  const deadCount = proxies.filter(p=>p.status==='die'||p.status==='auth_fail'||p.status==='timeout').length;
  const unkCount = proxies.filter(p=>p.status==='unknown').length;
  let html = '<div class="proxy-section"><div class="proxy-section-hdr"><div class="sec-label">Proxy List ('+proxies.length+')</div><span class="sp"></span>';
  html += '<button class="btn btn-primary btn-sm" onclick="openModal(\'overlay-add-proxy\')" aria-label="Thêm proxy">+ Add Proxy</button>';
  html += '<button class="btn btn-ghost btn-sm" onclick="testAllProxies()" aria-label="Test tất cả proxy">↳ Test All</button>';
  html += '<button class="btn btn-ghost btn-sm" onclick="upgradeAllProxies()" aria-label="Nâng cấp tất cả proxy">☁ Upgrade All</button></div>';
  html += '<div class="proxy-filter-bar"><div class="proxy-filter-pills">';
  html += `<button class="proxy-filter-pill ${ST._proxyFilter==='all'?'active':''}" onclick="setProxyFilter('all')">All <span class="pill-cnt">${proxies.length}</span></button>`;
  html += `<button class="proxy-filter-pill live ${ST._proxyFilter==='live'?'active':''}" onclick="setProxyFilter('live')">● Live <span class="pill-cnt">${liveCount}</span></button>`;
  html += `<button class="proxy-filter-pill dead ${ST._proxyFilter==='dead'?'active':''}" onclick="setProxyFilter('dead')">● Dead <span class="pill-cnt">${deadCount}</span></button>`;
  html += `<button class="proxy-filter-pill unknown ${ST._proxyFilter==='unknown'?'active':''}" onclick="setProxyFilter('unknown')">○ Unknown <span class="pill-cnt">${unkCount}</span></button>`;
  html += '</div><div style="display:flex;align-items:center;gap:6px">';
  html += `<input class="proxy-search" id="proxy-search" placeholder="🔍 Tìm kiếm..." value="${esc(ST._proxySearch)}" oninput="setProxySearch(this.value)">`;
  html += `<button class="proxy-view-btn ${ST._proxyViewMode==='list'?'active':''}" onclick="ST._proxyViewMode='list';renderProxyTab()" title="List view">☰</button>`;
  html += `<button class="proxy-view-btn ${ST._proxyViewMode==='table'?'active':''}" onclick="ST._proxyViewMode='table';renderProxyTab()" title="Table view">⊞</button>`;
  if (window.innerWidth < 600) html += `<button class="proxy-view-btn ${ST._proxyViewMode==='card'?'active':''}" onclick="ST._proxyViewMode='card';renderProxyTab()" title="Card view">▦</button>`;
  html += '</div></div>';
  if (_proxyTestProgress) {
    html += '<div class="proxy-progress"><div class="proxy-progress-bar" id="proxy-progress-bar" style="width:0%"></div><span id="proxy-progress-text">Testing...</span></div>';
  }
  if (!sorted.length) {
    html += `<div class="proxy-empty"><div class="proxy-empty-icon">🔀</div><div class="proxy-empty-msg">${proxies.length===0?'Chưa có proxy nào':'Không tìm thấy proxy khớp'}</div>${proxies.length===0?'<button class="btn btn-primary btn-sm" onclick="openModal(&quot;overlay-add-proxy&quot;)" style="margin-top:8px">＋ Thêm proxy đầu tiên</button>':''}</div>`;
  } else if (ST._proxyViewMode === 'card') {
    html += renderProxyCards(sorted, b);
  } else if (ST._proxyViewMode === 'table') {
    html += renderProxyTable(sorted, b);
  } else {
    html += renderProxyList(sorted, b);
  }
  html += '</div>';
  DOM.tabContent.innerHTML = html;
}
function renderProxyCards(proxies, b) {
  let html = '<div class="proxy-card-grid">';
  proxies.forEach(p => {
    const realIdx = ST.proxies.indexOf(p);
    const statusCls = p.status||'unknown';
    const pingStr = p.ping>=0?p.ping+'ms':'—';
    const qual = qualityLabel(p.quality);
    const geo = p.geo;
    const flag = geo?countryFlag(geo.countryCode):'';
    const loc = geo?`${flag} ${esc(geo.country||'')}${geo.city?' / '+esc(geo.city):''}`:'';
    html += `<div class="proxy-card ${statusCls==='live'?'live':statusCls==='die'||statusCls==='auth_fail'||statusCls==='timeout'?'dead':'unknown'}">
      <div class="proxy-card-hdr"><span class="proxy-type">${esc(p.type)}</span><span class="proxy-status ${statusCls}">${statusCls}</span></div>
      <div class="proxy-card-host">${esc(p.host)}:${p.port}${p.user?' 🔒':''}</div>
      <div class="proxy-card-meta"><span>Ping: ${pingStr}</span>${qual.text?`<span class="quality-badge ${qual.cls}">${qual.text}</span>`:''}</div>
      ${loc?`<div class="proxy-card-geo" title="${esc(geo?.isp||geo?.org||'')}">${loc}</div>`:''}
      ${p.tag?`<div class="proxy-card-tag">${esc(p.tag)}</div>`:''}
      <div class="proxy-card-actions">
        <button class="proxy-btn test" onclick="testProxy(${realIdx})" title="Test" aria-label="Test proxy">↳</button>
        <button class="proxy-btn enrich" onclick="upgradeProxy(${realIdx})" title="Upgrade" aria-label="Nâng cấp proxy">☁</button>
        ${b?`<button class="proxy-btn assign" onclick="assignProxy('${esc(b.id)}',${realIdx})" title="Assign" aria-label="Gán proxy cho bot">→</button>`:''}
        <button class="proxy-btn del" onclick="deleteProxy(${realIdx})" title="Delete" aria-label="Xóa proxy">✕</button>
      </div>
    </div>`;
  });
  html += '</div>';
  return html;
}
function renderProxyList(proxies, b) {
  let html = '<div class="proxy-list" id="proxy-list"><div class="proxy-list-hint">'+proxies.length+' proxy(s) — click headers to sort</div>';
  proxies.forEach(p => {
    const realIdx = ST.proxies.indexOf(p);
    const statusCls = p.status||'unknown';
    const pingStr = p.ping>=0?p.ping+'ms':'—';
    const qual = qualityLabel(p.quality);
    const geo = p.geo;
    const flag = geo?countryFlag(geo.countryCode):'';
    const loc = geo?`${flag} ${esc(geo.country||'')}${geo.city?' / '+esc(geo.city):''}`:'';
    html += `<div class="proxy-row ${statusCls==='live'?'live':statusCls==='die'||statusCls==='auth_fail'||statusCls==='timeout'?'dead':'unknown'}" data-proxy-idx="${realIdx}">
      <span class="proxy-idx">${realIdx}</span><span class="proxy-type">${esc(p.type)}</span><span class="proxy-host">${esc(p.host)}:${p.port}</span>${p.user?'<span class="proxy-auth">🔒</span>':''}
      <span class="proxy-status ${statusCls}">${statusCls}</span><span class="proxy-ping">${pingStr}</span>
      ${qual.text?`<span class="quality-badge ${qual.cls}">${qual.text}</span>`:''}
      ${loc?`<span class="proxy-geo" title="${esc(geo?.isp||geo?.org||'')}">${loc}</span>`:''}
      ${p.tag?`<span class="proxy-tag">${esc(p.tag)}</span>`:''}
      <div class="proxy-actions"><button class="proxy-btn test" onclick="testProxy(${realIdx})" title="Test" aria-label="Test proxy">↳</button><button class="proxy-btn enrich" onclick="upgradeProxy(${realIdx})" title="Upgrade" aria-label="Nâng cấp proxy">☁</button>${b?`<button class="proxy-btn assign" onclick="assignProxy('${esc(b.id)}',${realIdx})" title="Assign" aria-label="Gán proxy">→</button>`:''}<button class="proxy-btn del" onclick="deleteProxy(${realIdx})" title="Delete" aria-label="Xóa proxy">✕</button></div>
    </div>`;
  });
  html += '</div>';
  return html;
}
function renderProxyTable(proxies, b) {
  let html = '<div class="proxy-table-wrap"><table class="proxy-table"><thead><tr>';
  const cols = [{key:null,label:'#',cls:'col-idx',sortable:false},{key:'type',label:'Type',cls:'col-type',sortable:true},{key:'host',label:'Host:Port',cls:'col-host',sortable:true},{key:'status',label:'Status',cls:'col-status',sortable:true},{key:'ping',label:'Ping',cls:'col-ping',sortable:true},{key:'quality',label:'Quality',cls:'col-quality',sortable:true},{key:'country',label:'Country',cls:'col-country',sortable:true},{key:'tag',label:'Tag',cls:'col-tag',sortable:true},{key:null,label:'',cls:'col-actions',sortable:false}];
  for (const c of cols) {
    if (c.sortable) html += `<th class="proxy-th ${c.cls} sortable${ST._proxySort.col===c.key?' sorted':''}" onclick="setProxySort('${c.key}')">${c.label} ${sortIcon(c.key)}</th>`;
    else html += `<th class="proxy-th ${c.cls}">${c.label}</th>`;
  }
  html += '</tr></thead><tbody>';
  proxies.forEach(p => {
    const realIdx = ST.proxies.indexOf(p);
    const statusCls = p.status||'unknown';
    const pingStr = p.ping>=0?p.ping+'ms':'—';
    const qual = qualityLabel(p.quality);
    const geo = p.geo;
    const flag = geo?countryFlag(geo.countryCode):'';
    html += `<tr class="proxy-tr ${statusCls}" data-proxy-idx="${realIdx}">
      <td class="proxy-td col-idx">${realIdx}</td><td class="proxy-td col-type"><span class="proxy-type-badge">${esc(p.type)}</span></td><td class="proxy-td col-host">${esc(p.host)}:${p.port}${p.user?' <span class="proxy-auth-inline">🔒</span>':''}</td>
      <td class="proxy-td col-status"><span class="proxy-status ${statusCls}">${statusCls}</span></td><td class="proxy-td col-ping"><span class="proxy-ping-val">${pingStr}</span></td>
      <td class="proxy-td col-quality">${qual.text?`<span class="quality-badge ${qual.cls}">${qual.text}</span>`:'<span style="color:var(--text-3)">—</span>'}</td>
      <td class="proxy-td col-country">${geo?`${flag} <span class="proxy-geo-text">${esc(geo.country||'')}${geo.city?' / '+esc(geo.city):''}</span>`:'<span style="color:var(--text-3)">—</span>'}</td>
      <td class="proxy-td col-tag">${p.tag?`<span class="proxy-tag">${esc(p.tag)}</span>`:'<span style="color:var(--text-3)">—</span>'}</td>
      <td class="proxy-td col-actions"><button class="proxy-btn test" onclick="testProxy(${realIdx})" title="Test" aria-label="Test proxy">↳</button><button class="proxy-btn enrich" onclick="upgradeProxy(${realIdx})" title="Upgrade" aria-label="Nâng cấp proxy">☁</button>${b?`<button class="proxy-btn assign" onclick="assignProxy('${esc(b.id)}',${realIdx})" title="Assign" aria-label="Gán proxy">→</button>`:''}<button class="proxy-btn del" onclick="deleteProxy(${realIdx})" title="Delete" aria-label="Xóa proxy">✕</button></td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  return html;
}
function testProxy(idx) {
  const row = document.querySelector(`[data-proxy-idx="${idx}"]`);
  if(row) row.style.opacity='0.5';
  fetch('/api/proxies/test/'+idx,{method:'POST'}).then(r=>r.json()).then(d=>{
    if(row) row.style.opacity='';
    if(d.ok){ const geo=d.geo; const loc=geo?(geo.country||'')+(geo.city?' / '+geo.city:''):''; toast(`${d.type} | ${d.ping}ms ${d.quality} ${loc?'| '+countryFlag(geo?.countryCode)+' '+loc:''}`, 'success'); }
    else toast(`${d.status||'dead'}${d.error?': '+d.error:''}`, 'error');
    refreshProxies();
  }).catch(()=>{ if(row)row.style.opacity=''; toast('Test failed','error'); });
}
function testAllProxies() {
  _proxyTestProgress = true;
  const total = ST.proxies.length;
  let done = 0;
  toast('Testing ' + total + ' proxies...', 'warn');
  const concurrency = 5;
  function runBatch(startIdx) {
    if (startIdx >= total) {
      _proxyTestProgress = false;
      refreshProxies();
      toast('Done: ' + done + '/' + total + ' tested', 'success');
      return;
    }
    const batch = [];
    for (let i = startIdx; i < Math.min(startIdx + concurrency, total); i++) {
      batch.push(
        fetch('/api/proxies/test/' + i, { method: 'POST' }).then(r => r.json()).then(() => { done++; })
          .catch(() => { done++; })
      );
    }
    Promise.all(batch).then(() => {
      const pct = Math.round((done / total) * 100);
      const bar = $('proxy-progress-bar');
      const text = $('proxy-progress-text');
      if (bar) bar.style.width = pct + '%';
      if (text) text.textContent = done + '/' + total;
      setTimeout(() => runBatch(startIdx + concurrency), 50);
    });
  }
  runBatch(0);
}
function upgradeProxy(idx) {
  const row = document.querySelector(`[data-proxy-idx="${idx}"]`);
  if(row) row.style.opacity='0.5';
  fetch('/api/proxies/upgrade/'+idx,{method:'POST'}).then(r=>r.json()).then(d=>{
    if(row) row.style.opacity='';
    if(d.ok){ const geo=d.geo; const loc=geo?(geo.country||'')+(geo.city?' / '+geo.city:''):''; toast(`Upgraded: ${d.type} | ${d.ping}ms ${d.quality} ${loc?'| '+countryFlag(geo?.countryCode)+' '+loc:''}`, 'success'); }
    else toast(`Upgrade: ${d.status||'failed'}`, 'error');
    refreshProxies();
  }).catch(()=>{ if(row)row.style.opacity=''; toast('Upgrade failed','error'); });
}
function upgradeAllProxies() {
  toast('Upgrading all proxies...', 'warn');
  fetch('/api/proxies/upgrade-all',{method:'POST'}).then(r=>r.json()).then(d=>{
    if(d.ok){ const live=d.results.filter(r=>r.ok).length; toast(`Upgraded: ${live}/${d.results.length} live`, live===d.results.length?'success':'warn'); }
    refreshProxies();
  }).catch(()=>toast('Upgrade all failed','error'));
}
function assignProxy(botId, proxyIdx) {
  const proxy = ST.proxies[proxyIdx];
  fetch('/api/bots/'+botId+'/assign-proxy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({proxyIdx,proxyId:proxy?.id})})
    .then(r=>r.json()).then(d=>{ if(d.ok) toast('Proxy assigned!','success'); else toast('Assign failed','error'); })
    .catch(()=>toast('Assign failed','error'));
}
function deleteProxy(idx) {
  if(!confirm('Delete proxy #'+idx+'?')) return;
  fetch('/api/proxies/'+idx,{method:'DELETE'}).then(r=>r.json()).then(d=>{
    if(d.ok){ toast('Proxy deleted','success'); refreshProxies(); }
    else toast('Delete failed','error');
  });
}
function refreshProxies() {
  fetch('/api/proxies').then(r=>r.json()).then(d=>{
    ST.proxies=d;
    if(ST.activeTab==='proxy'){
      if(ST.activeId){ const b=ST.bots.find(x=>x.id===ST.activeId); if(b) renderProxyTab(b); }
      else renderProxyTab();
    }
  });
}
function renderStats(b) {
  const pingData = b._pingHistory || [];
  const pktData = b._pktHistory || [];
  const uptime = b.loginTime ? fmtUptime((Date.now() - b.loginTime) / 1000) : '—';
  const cmdsPerMin = Math.round(((b.ppsIn || 0) + (b.ppsOut || 0)) * 0.6); 
  let html = `<div class="sec-label">Thống kê Bot</div>
    <div class="stats-grid">
      <div class="stats-card">
        <div class="stats-card-header"><span class="stats-card-title">Trạng thái</span></div>
        <div class="stats-card-value ${b.state==='ONLINE'?'online':'offline'}">${b.state}</div>
        <div class="stats-card-sub">${b.registered===false?'Chưa đăng ký':b.registered===true?'Đã đăng ký':''}</div>
      </div>
      <div class="stats-card">
        <div class="stats-card-header"><span class="stats-card-title">Ping</span></div>
        <div class="stats-card-value accent">${b.ping>=0?b.ping+'ms':'—'}</div>
        <div class="stats-card-sub">Latency trung bình</div>
      </div>
      <div class="stats-card">
        <div class="stats-card-header"><span class="stats-card-title">Uptime</span></div>
        <div class="stats-card-value accent">${uptime}</div>
        <div class="stats-card-sub">Thời gian hoạt động</div>
      </div>
      <div class="stats-card">
        <div class="stats-card-header"><span class="stats-card-title">Packet Rate</span></div>
        <div class="stats-card-value accent">${(b.ppsIn||0)+(b.ppsOut||0)}/s</div>
        <div class="stats-card-sub">↓${b.ppsIn||0} ↑${b.ppsOut||0}</div>
      </div>
    </div>`;
  if (pingData.length > 1) {
    html += `<div class="mini-chart-wrap"><canvas class="mini-chart" id="stats-ping-chart" width="600" height="80"></canvas><div class="mini-chart-label">Ping History (30s)</div></div>`;
  }
  if (pktData.length > 1) {
    html += `<div class="mini-chart-wrap"><canvas class="mini-chart" id="stats-pkt-chart" width="600" height="80"></canvas><div class="mini-chart-label">Packet Rate History (30s)</div></div>`;
  }
  html += `<div class="sec-label">Thông tin chi tiết</div>
    <div class="conn-grid">
      <div class="conn-item"><span class="conn-label">Shard</span><span class="conn-value">${b.shard>0?b.shard.toLocaleString():'—'}</span></div>
      <div class="conn-item"><span class="conn-label">Health</span><span class="conn-value">${b.health??20} ❤</span></div>
      <div class="conn-item"><span class="conn-label">Food</span><span class="conn-value">${b.food??20} 🍗</span></div>
      <div class="conn-item"><span class="conn-label">Reconnects</span><span class="conn-value">${b.reconnects||0}</span></div>
      <div class="conn-item"><span class="conn-label">Menu Success</span><span class="conn-value">${b.menuSuccess?'✓ Yes':'✗ No'}</span></div>
      <div class="conn-item"><span class="conn-label">Menu Retries</span><span class="conn-value">${b.menuRetries||0}</span></div>
      <div class="conn-item"><span class="conn-label">AFK Mode</span><span class="conn-value">${b.afk||'—'}</span></div>
      <div class="conn-item"><span class="conn-label">Treo Shard</span><span class="conn-value">${b.tshard?'✓ Bật':'✗ Tắt'}</span></div>
    </div>`;
  DOM.tabContent.innerHTML = html;
  requestAnimationFrame(() => {
    if (pingData.length > 1) drawLineChart('stats-ping-chart', pingData, 'var(--accent)', 'ms');
    if (pktData.length > 1) drawLineChart('stats-pkt-chart', pktData, 'var(--online)', '/s');
  });
}
function renderSystem() {
  const m = ST._sysMetrics||{};
  const memPercent = m.memPercent||0;
  const barCls = memPercent>80?'danger':memPercent>60?'warn':'';
  const env = ST.serverEnv;
  DOM.tabContent.innerHTML =
    `<div class="sys-section"><div class="sys-section-title">System</div>
      <div class="sys-grid">
        <div class="sys-card"><div class="sys-card-label">Memory</div><div class="sys-card-value">${fmtBytes(m.procHeap||0)}</div><div class="sys-card-sub">RSS: ${fmtBytes(m.procRss||0)}</div>
          <div class="bar-wrap"><div class="bar-track"><div class="bar-fill ${barCls}" style="width:${memPercent}%"></div></div><div class="bar-pct">${memPercent}% of ${fmtMem(m.totalMem||0)}</div></div></div>
        <div class="sys-card"><div class="sys-card-label">CPU</div><div class="sys-card-value" style="font-size:13px">${m.cpuModel||'—'}</div><div class="sys-card-sub">${m.cpuCount||0} cores</div></div>
        <div class="sys-card"><div class="sys-card-label">Load Avg</div><div class="sys-card-value">${(m.loadAvg||[0,0,0]).map(n=>n.toFixed(1)).join(' ')}</div></div>
        <div class="sys-card"><div class="sys-card-label">Uptime</div><div class="sys-card-value">${fmtUptime(m.uptime||0)}</div></div>
        <div class="sys-card"><div class="sys-card-label">Node.js</div><div class="sys-card-value">${m.nodeVersion||'—'}</div></div>
        <div class="sys-card"><div class="sys-card-label">Platform</div><div class="sys-card-value">${m.platform||'—'} ${m.arch||''}</div></div>
      </div>
    </div>
    <div class="sys-section"><div class="sys-section-title">Environment</div>
      <div class="sys-grid">${env?Object.entries(env).map(([k,v])=>`<div class="sys-card"><div class="sys-card-label">${k}</div><div class="sys-card-value" style="font-size:13px">${typeof v==='boolean'?(v?'✅':'❌'):esc(String(v))}</div></div>`).join(''):'<div style="color:var(--text-3)">—</div>'}
      </div>
    </div>`;
}
function toggleTshard(id) {
  const b = ST.bots.find(x=>x.id===id);
  if (!b) return;
  SOCK.emit('cmd', { id, cmd: 'tshard' });
  b.tshard = !b.tshard;
  renderActionBar();
  toast(b.tshard ? '💤 Treo Shard: BẬT' : '💤 Treo Shard: TẮT', b.tshard ? 'success' : 'warn');
}
function startBot(id) { SOCK.emit('startBot',{id},r=>{if(r&&!r.ok) toast(r.message,'error')}); }
function stopBot(id) { if(!confirm('Stop bot '+id+'?'))return; SOCK.emit('stopBot',{id}); }
function reconnectBot(id) { SOCK.emit('reconnect_bot',{id}); toast('Reconnecting...','warn'); }
function removeBot(id) { if(!confirm('Remove bot '+id+'?'))return; SOCK.emit('removeBot',{id}); }
function startAll() { fetch('/api/bots/all/start',{method:'POST'}).then(()=>toast('Starting all...')); }
function stopAll() { if(!confirm('Stop ALL bots?'))return; fetch('/api/bots/all/stop',{method:'POST'}).then(()=>toast('Stopping all...')); }
function toggleEditProxySelect() {
  const g = $('edit-bot-proxy-group');
  if(g) g.style.display = $('edit-bot-proxy')?.checked?'':'none';
}
function openEditModal(botId) {
  const b = ST.bots.find(x=>x.id===botId); if(!b)return;
  $('edit-bot-title-id').textContent = botId;
  $('edit-bot-host').value = b.host||'';
  $('edit-bot-port').value = b.port||25565;
  $('edit-bot-user').value = b.username||'';
  $('edit-bot-ver').value = b.version||'';
  $('edit-bot-pass').value = '';
  $('edit-bot-owner').value = b.cfg?.ownerUsername||'';
  $('edit-bot-menu').value = b.cfg?.menuCommand||'/menu';
  $('edit-bot-automenu').checked = !!b.cfg?.autoMenu;
  const proxySel = $('edit-bot-proxy-select');
  if(proxySel){ proxySel.innerHTML='<option value="">-- Không chọn --</option>'; let hasSelection=false;
    for(const p of ST.proxies){ const opt=document.createElement('option'); opt.value=p.id; opt.textContent=`[${p.type}] ${p.host}:${p.port}${p.user?' 🔒':''}${p.tag?' '+p.tag:''}`;
      if(b.proxyId&&b.proxyId===p.id){opt.selected=true;hasSelection=true;b._proxyId=p.id}else if(b._proxyId&&b._proxyId===p.id){opt.selected=true;hasSelection=true}else if(b.proxy&&b.proxy.endsWith(p.host+':'+p.port)&&!hasSelection){opt.selected=true;hasSelection=true;b._proxyId=p.id} proxySel.appendChild(opt); }
    $('edit-bot-proxy').checked = hasSelection||!!b.cfg?.useProxy;
    $('edit-bot-proxy-group').style.display = $('edit-bot-proxy').checked?'':'none';
  } else $('edit-bot-proxy').checked = !!b.cfg?.useProxy;
  openModal('overlay-edit-bot');
}
function saveBot() {
  const id = $('edit-bot-title-id')?.textContent; if(!id)return;
  const data = { id, host:($('edit-bot-host')?.value||'').trim()||undefined, port:parseInt($('edit-bot-port')?.value,10)||undefined, username:($('edit-bot-user')?.value||'').trim()||undefined, version:($('edit-bot-ver')?.value||'').trim()||undefined, password:($('edit-bot-pass')?.value||'').trim()||undefined, ownerUsername:($('edit-bot-owner')?.value||'').trim()||undefined, menuCommand:($('edit-bot-menu')?.value||'').trim()||undefined, autoMenu:$('edit-bot-automenu')?.checked, useProxy:$('edit-bot-proxy')?.checked, proxyId: $('edit-bot-proxy')?.checked ? ($('edit-bot-proxy-select')?.value || undefined) : undefined };
  for(const k of Object.keys(data)){ if(data[k]===undefined || data[k]===null)delete data[k]; }
  SOCK.emit('editBot',data,r=>{ if(r&&r.ok){ closeModal('overlay-edit-bot'); toast('Bot updated: '+id+' ✔ Đã lưu','success'); } else { const errEl=$('edit-bot-err'); if(errEl){errEl.style.display='';errEl.textContent=(r&&r.msg)?r.msg:'Failed'} } });
}
let _pendingAddBot = null;
function addBot() {
  const id=($('new-bot-id')?.value||'').trim(),host=($('new-bot-host')?.value||'').trim(),port=parseInt($('new-bot-port')?.value,10)||25565,username=($('new-bot-user')?.value||'').trim(),version=($('new-bot-ver')?.value||'').trim(),password=($('new-bot-pass')?.value||'').trim(),proxyRaw=($('new-bot-proxy')?.value||'').trim();
  if(!id||!host||!username){ const errEl=$('add-bot-err'); if(errEl){errEl.style.display='';errEl.textContent='id, host, username are required'} return; }
  let proxyIdx=undefined,proxyId=undefined; if(proxyRaw){ if(/^\d+$/.test(proxyRaw))proxyIdx=parseInt(proxyRaw,10); else proxyId=proxyRaw; }
  const payload = {id,host,port,username,password:password||undefined,version:version||undefined,proxyIdx,proxyId};
  if (ST._capacity && ST._capacity.isWarning && ST._capacity.maxRecommended) {
    const currentCount = ST._capacity.currentBots || 0;
    const maxRec = ST._capacity.maxRecommended;
    if (currentCount >= maxRec) {
      const cap = ST._capacity;
      const pct = Math.min(cap.capacityPercent || 100, 999);
      const barCls = pct > 120 ? 'danger' : pct > 90 ? 'warn' : '';
      const usedMB = cap.usedByProcessMB || 0;
      const totalMB = cap.totalMemMB || 0;
      const avgRAM = cap.avgRAMPerBot || 0;
      $('cap-warn-bar').style.width = '0%';
      $('cap-warn-pct').textContent = pct + '%';
      $('cap-warn-stats').innerHTML =
        `<div class="cap-warn-stat"><div class="cap-warn-stat-l">Bot hiện tại</div><div class="cap-warn-stat-v">${currentCount}</div></div>
        <div class="cap-warn-stat"><div class="cap-warn-stat-l">Khuyến nghị tối đa</div><div class="cap-warn-stat-v danger">${maxRec}</div></div>
        <div class="cap-warn-stat"><div class="cap-warn-stat-l">RAM đã dùng</div><div class="cap-warn-stat-v">${usedMB} MB</div></div>
        <div class="cap-warn-stat"><div class="cap-warn-stat-l">RAM / bot</div><div class="cap-warn-stat-v">~${avgRAM} MB</div></div>
        <div class="cap-warn-stat"><div class="cap-warn-stat-l">RAM khả dụng</div><div class="cap-warn-stat-v">${cap.availableMB || 0} MB / ${totalMB} MB</div></div>
        <div class="cap-warn-stat"><div class="cap-warn-stat-l">Bot đang chạy</div><div class="cap-warn-stat-v">${cap.activeBots || 0} active / ${cap.afkBots || 0} afk</div></div>`;
      _pendingAddBot = payload;
      openModal('overlay-capacity-warn');
      requestAnimationFrame(() => {
        const bar = $('cap-warn-bar');
        if (bar) { bar.style.width = Math.min(pct, 100) + '%'; bar.className = 'cap-warn-bar-fill ' + barCls; }
      });
      return;
    }
  }
  _doAddBot(payload);
}
function _doAddBot(payload) {
  _pendingAddBot = null;
  SOCK.emit('addBot',payload,r=>{ if(r&&r.ok){ closeModal('overlay-add-bot'); closeModal('overlay-capacity-warn'); toast('Bot created: '+payload.id+' ✔ Đã lưu','success');  ['new-bot-id','new-bot-host','new-bot-user','new-bot-pass','new-bot-ver','new-bot-proxy','new-bot-port'].forEach(n=>{const el=$(n);if(el)el.value=n==='new-bot-port'?'25565':''}); } else { const errEl=$('add-bot-err'); if(errEl){errEl.style.display='';errEl.textContent=(r&&r.msg)?r.msg:'Failed'} } });
}
function addProxy() {
  const raw=($('new-proxy-raw')?.value||'').trim(),tag=($('new-proxy-tag')?.value||'').trim(); if(!raw)return;
  const manualType=$('proxy-type-select')?.value||'socks5';
  const proxyUrl = buildProxyUrl(raw, manualType);
  const statusEl=$('add-proxy-status'),btn=$('btn-add-proxy');
  if(statusEl){ statusEl.style.display=''; statusEl.textContent='⏳ Đang thêm proxy...'; statusEl.className='form-msg warn'; }
  if(btn)btn.disabled=true;
  fetch('/api/proxies',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({proxy:proxyUrl,tag:tag||undefined})}).then(r=>r.json()).then(d=>{
    if(!d.ok){ if(statusEl){statusEl.textContent='❌ '+(d.msg||'Thêm thất bại');statusEl.className='form-msg error';} if(btn)btn.disabled=false; toast(d.msg||'Proxy không hợp lệ','error'); return; }
    if(statusEl)statusEl.textContent='🔍 Đang kiểm tra live & vị trí...';
    return fetch('/api/proxies').then(r=>r.json()).then(proxies=>{ ST.proxies=proxies; const idx=proxies.findIndex(p=>p.id===d.entry?.id);
      if(idx<0){ closeModal('overlay-add-proxy'); toast(`Đã thêm proxy: ${d.msg} ✔ Đã lưu`,'success'); refreshProxies(); clearProxyForm(); return; }
      return fetch('/api/proxies/upgrade/'+idx,{method:'POST'}).then(r=>r.json()).then(up=>{
        if(statusEl)statusEl.style.display='none'; if(btn)btn.disabled=false; closeModal('overlay-add-proxy');
        const pingInfo=up.ok&&up.ping>=0?` | ${up.ping}ms ${up.quality||''}`:''; const geoInfo=up.geo&&up.geo.country?` | ${countryFlag(up.geo.countryCode)} ${up.geo.country}${up.geo.city?' / '+up.geo.city:''}`:''; const statusInfo=up.ok?'✅ Live'+pingInfo+geoInfo:'⚠️ '+(up.status||'die');
        toast(`Đã thêm proxy: ${d.msg} → ${statusInfo} ✔ Đã lưu`,up.ok?'success':'warn'); refreshProxies(); clearProxyForm();
      });
    });
  }).catch(err=>{ if(statusEl)statusEl.style.display='none'; if(btn)btn.disabled=false; toast('Thêm proxy thất bại: '+(err.message||'lỗi mạng'),'error'); });
}
function clearProxyForm() {
  const raw=$('new-proxy-raw'),tag=$('new-proxy-tag'),status=$('add-proxy-status'),btn=$('btn-add-proxy');
  if(raw)raw.value=''; if(tag)tag.value=''; if(status)status.style.display='none'; if(btn)btn.disabled=false;
}
function buildProxyUrl(raw, type) {
  const s = raw.includes('://') ? raw.split('://')[1] : raw;
  if (s.includes('@')) return type + '://' + s;
  const parts = s.split(':');
  if (parts.length === 4) return type + '://' + parts[0] + ':' + parts[1] + '@' + parts[2] + ':' + parts[3];
  if (parts.length === 3) return type + '://' + parts[0] + ':' + parts[1];
  return type + '://' + s;
}
function renderCapacityBar() {
  const cap = ST._capacity;
  const bar = $('sb-cap');
  if (!bar) return;
  if (!cap || !cap.maxRecommended) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  const pct = Math.min(cap.capacityPercent || 0, 999);
  const barCls = pct > 120 ? 'danger' : pct > 90 ? 'warn' : '';
  $('sb-cap-pct').textContent = pct + '%';
  $('sb-cap-pct').className = 'stat-bar-value' + (barCls ? ' ' + barCls : '');
  $('sb-cap-fill').style.width = Math.min(pct, 100) + '%';
  $('sb-cap-fill').className = 'stat-bar-fill' + (barCls ? ' ' + barCls : '');
  const used = cap.usedByProcessMB || 0;
  const total = cap.totalMemMB || 0;
  const rec = cap.maxRecommended || 0;
  $('sb-cap-info').textContent = cap.currentBots + '/' + rec + ' bots • ' + used + ' MB / ' + total + ' MB';
}
setInterval(() => {
  fetch('/api/capacity').then(r=>r.json()).then(d=>{
    if (d && d.maxRecommended) { ST._capacity = d; renderCapacityBar(); renderSidebarStats(); }
  }).catch(()=>{});
}, 30000);
SOCK.on('init', data => {
  ST.bots = data.bots || [];
  ST.serverEnv = data.serverEnv || {};
  ST.proxies = data.proxies || [];
  ST._summary = data.summary || null;
  ST._capacity = data.capacity || null;
  renderSB();
  renderCapacityBar();
  renderSidebarStats();
  if(ST.activeId){ renderActionBar(); }
  if (!ST.activeId) { renderGlobalDashboard(); }
  else { DOM.noSel.style.display = 'none'; DOM.botView.style.display = ''; DOM.tabs.style.display = ''; renderActionBar(); renderActiveTab(); }
});
SOCK.on('statusUpdate', data => {
  const bots = data.bots || [];
  for (const b of bots) {
    const idx = ST.bots.findIndex(x=>x.id===b.id);
    if (idx >= 0) {
      const old = ST.bots[idx];
      const keyChanged = old.state !== b.state || old.ping !== b.ping || old.ppsIn !== b.ppsIn || old.ppsOut !== b.ppsOut || old.health !== b.health || old.food !== b.food || old.shard !== b.shard;
      ST.bots[idx] = { ...b, _logs: (old._logs?.length > 800 ? old._logs.slice(-400) : old._logs), _inventory: old._inventory, _customCmds: old._customCmds, _pingHistory: old._pingHistory, _pktHistory: old._pktHistory };
      if (!ST.bots[idx]._pingHistory) ST.bots[idx]._pingHistory = [];
      if (!ST.bots[idx]._pktHistory) ST.bots[idx]._pktHistory = [];
      const ph = ST.bots[idx]._pingHistory;
      const pkh = ST.bots[idx]._pktHistory;
      if (b.ping >= 0) { ph.push(b.ping); if (ph.length > 30) ph.shift(); }
      const totalPps = (b.ppsIn||0) + (b.ppsOut||0);
      pkh.push(totalPps); if (pkh.length > 30) pkh.shift();
      if (keyChanged && ST.activeId === b.id) {
        if (ST.activeTab === 'overview') renderOverview(ST.bots[idx]);
        if (ST.activeTab === 'stats') renderStats(ST.bots[idx]);
        renderActionBar();
      }
    } else {
      ST.bots.push(b);
    }
  }
  const ids = new Set(bots.map(b=>b.id));
  ST.bots = ST.bots.filter(b=>ids.has(b.id));
  renderSB();
  if (!ST.activeId) { renderGlobalDashboard(); }
  else if (ST.activeId && !ST.bots.find(b=>b.id===ST.activeId)) { ST.activeId = null; renderActiveTab(); }
});
SOCK.on('botAdded', data => {
  if (!ST.bots.find(b=>b.id===data.id)) { ST.bots.push(data); renderSB(); }
  toast('Bot added: '+data.id+' ✔ Đã lưu','success');
  fetch('/api/capacity').then(r=>r.json()).then(d=>{ ST._capacity = d; renderCapacityBar(); renderSidebarStats(); }).catch(()=>{});
});
SOCK.on('botUpdated', data => {
  const idx = ST.bots.findIndex(b=>b.id===data.id);
  if (idx>=0) ST.bots[idx] = { ...ST.bots[idx], ...data };
  renderSB();
  if (ST.activeId===data.id) { renderActionBar(); renderActiveTab(); }
  toast('Bot updated: '+data.id+' ✔ Đã lưu','success');
});
SOCK.on('botRemoved', data => {
  ST.bots = ST.bots.filter(b=>b.id!==data.id);
  ST._selectedBots.delete(data.id);
  if (ST.activeId===data.id) { ST.activeId=null; DOM.noSel.style.display=''; DOM.botView.style.display='none'; }
  renderSB();
  toast('Bot removed: '+data.id,'warn');  fetch('/api/capacity').then(r=>r.json()).then(d=>{ ST._capacity = d; renderCapacityBar(); renderSidebarStats(); }).catch(()=>{});
});
SOCK.on('log', entry => {
  if (!entry?.id||entry.id!==ST.activeId) return;
  const b = ST.bots.find(x=>x.id===ST.activeId);
  if (!b) return;
  if (!b._logs) b._logs=[];
  b._logs.push(entry);
  if (b._logs.length > 800) b._logs = b._logs.slice(-400);
  if (ST.activeTab==='logs'&&!ST._logPaused) {
    const box=$('log-box'); if(box){ appendLogLine(box,entry,true); updateLogCount(); const as=$('log-autoscroll'); if(as?.checked) requestAnimationFrame(()=>{box.scrollTop=box.scrollHeight}); }
  }
});
SOCK.on('logs', data => {
  const b = ST.bots.find(x=>x.id===data.id);
  if (b) { b._logs = data.logs || []; if (ST.activeId===data.id&&ST.activeTab==='logs') reloadLogs(); }
});
SOCK.on('inventory', data => {
  const b = ST.bots.find(x=>x.id===data.id);
  if (b) b._inventory = data.items || [];
  if (ST.activeId===data.id&&ST.activeTab==='inventory') { const b2=ST.bots.find(x=>x.id===ST.activeId); if(b2) renderInventory(b2); }
});
SOCK.on('customCmds', data => {
  const b = ST.bots.find(x=>x.id===data.id);
  if (b) b._customCmds = data.cmds || [];
  if (ST.activeId===data.id&&ST.activeTab==='commands') { const b2=ST.bots.find(x=>x.id===ST.activeId); if(b2) renderCommands(b2); }
});
SOCK.on('systemMetrics', data => { ST._sysMetrics = data; if (ST.activeTab==='system'&&ST.activeId) renderSystem(); renderSidebarStats(); });
SOCK.on('proxyList', data => {
  ST.proxies = data;
  if (ST.activeTab==='proxy'){
    if(ST.activeId){ const b=ST.bots.find(x=>x.id===ST.activeId); if(b) renderProxyTab(b); }
    else renderProxyTab();
  }
});
SOCK.on('botState', data => {
  const b = ST.bots.find(x=>x.id===data.id);
  if (b) b.state = data.state;
  renderSB();
  if (ST.activeId===data.id) renderActionBar();
});
SOCK.on('packetAnomaly', data => {
  toast(`⚠️ ${data.id}: Packet ${data.type} (${data.ppsIn+data.ppsOut}/s vs avg ${data.mean}/s)`, 'warn');
});
SOCK.on('kicked', data => {
  toast(`Bot ${data.id} bị kick: ${data.reason}`, 'error', { title: 'Kick Reason', body: `<pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:11px;color:var(--offline)">${esc(data.reason)}</pre>` });
});
SOCK.on('error', data => {
  toast((data?.code||'ERROR')+': '+(data?.message||''), 'error');
});
document.addEventListener('DOMContentLoaded', () => {
  setInterval(()=>{ DOM.hdrTime.textContent = new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) + ' UTC+7'; }, 1000);
  DOM.tabs.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    ST.activeTab = tab.dataset.tab;
    renderActiveTab();
  });
  document.addEventListener('click', e => {
    const close = e.target.closest('[data-close]');
    if (close) closeModal(close.dataset.close);
  });
  document.querySelectorAll('.overlay').forEach(o => {
    o.addEventListener('click', e => { if (e.target===o) closeModal(o.id); });
  });
  DOM.menuToggle.addEventListener('click', () => {
    const isOpen = DOM.sidebar.classList.toggle('open');
    DOM.sidebarBackdrop.classList.toggle('show');
    DOM.menuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (isOpen) updateMobileNav('bots');
  });
  DOM.sidebarBackdrop.addEventListener('click', () => {
    DOM.sidebar.classList.remove('open');
    DOM.sidebarBackdrop.classList.remove('show');
    DOM.menuToggle.setAttribute('aria-expanded', 'false');
    if (ST.activeId) updateMobileNav('console'); else updateMobileNav('home');
  });
  document.querySelectorAll('.mobile-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const mtab = btn.dataset.mtab;
      switch(mtab) {
        case 'home': showGlobalDashboard(); break;
        case 'bots': openBotsSidebar(); break;
        case 'manager': showManagerTab(); break;
        case 'console': showConsoleTab(); break;
        case 'system': showSystemTab(); break;
      }
    });
  });
  if (DOM.sbSearch) {
    DOM.sbSearch.addEventListener('input', () => {
      clearTimeout(ST._debounceTimer);
      ST._debounceTimer = setTimeout(() => renderSB(), 300);
    });
  }
  let _resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (ST.activeTab === 'proxy' && !ST.activeId) renderProxyTab();
    }, 200);
  });
  $('btn-add-bot')?.addEventListener('click', ()=>openModal('overlay-add-bot'));
  $('btn-create-bot')?.addEventListener('click', addBot);
  $('btn-add-proxy')?.addEventListener('click', addProxy);
  $('btn-save-bot')?.addEventListener('click', saveBot);
  $('btn-refresh')?.addEventListener('click', ()=>{
    fetch('/api/bots').then(r=>r.json()).then(data=>{ ST.bots=data; renderSB(); if(!ST.activeId)renderGlobalDashboard(); if(ST.activeId){ const b=ST.bots.find(x=>x.id===ST.activeId); if(b)renderActionBar(); } });
    fetch('/api/proxies').then(r=>r.json()).then(d=>{ ST.proxies=d; });
    toast('Refreshed','success');
  });
  $('btn-help')?.addEventListener('click', ()=>openModal('overlay-shortcuts'));
  $('btn-cap-proceed')?.addEventListener('click', () => {
    if (_pendingAddBot) { const p = _pendingAddBot; _pendingAddBot = null; _doAddBot(p); }
  });
  document.addEventListener('keydown', e => {
    if (e.key==='ArrowLeft'||e.key==='ArrowRight'){
      const tabs=DOM.tabs.querySelectorAll('.tab'); const activeIdx=Array.from(tabs).findIndex(t=>t.classList.contains('active'));
      if(activeIdx>=0&&document.activeElement&&document.activeElement.classList.contains('tab')){
        e.preventDefault(); let next=activeIdx+(e.key==='ArrowRight'?1:-1);
        if(next<0)next=tabs.length-1; if(next>=tabs.length)next=0;
        tabs[next].focus(); ST.activeTab=tabs[next].dataset.tab; renderActiveTab();
      }
    }
    if (e.key==='Escape') {
      const openOverlay = document.querySelector('.overlay.open');
      if (openOverlay) { closeModal(openOverlay.id); return; }
      if (DOM.sidebar.classList.contains('open')) {
        DOM.sidebar.classList.remove('open');
        DOM.sidebarBackdrop.classList.remove('show');
        DOM.menuToggle.setAttribute('aria-expanded', 'false');
        return;
      }
    }
    if ((e.ctrlKey||e.metaKey)&&e.key==='k') { e.preventDefault(); const input=$('cmd-input'); if(input)input.focus(); return; }
    if (e.key==='?'&&!e.ctrlKey&&!e.metaKey&&!e.altKey) { const activeEl=document.activeElement; if(!activeEl||activeEl.tagName==='BODY'||activeEl.tagName==='MAIN'){ e.preventDefault(); openModal('overlay-shortcuts'); return; } }
    const numKeys={'1':'overview','2':'manager','3':'logs','4':'inventory','5':'commands','6':'config','7':'proxy','8':'system','9':'stats'};
    if (numKeys[e.key]&&!e.ctrlKey&&!e.metaKey&&!e.altKey) { const activeEl=document.activeElement; if(!activeEl||activeEl.tagName==='BODY'||activeEl.tagName==='MAIN'||activeEl.classList.contains('main')){ e.preventDefault(); ST.activeTab=numKeys[e.key]; renderActiveTab(); } }
  });
  let touchStartX=0;
  DOM.sidebarBackdrop.addEventListener('touchstart',e=>{ touchStartX=e.touches[0].clientX; });
  DOM.sidebarBackdrop.addEventListener('touchend',e=>{ if(e.changedTouches[0].clientX-touchStartX>60){ DOM.sidebar.classList.remove('open'); DOM.sidebarBackdrop.classList.remove('show'); DOM.menuToggle.setAttribute('aria-expanded','false'); } });
});
