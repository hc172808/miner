// ── Auth ──────────────────────────────────────────────────────────────────────
let password = localStorage.getItem('gyds_miner_password') || '';

function authHeaders() { return password ? { 'x-miner-password': password } : {}; }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    document.getElementById('loginGate').style.display = 'block';
    document.getElementById('appMain').style.display   = 'none';
    throw new Error('unauthorized');
  }
  return res.json();
}

function submitPassword() {
  password = document.getElementById('passwordInput').value;
  localStorage.setItem('gyds_miner_password', password);
  document.getElementById('loginError').textContent = '';
  refresh();
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

function truncate(str, n) { return str && str.length > n ? str.slice(0, n) + '…' : str; }

// ── Hash rate chart ───────────────────────────────────────────────────────────
function drawChart(history) {
  const canvas = document.getElementById('hashChart');
  if (!canvas) return;
  const ctx   = canvas.getContext('2d');
  const dpr   = window.devicePixelRatio || 1;
  const w     = canvas.offsetWidth  || 640;
  const h     = canvas.offsetHeight || 90;
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

  // Fill area
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

  // Line
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

  // Peak label
  const peakIdx = history.reduce((best, s, i) => s.hr > history[best].hr ? i : best, 0);
  const px = pad + (peakIdx / (history.length - 1)) * (w - pad * 2);
  const py = (h - pad) - (history[peakIdx].hr / max) * (h - pad * 2);
  ctx.fillStyle = '#2dd4bf';
  ctx.font = '10px sans-serif';
  ctx.textAlign = px > w / 2 ? 'right' : 'left';
  ctx.fillText(fmtHashRate(history[peakIdx].hr), px, Math.max(py - 4, 12));
}

// ── Coin presets ──────────────────────────────────────────────────────────────
let coinPresets = [];
let selectedPreset = null;

async function loadPresets() {
  try {
    const r = await api('/api/coin-presets');
    coinPresets = r.presets || [];
    renderPresetGrid();
  } catch {}
}

function renderPresetGrid() {
  const grid = document.getElementById('presetGrid');
  if (!grid || !coinPresets.length) return;
  grid.innerHTML = coinPresets.map(p => `
    <button type="button" class="preset-chip" data-symbol="${escHtml(p.symbol)}"
            onclick="selectPreset(${escHtml(JSON.stringify(p))})">
      ${escHtml(p.symbol)}
    </button>
  `).join('');
}

function selectPreset(preset) {
  if (typeof preset === 'string') preset = JSON.parse(preset);
  selectedPreset = preset;

  // Highlight chip
  document.querySelectorAll('.preset-chip').forEach(el => {
    el.classList.toggle('selected', el.dataset.symbol === preset.symbol);
  });

  // Fill form fields (only if not manually edited — or always for name/symbol)
  const nameEl   = document.getElementById('newName');
  const symbolEl = document.getElementById('newSymbol');
  const rpcEl    = document.getElementById('newRpc');

  nameEl.value   = preset.name;
  symbolEl.value = preset.symbol;
  if (preset.suggestedRpc) rpcEl.value = preset.suggestedRpc;

  // Clear touched flags so auto-detect still works after picking a preset
  delete nameEl.dataset.touched;
  delete symbolEl.dataset.touched;
  if (preset.suggestedRpc) delete rpcEl.dataset.touched;
}

// ── Coin management UI ────────────────────────────────────────────────────────
let coinsCache = [];
let activeCoinId = null;

function renderCoins(coins, activeId) {
  coinsCache   = coins;
  activeCoinId = activeId;
  const el = document.getElementById('coinList');
  if (!coins || coins.length === 0) {
    el.innerHTML = '<p class="muted" style="text-align:center;padding:16px">No coins added yet. Click + Add Coin to get started.</p>';
    return;
  }
  el.innerHTML = coins.map(c => {
    const isActive = c.id === activeId;
    const mode     = c.miningMode || 'pool';
    const modeBadge = `<span class="mode-badge ${mode}">${mode === 'solo' ? '🎯 Solo' : '🏊 Pool'}</span>`;
    return `
    <div class="coin-item${isActive ? ' active' : ''}">
      <div class="coin-symbol">${(c.symbol || '?').slice(0, 5)}</div>
      <div class="coin-info">
        <div class="coin-name">
          ${escHtml(c.name)}
          ${modeBadge}
          ${isActive ? '<span class="active-tag">● ACTIVE</span>' : ''}
        </div>
        <div class="coin-addr" title="${escHtml(c.walletAddress)}">${escHtml(c.walletAddress)}</div>
        <div class="coin-rpc"  title="${escHtml(c.rpcEndpoint)}">${escHtml(c.rpcEndpoint)}</div>
      </div>
      <div class="coin-actions">
        ${!isActive ? `<button class="btn sm primary" onclick="activateCoin('${c.id}')">Use</button>` : ''}
        <button class="btn sm ghost" onclick="deleteCoin('${c.id}','${escHtml(c.name)}')">✕</button>
      </div>
    </div>`;
  }).join('');
}

function escHtml(s) {
  if (typeof s !== 'string') s = JSON.stringify(s);
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function activateCoin(id) {
  await api(`/api/coins/${id}/activate`, { method: 'POST' });
  refresh();
}

async function deleteCoin(id, name) {
  if (!confirm(`Remove coin "${name}"?`)) return;
  await api(`/api/coins/${id}`, { method: 'DELETE' });
  refresh();
}

function showAddCoin() {
  document.getElementById('addCoinForm').style.display = 'block';
  // Load presets lazily the first time form is opened
  if (!coinPresets.length) loadPresets();
}
function hideAddCoin() {
  document.getElementById('addCoinForm').style.display = 'none';
  document.getElementById('addCoinMsg').textContent = '';
}

async function detectCoinFromInput(address) {
  if (!address || address.length < 8) return;
  try {
    const r = await api('/api/detect-coin', { method: 'POST', body: JSON.stringify({ walletAddress: address }) });
    if (r.name && r.name !== 'Unknown') {
      const nameEl   = document.getElementById('newName');
      const symbolEl = document.getElementById('newSymbol');
      const rpcEl    = document.getElementById('newRpc');
      if (!nameEl.dataset.touched)   nameEl.value   = r.name;
      if (!symbolEl.dataset.touched) symbolEl.value = r.symbol;
      if (!rpcEl.dataset.touched && r.suggestedRpc) rpcEl.value = r.suggestedRpc;
    }
  } catch {}
}

// mark as user-edited so auto-detect doesn't overwrite
['newName','newSymbol','newRpc'].forEach(id => {
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { el.dataset.touched = '1'; });
  });
});

