let password = localStorage.getItem('gyds_miner_password') || '';

function authHeaders() {
  return password ? { 'x-miner-password': password } : {};
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    document.getElementById('loginGate').style.display = 'block';
    document.getElementById('appMain').style.display = 'none';
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

function fmtHashRate(hr) {
  if (hr >= 1e9) return (hr / 1e9).toFixed(2) + ' GH/s';
  if (hr >= 1e6) return (hr / 1e6).toFixed(2) + ' MH/s';
  if (hr >= 1e3) return (hr / 1e3).toFixed(2) + ' kH/s';
  return hr.toFixed(0) + ' H/s';
}

function fmtUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

let configLoaded = false;

async function refresh() {
  try {
    const data = await api('/api/status');
    document.getElementById('loginGate').style.display = 'none';
    document.getElementById('appMain').style.display = 'block';

    document.getElementById('hostLabel').textContent =
      `${data.config.workerName} · ${data.system.hostname} · ${data.system.cpus} cores`;

    const pill = document.getElementById('statusPill');
    pill.textContent = data.running ? 'Mining' : 'Stopped';
    pill.className = 'pill ' + (data.running ? 'pill-on' : 'pill-off');

    document.getElementById('hashRate').textContent = fmtHashRate(data.hashRate);
    document.getElementById('validShares').textContent = data.validShares;
    document.getElementById('rejectedShares').textContent = data.rejectedShares;
    document.getElementById('totalReward').textContent = data.totalReward.toFixed(4) + ' GYDS';
    document.getElementById('blockHeight').textContent = data.blockHeight || '—';
    document.getElementById('uptime').textContent = fmtUptime(data.uptime);

    document.getElementById('startBtn').disabled = data.running;
    document.getElementById('stopBtn').disabled = !data.running;

    if (!configLoaded) {
      document.getElementById('cfgRpc').value = data.config.rpcEndpoint;
      document.getElementById('cfgAddress').value = data.config.minerAddress;
      document.getElementById('cfgWorker').value = data.config.workerName;
      document.getElementById('cfgThreads').value = data.config.threads;
      configLoaded = true;
    }

    const sys = data.system;
    document.getElementById('systemInfo').innerHTML = `
      <div>Platform <span>${sys.platform}</span></div>
      <div>CPUs <span>${sys.cpus}</span></div>
      <div>Load avg <span>${sys.loadavg.map(n => n.toFixed(2)).join(', ')}</span></div>
      <div>Memory <span>${sys.totalMemMb - sys.freeMemMb} / ${sys.totalMemMb} MB</span></div>
    `;

    document.getElementById('logBox').textContent = data.log.join('\n');
    if (data.lastError) {
      document.getElementById('actionMessage').textContent = 'Last error: ' + data.lastError;
    }
  } catch (e) {
    if (e.message !== 'unauthorized') console.error(e);
  }
}

async function callAction(action) {
  const btn = document.getElementById(action + 'Btn');
  btn.disabled = true;
  try {
    const result = await api('/api/' + action, { method: 'POST' });
    document.getElementById('actionMessage').textContent = result.message || '';
  } finally {
    refresh();
  }
}

async function saveConfig() {
  const body = {
    rpcEndpoint: document.getElementById('cfgRpc').value.trim(),
    minerAddress: document.getElementById('cfgAddress').value.trim(),
    workerName: document.getElementById('cfgWorker').value.trim(),
    threads: parseInt(document.getElementById('cfgThreads').value, 10),
  };
  const pw = document.getElementById('cfgPassword').value;
  if (pw) body.webPassword = pw;

  const result = await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
  document.getElementById('configMessage').textContent = result.ok ? 'Saved.' : 'Failed to save.';
  document.getElementById('cfgPassword').value = '';
  refresh();
}

refresh();
setInterval(refresh, 3000);
