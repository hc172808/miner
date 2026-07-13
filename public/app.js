// ── Session / Auth ────────────────────────────────────────────────────────────
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

let password      = localStorage.getItem('gyds_pw')         || '';
let lastActivity  = parseInt(localStorage.getItem('gyds_last_activity') || '0', 10);

function touchActivity() {
  lastActivity = Date.now();
  localStorage.setItem('gyds_last_activity', lastActivity);
}

function isSessionExpired() {
  if (!password) return false; // not logged in — nothing to expire
  return lastActivity > 0 && (Date.now() - lastActivity) > SESSION_TIMEOUT_MS;
}

function logout() {
  password = '';
  lastActivity = 0;
  localStorage.removeItem('gyds_pw');
  localStorage.removeItem('gyds_last_activity');
  showLoginGate();
}

function showLoginGate() {
  document.getElementById('loginGate').style.display  = 'block';
  document.getElementById('appMain').style.display    = 'none';
  document.getElementById('logoutBtn').style.display  = 'none';
}

function submitPassword() {
  const val = document.getElementById('passwordInput').value;
  if (!val) return;
  password = val;
  localStorage.setItem('gyds_pw', password);
  touchActivity();
  document.getElementById('loginError').textContent = '';
  document.getElementById('passwordInput').value    = '';
  refresh();
}

function authHeaders() {
  return password ? { 'x-miner-password': password } : {};
}

async function api(path, opts = {}) {
  touchActivity();
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    if (password) document.getElementById('loginError').textContent = 'Wrong password.';
    showLoginGate();
    throw new Error('unauthorized');
  }
  return res.json();
}

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtHashRate(hr) {
  if (hr >= 1e9) return (hr / 1e9).toFixed(2) + ' GH/s';
  if (hr >= 1e6) return (hr / 1e6).toFixed(2) + ' MH/s';
  if (hr >= 1e3) return (hr / 1e3).toFixed(2) + ' kH/s';
  return (hr || 0).toFixed(0) + ' H/s';
}

function fmtUptime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

function fmtCountdown(ms) {
  if (ms <= 0) return 'Session expired';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60), s = total % 60;
  return `Auto-logout in ${m}m ${s.toString().padStart(2, '0')}s`;
}