function getSelectedMode() {
  const checked = document.querySelector('input[name="newMode"]:checked');
  return checked ? checked.value : 'pool';
}

async function addCoin() {
  const body = {
    walletAddress: document.getElementById('newAddress').value.trim(),
    rpcEndpoint:   document.getElementById('newRpc').value.trim(),
    name:          document.getElementById('newName').value.trim(),
    symbol:        document.getElementById('newSymbol').value.trim(),
    cfClientId:    document.getElementById('newCfId').value.trim(),
    cfClientSecret:document.getElementById('newCfSecret').value,
    miningMode:    getSelectedMode(),
  };
  if (!body.walletAddress || !body.rpcEndpoint) {
    document.getElementById('addCoinMsg').textContent = 'Wallet address and RPC endpoint are required.';
    return;
  }
  const r = await api('/api/coins', { method: 'POST', body: JSON.stringify(body) });
  if (r.ok) {
    // reset form
    ['newAddress','newName','newSymbol','newRpc','newCfId','newCfSecret'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.value = ''; delete el.dataset.touched; }
    });
    // Reset mode to pool
    const poolRadio = document.querySelector('input[name="newMode"][value="pool"]');
    if (poolRadio) poolRadio.checked = true;
    // Reset preset selection
    selectedPreset = null;
    document.querySelectorAll('.preset-chip').forEach(el => el.classList.remove('selected'));
    hideAddCoin();
    refresh();
  } else {
    document.getElementById('addCoinMsg').textContent = r.error || 'Failed to add coin.';
  }
}

// ── Main refresh loop ─────────────────────────────────────────────────────────
let configLoaded = false;

async function refresh() {
  try {
    const data = await api('/api/status');
    document.getElementById('loginGate').style.display = 'none';
    document.getElementById('appMain').style.display   = 'block';

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
    document.getElementById('totalReward').textContent   =
      data.totalReward.toFixed(4) + (data.activeCoin ? ' ' + data.activeCoin.symbol : '');
    document.getElementById('blockHeight').textContent   = data.blockHeight || '—';
    document.getElementById('uptime').textContent        = fmtUptime(data.uptime);

    // Active coin label
    const acl = document.getElementById('activeCoinLabel');
    if (data.activeCoin) {
      const mode = data.activeCoin.miningMode || 'pool';
      acl.textContent = `Active: ${data.activeCoin.name} (${data.activeCoin.symbol}) · ${mode === 'solo' ? '🎯 Solo' : '🏊 Pool'}`;
    } else {
      acl.textContent = 'No coin selected — add one below';
    }

    // Buttons
    document.getElementById('startBtn').disabled = data.running || data.reconnecting;
    document.getElementById('stopBtn').disabled  = !data.running && !data.reconnecting;

    // Chart
    drawChart(data.hashHistory);

    // Efficiency
    const eff = data.efficiency;
    document.getElementById('effScore').textContent    = eff.effScore    ? fmtHashRate(eff.effScore) + ' / load' : '—';
    document.getElementById('hpsPerThread').textContent= eff.hpsPerThread? fmtHashRate(eff.hpsPerThread) + ' / thread' : '—';

    // Coin list
    const cr = await api('/api/coins');
    renderCoins(cr.coins, cr.activeCoinId);

    // Config form (only fill once)
    if (!configLoaded) {
      document.getElementById('cfgWorker').value  = data.config.workerName;
      document.getElementById('cfgThreads').value = data.config.baseThreads ?? 0;
      document.getElementById('cfgOverclock').value= data.config.overclock ?? 1;
      document.getElementById('cfgBatch').value   = data.config.batchSize ?? 20000;
      configLoaded = true;
    }

    // Security notice
    const sn = document.getElementById('securityNotice');
    if (sn) sn.style.display = data.config.hasPassword ? 'none' : 'block';

    // System info
    const sys = data.system;
    const cfg = data.config;
    const isOC = cfg.overclock && cfg.overclock !== 1;
    document.getElementById('systemInfo').innerHTML = [
      ['Platform',        sys.platform],
      ['CPU Cores',       sys.cpus],
      ['Active Threads',  cfg.effectiveThreads ?? sys.cpus],
      ['Overclock',       (isOC ? '⚡ ' : '') + (cfg.overclock ?? 1) + '×'],
      ['Batch Size',      (cfg.batchSize ?? 20000).toLocaleString()],
      ['Load avg',        sys.loadavg.map(n => n.toFixed(2)).join(', ')],
      ['Memory',          `${sys.totalMemMb - sys.freeMemMb} / ${sys.totalMemMb} MB`],
    ].map(([k, v]) => `
      <div>
        <div class="sys-label">${k}</div>
        <div class="sys-val" style="${k==='Overclock'&&isOC?'color:#f59e0b':''}">${v}</div>
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

async function callAction(action) {
  document.getElementById('startBtn').disabled = true;
  document.getElementById('stopBtn').disabled  = true;
  try {
    const result = await api('/api/' + action, { method: 'POST' });
    document.getElementById('actionMessage').textContent = result.message || '';
  } finally { refresh(); }
}

async function saveConfig() {
  const body = {
    workerName: document.getElementById('cfgWorker').value.trim(),
    threads:    Math.max(0, parseInt(document.getElementById('cfgThreads').value, 10) || 0),
    overclock:  Math.max(0.5, parseFloat(document.getElementById('cfgOverclock').value) || 1),
    batchSize:  Math.max(100, parseInt(document.getElementById('cfgBatch').value, 10) || 20000),
  };
  const pw = document.getElementById('cfgPassword').value;
  if (pw) body.webPassword = pw;
  const r = await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
  document.getElementById('configMessage').textContent = r.ok ? '✓ Saved.' : '✗ Failed to save.';
  document.getElementById('cfgPassword').value = '';
  configLoaded = false; // re-populate form with updated values
  refresh();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
refresh();
setInterval(refresh, 3000);