function escHtml(s) {
  if (typeof s !== 'string') s = JSON.stringify(s);
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Hash rate chart ───────────────────────────────────────────────────────────
function drawChart(history) {
  const canvas = document.getElementById('hashChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w   = canvas.offsetWidth  || 640;
  const h   = canvas.offsetHeight || 90;
  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  if (!history || history.length < 2) {
    ctx.fillStyle = '#4a5568';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for data…', w / 2, h / 2 + 4);
    return;
  }

  const max = Math.max(...history.map(s => s.hr), 1);
  const pad = 4;

  ctx.beginPath();
  history.forEach((s, i) => {
    const x = pad + (i / (history.length - 1)) * (w - pad * 2);
    const y = (h - pad) - (s.hr / max) * (h - pad * 2);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(pad + (w - pad * 2), h - pad);
  ctx.lineTo(pad, h - pad);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(20,184,166,0.3)');
  grad.addColorStop(1, 'rgba(20,184,166,0.02)');
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  history.forEach((s, i) => {
    const x = pad + (i / (history.length - 1)) * (w - pad * 2);
    const y = (h - pad) - (s.hr / max) * (h - pad * 2);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#14b8a6';
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  const peakIdx = history.reduce((best, s, i) => s.hr > history[best].hr ? i : best, 0);
  const px = pad + (peakIdx / (history.length - 1)) * (w - pad * 2);
  const py = (h - pad) - (history[peakIdx].hr / max) * (h - pad * 2);
  ctx.fillStyle = '#2dd4bf';
  ctx.font = '10px sans-serif';
  ctx.textAlign = px > w / 2 ? 'right' : 'left';
  ctx.fillText(fmtHashRate(history[peakIdx].hr), px, Math.max(py - 4, 12));
}

// ── Wallet settings form ──────────────────────────────────────────────────────
let walletFormLoaded = false;

function fillWalletForm(wallet) {
  if (walletFormLoaded) return;
  document.getElementById('wltAddress').value  = wallet.walletAddress || '';
  document.getElementById('wltRpc').value      = wallet.rpcEndpoint   || '';
  document.getElementById('wltCfId').value     = wallet.cfClientId    || '';
  const mode = wallet.miningMode || 'pool';
  const radio = document.querySelector(`input[name="wltMode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  walletFormLoaded = true;
}

async function saveWallet() {
  const body = {
    walletAddress:  document.getElementById('wltAddress').value.trim(),
    rpcEndpoint:    document.getElementById('wltRpc').value.trim(),
    cfClientId:     document.getElementById('wltCfId').value.trim(),
    cfClientSecret: document.getElementById('wltCfSecret').value,
    miningMode:     document.querySelector('input[name="wltMode"]:checked')?.value || 'pool',
  };
  const msgEl = document.getElementById('walletMessage');
  msgEl.textContent = 'Saving…';
  msgEl.style.color = '#9fb0c0';
  try {
    const r = await api('/api/wallet', { method: 'POST', body: JSON.stringify(body) });
    if (r.ok) {
      msgEl.textContent = '✓ Wallet settings saved.';
      msgEl.style.color = '#2dd4bf';
      walletFormLoaded = false; // re-populate on next refresh
      document.getElementById('wltCfSecret').value = '';
    } else {
      msgEl.textContent = '✗ ' + (r.error || 'Failed to save.');
      msgEl.style.color = '#f87171';
    }
  } catch (e) {
    if (e.message !== 'unauthorized') {
      msgEl.textContent = '✗ ' + e.message;
      msgEl.style.color = '#f87171';
    }
  }
  refresh();
}

// ── Mining settings form ──────────────────────────────────────────────────────
let configLoaded = false;

async function saveConfig() {
  const body = {
    workerName: document.getElementById('cfgWorker').value.trim(),
    threads:    Math.max(0, parseInt(document.getElementById('cfgThreads').value, 10)    || 0),
    overclock:  Math.max(0.5, parseFloat(document.getElementById('cfgOverclock').value) || 1),
    batchSize:  Math.max(100, parseInt(document.getElementById('cfgBatch').value, 10)   || 20000),
  };
  const pw = document.getElementById('cfgPassword').value;
  if (pw) body.webPassword = pw;
  const r = await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
  document.getElementById('configMessage').textContent = r.ok ? '✓ Saved.' : '✗ Failed to save.';
  document.getElementById('cfgPassword').value = '';
  configLoaded = false;
  refresh();
}

// ── Mining controls ───────────────────────────────────────────────────────────
async function callAction(action) {
  document.getElementById('startBtn').disabled = true;
  document.getElementById('stopBtn').disabled  = true;
  try {
    const result = await api('/api/' + action, { method: 'POST' });
    document.getElementById('actionMessage').textContent  = result.message || '';
    document.getElementById('actionMessage').style.color  = result.ok ? '#9fb0c0' : '#f87171';
  } finally { refresh(); }
}

async function testConnection() {
  const btn = document.getElementById('testBtn');
  const msg = document.getElementById('actionMessage');
  btn.disabled    = true;
  btn.textContent = '🔌 Testing…';
  msg.textContent = 'Probing RPC…';
  msg.style.color = '#9fb0c0';
  try {
    const r = await api('/api/test-rpc', { method: 'POST' });
    if (r.ok) {
      msg.textContent = `✓ Connected (${r.latency} ms)` +
        (r.serverInfo ? ` — server: ${JSON.stringify(r.serverInfo)}` : '');
      msg.style.color = '#2dd4bf';
    } else {
      msg.textContent = `✗ ${r.error}`;
      msg.style.color = '#f87171';
    }
  } catch (e) {
    msg.textContent = '✗ Test failed: ' + e.message;
    msg.style.color = '#f87171';
  } finally {
    btn.disabled    = false;
    btn.textContent = '🔌 Test Connection';
  }
}

// ── Main refresh loop ─────────────────────────────────────────────────────────
async function refresh() {
  // Check session timeout first
  if (isSessionExpired()) { logout(); return; }

  try {
    const data = await api('/api/status');

    // Show main app
    document.getElementById('loginGate').style.display = 'none';
    document.getElementById('appMain').style.display   = 'block';
    document.getElementById('logoutBtn').style.display = config?.webPassword !== false ? 'block' : 'none';

    // Show logout button when password is set
    document.getElementById('logoutBtn').style.display =
      data.config.hasPassword ? 'block' : 'none';

    // Header
    document.getElementById('hostLabel').textContent =
      `${data.config.workerName} · ${data.system.hostname} · ${data.system.cpus} cores`;

    // Status pill
    const pill = document.getElementById('statusPill');
    pill.textContent = data.running ? 'Mining' : (data.reconnecting ? 'Reconnecting' : 'Stopped');
    pill.className   = 'pill ' + (data.running ? 'pill-on' : 'pill-off');

    // Reconnect badge
    const rb = document.getElementById('reconnectBadge');
    rb.style.display = data.reconnecting ? 'inline-flex' : 'none';
    if (data.reconnecting) rb.textContent = `⟳ Reconnecting… (attempt ${data.reconnectAttempt})`;

    // Stats
    document.getElementById('hashRate').textContent      = fmtHashRate(data.hashRate);
    document.getElementById('validShares').textContent   = data.validShares;
    document.getElementById('rejectedShares').textContent= data.rejectedShares;
    document.getElementById('totalReward').textContent   = data.totalReward.toFixed(4) + ' GYDS';
    document.getElementById('blockHeight').textContent   = data.blockHeight || '—';
    document.getElementById('uptime').textContent        = fmtUptime(data.uptime);

    // Controls label
    const mode = data.wallet?.miningMode || 'pool';
    document.getElementById('activeCoinLabel').textContent =
      `GYDS Network · ${mode === 'solo' ? '🎯 Solo' : '🏊 Pool'}`;

    // Mode badge
    const mb = document.getElementById('walletModeBadge');
    mb.textContent = mode === 'solo' ? '🎯 Solo' : '🏊 Pool';
    mb.className   = `mode-badge ${mode}`;

    // Buttons
    document.getElementById('startBtn').disabled = data.running || data.reconnecting;
    document.getElementById('stopBtn').disabled  = !data.running && !data.reconnecting;

    // Chart
    drawChart(data.hashHistory);

    // Efficiency
    document.getElementById('effScore').textContent    =
      data.efficiency.effScore     ? fmtHashRate(data.efficiency.effScore)    + ' / load'   : '—';
    document.getElementById('hpsPerThread').textContent=
      data.efficiency.hpsPerThread ? fmtHashRate(data.efficiency.hpsPerThread) + ' / thread' : '—';

    // Wallet form (fill once)
    if (!walletFormLoaded && data.wallet) fillWalletForm(data.wallet);

    // Config form (fill once)
    if (!configLoaded) {
      document.getElementById('cfgWorker').value   = data.config.workerName;
      document.getElementById('cfgThreads').value  = data.config.baseThreads ?? 0;
      document.getElementById('cfgOverclock').value= data.config.overclock   ?? 1;
      document.getElementById('cfgBatch').value    = data.config.batchSize   ?? 20000;
      configLoaded = true;
    }

    // Security notice
    const sn = document.getElementById('securityNotice');
    if (sn) sn.style.display = data.config.hasPassword ? 'none' : 'block';

    // Session countdown
    const remaining = SESSION_TIMEOUT_MS - (Date.now() - lastActivity);
    document.getElementById('sessionTimer').textContent = fmtCountdown(remaining);

    // System info
    const sys = data.system, cfg = data.config;
    const isOC = cfg.overclock && cfg.overclock !== 1;
    document.getElementById('systemInfo').innerHTML = [
      ['Platform',       sys.platform],
      ['CPU Cores',      sys.cpus],
      ['Active Threads', cfg.effectiveThreads ?? sys.cpus],
      ['Overclock',      (isOC ? '⚡ ' : '') + (cfg.overclock ?? 1) + '×'],
      ['Batch Size',     (cfg.batchSize ?? 20000).toLocaleString()],
      ['Load avg',       sys.loadavg.map(n => n.toFixed(2)).join(', ')],
      ['Memory',         `${sys.totalMemMb - sys.freeMemMb} / ${sys.totalMemMb} MB`],
    ].map(([k, v]) => `
      <div>
        <div class="sys-label">${k}</div>
        <div class="sys-val" style="${k === 'Overclock' && isOC ? 'color:#f59e0b' : ''}">${v}</div>
      </div>`).join('');

    // Log
    const logBox = document.getElementById('logBox');
    logBox.textContent = data.log.join('\n');
    logBox.scrollTop   = logBox.scrollHeight;

    if (data.lastError) {
      document.getElementById('actionMessage').textContent = '⚠ ' + data.lastError;
    }
  } catch (e) {
    if (e.message !== 'unauthorized') console.error(e);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// Reset walletFormLoaded on page load so form always gets pre-filled once
walletFormLoaded = false;

// Check for expired session on load
if (isSessionExpired()) {
  logout();
} else {
  refresh();
}

setInterval(refresh, 3000);

// Reset inactivity timer on any user interaction
['click', 'keydown', 'mousemove', 'touchstart'].forEach(evt =>
  document.addEventListener(evt, touchActivity, { passive: true })
);
