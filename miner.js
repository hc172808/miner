#!/usr/bin/env node
/**
 * GYDS Miner — single-coin (GYDS network) mining dashboard.
 * Features: auto-reconnect, hash-rate chart, efficiency score.
 */
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const http   = require('http');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const express = require('express');

// ── Config ────────────────────────────────────────────────────────────────────
const args         = process.argv.slice(2);
const cfgFlagIdx   = args.indexOf('--config');
const configPath   = cfgFlagIdx !== -1 && args[cfgFlagIdx + 1]
  ? path.resolve(args[cfgFlagIdx + 1])
  : path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  walletAddress:  '',
  rpcEndpoint:    'https://netlifegy.com/api/mining/rpc',
  cfClientId:     '',
  cfClientSecret: '',
  miningMode:     'pool',
  workerName:     os.hostname(),
  threads:        0,
  overclock:      1,
  batchSize:      20000,
  webPort:        5000,
  webPassword:    '',
};

function computeThreads(raw) {
  const cpuCount  = os.cpus().length;
  const base      = Number.isFinite(raw.threads)   && raw.threads   >= 0   ? Math.floor(raw.threads) : 0;
  const overclock = Number.isFinite(raw.overclock)  && raw.overclock >= 0.5 ? raw.overclock : 1;
  const resolved  = base > 0 ? base : cpuCount;
  return { baseThreads: base, overclock, effectiveThreads: Math.max(1, Math.round(resolved * overclock)) };
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log('[miner] Created default config.json — open the dashboard to configure.');
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Migrate old coins[] format → flat fields
  let walletAddress  = raw.walletAddress  || '';
  let rpcEndpoint    = raw.rpcEndpoint    || DEFAULT_CONFIG.rpcEndpoint;
  let cfClientId     = raw.cfClientId     || '';
  let cfClientSecret = raw.cfClientSecret || '';
  let miningMode     = raw.miningMode     || 'pool';

  if (!walletAddress && Array.isArray(raw.coins) && raw.coins.length > 0) {
    const active   = raw.coins.find(c => c.id === raw.activeCoinId) || raw.coins[0];
    walletAddress  = active.walletAddress  || '';
    rpcEndpoint    = active.rpcEndpoint    || rpcEndpoint;
    cfClientId     = active.cfClientId     || '';
    cfClientSecret = active.cfClientSecret || '';
    miningMode     = active.miningMode     || 'pool';
  }

  const { baseThreads, overclock, effectiveThreads } = computeThreads(raw);
  return {
    walletAddress, rpcEndpoint, cfClientId, cfClientSecret,
    miningMode: miningMode === 'solo' ? 'solo' : 'pool',
    workerName: raw.workerName || os.hostname(),
    baseThreads, overclock, effectiveThreads,
    batchSize:   Number.isFinite(raw.batchSize) && raw.batchSize >= 100 ? Math.floor(raw.batchSize) : 20000,
    webPort:     Number.isFinite(raw.webPort) ? raw.webPort : 5000,
    webPassword: raw.webPassword || '',
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify({
    walletAddress:  cfg.walletAddress,
    rpcEndpoint:    cfg.rpcEndpoint,
    cfClientId:     cfg.cfClientId,
    cfClientSecret: cfg.cfClientSecret,
    miningMode:     cfg.miningMode,
    workerName:     cfg.workerName,
    threads:        cfg.baseThreads,
    overclock:      cfg.overclock,
    batchSize:      cfg.batchSize,
    webPort:        cfg.webPort,
    webPassword:    cfg.webPassword,
  }, null, 2));
}

let config = loadConfig();

// ── RPC helpers ───────────────────────────────────────────────────────────────
let rpcId = 1;

function validateRpcUrl(endpoint) {
  if (!endpoint) throw new Error('No RPC endpoint set.');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error(`Invalid RPC URL: "${endpoint}"`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Protocol "${url.protocol.replace(':', '')}://" is not supported. Use HTTP/HTTPS.`
    );
  }
}

async function rpc(method, params) {
  validateRpcUrl(config.rpcEndpoint);
  const headers = { 'Content-Type': 'application/json' };
  if (config.cfClientId)     headers['CF-Access-Client-Id']     = config.cfClientId;
  if (config.cfClientSecret) headers['CF-Access-Client-Secret'] = config.cfClientSecret;

  let res;
  try {
    res = await fetch(config.rpcEndpoint, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: rpcId++ }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const msg = (err.name === 'TimeoutError' || err.name === 'AbortError')
      ? `RPC timed out after 15 s — is "${config.rpcEndpoint}" reachable?`
      : `Cannot reach RPC at "${config.rpcEndpoint}". (${err.message})`;
    throw new Error(msg);
  }

  if (res.redirected && (res.url || '').includes('cloudflareaccess.com'))
    throw new Error('Blocked by Cloudflare Access — set your CF Service Token in Wallet Settings.');

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html'))
    throw new Error('RPC returned an HTML page — likely Cloudflare Access. Set the CF Service Token in Wallet Settings.');

  if (res.status === 401) throw new Error('RPC returned 401 Unauthorized — check credentials.');
  if (res.status === 403) throw new Error('RPC returned 403 Forbidden — firewall or Cloudflare blocking.');
  if (!res.ok)            throw new Error(`RPC returned HTTP ${res.status}.`);

  let data;
  try { data = await res.json(); }
  catch { throw new Error('RPC response is not valid JSON.'); }
  if (data.error) throw new Error(data.error.message || 'RPC error');
  return data.result;
}

async function probeRpc() {
  try { validateRpcUrl(config.rpcEndpoint); } catch (e) { return { ok: false, error: e.message, latency: 0 }; }
  const headers = { 'Content-Type': 'application/json' };
  if (config.cfClientId)     headers['CF-Access-Client-Id']     = config.cfClientId;
  if (config.cfClientSecret) headers['CF-Access-Client-Secret'] = config.cfClientSecret;
  const t0 = Date.now();
  try {
    const res = await fetch(config.rpcEndpoint, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'mining_getInfo', params: {}, id: 0 }),
      signal: AbortSignal.timeout(10000),
    });
    const latency = Date.now() - t0;
    if (res.redirected && (res.url || '').includes('cloudflareaccess.com'))
      return { ok: false, error: 'Blocked by Cloudflare Access — set CF Service Token in Wallet Settings.', latency };
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html'))
      return { ok: false, error: 'Server returned an HTML page — likely Cloudflare Access login. Set CF Service Token.', latency };
    if (res.status === 401) return { ok: false, error: '401 Unauthorized — check credentials.', latency };
    if (res.status === 403) return { ok: false, error: '403 Forbidden — firewall or CF blocking.', latency };
    if (!res.ok)            return { ok: false, error: `HTTP ${res.status}`, latency };
    let body;
    try { body = await res.json(); } catch { body = null; }
    return { ok: true, latency, serverInfo: body?.result || null };
  } catch (err) {
    const latency = Date.now() - t0;
    const error   = (err.name === 'TimeoutError' || err.name === 'AbortError')
      ? 'Timed out after 10 s — server unreachable or too slow.'
      : `Network error: ${err.message}`;
    return { ok: false, error, latency };
  }
}

// ── Miner state ───────────────────────────────────────────────────────────────
const RECONNECT_DELAYS = [5000, 15000, 30000, 60000, 120000, 300000];

const state = {
  running: false, connected: false,
  reconnecting: false, reconnectAttempt: 0, reconnectTimer: null,
  sessionId: null, workers: [], currentJob: null,
  hashRate: 0, hashesThisSecond: 0,
  validShares: 0, rejectedShares: 0, totalReward: 0,
  currentDifficulty: null, blockHeight: 0, poolName: null,
  startTime: null, lastError: null, log: [], hashHistory: [],
};

function pushLog(line) {
  const entry = `[${new Date().toISOString()}] ${line}`;
  state.log.push(entry);
  if (state.log.length > 300) state.log.shift();
  console.log(entry);
}

// ── Workers ───────────────────────────────────────────────────────────────────
function spawnWorkers() {
  for (let i = 0; i < config.effectiveThreads; i++) {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { minerAddress: config.walletAddress, job: state.currentJob, batchSize: config.batchSize },
    });
    worker.on('message', (msg) => onWorkerMessage(msg));
    worker.on('error',   (err) => pushLog(`Worker ${i} error: ${err.message}`));
    state.workers.push(worker);
  }
  pushLog(`Spawned ${config.effectiveThreads} thread(s).`);
}

function stopWorkers() {
  for (const w of state.workers) { try { w.postMessage({ type: 'stop' }); w.terminate(); } catch {} }
  state.workers = [];
}

function broadcastJob() {
  for (const w of state.workers) w.postMessage({ type: 'job', job: state.currentJob });
}

async function onWorkerMessage(msg) {
  if (msg.type === 'hashes') {
    state.hashesThisSecond += msg.count;
  } else if (msg.type === 'share') {
    if (!state.currentJob || msg.jobId !== state.currentJob.jobId) return;
    try {
      const result = await rpc('mining_submitShare', {
        sessionId: state.sessionId, nonce: msg.nonce, hash: msg.hash, jobId: msg.jobId,
      });
      if (result?.accepted) {
        state.validShares++;
        state.totalReward += Number(result.reward || 0);
        pushLog(`Share accepted! Reward: ${result.reward ?? 0} GYDS`);
        await fetchNewWork();
      } else {
        state.rejectedShares++;
        pushLog(`Share rejected: ${result?.message || 'unknown reason'}`);
      }
    } catch (err) {
      state.rejectedShares++;
      pushLog(`Failed to submit share: ${err.message}`);
    }
  }
}

// ── Work fetch ────────────────────────────────────────────────────────────────
async function fetchNewWork() {
  try {
    const work = await rpc('mining_getWork', { sessionId: state.sessionId });
    if (!work) return;
    state.currentJob        = { ...work, nonceStart: Math.floor(Math.random() * 1e9) };
    state.blockHeight       = work.blockHeight  ?? state.blockHeight;
    state.currentDifficulty = work.difficulty   ?? state.currentDifficulty;
    broadcastJob();
  } catch (err) {
    pushLog(`Failed to fetch work: ${err.message}`);
    if (state.running && !state.reconnecting) scheduleReconnect();
  }
}

// ── Auto-reconnect ────────────────────────────────────────────────────────────
function cancelReconnect() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  state.reconnecting = false; state.reconnectAttempt = 0;
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const delay = RECONNECT_DELAYS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  state.reconnecting = true;
  pushLog(`Connection lost — reconnecting in ${delay / 1000}s (attempt ${state.reconnectAttempt + 1})…`);
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    state.reconnectAttempt++;
    stopWorkers();
    state.connected = false; state.sessionId = null;
    try {
      const conn = await rpc('mining_connect', {
        minerAddress: config.walletAddress, workerName: config.workerName, mode: config.miningMode,
      });
      state.sessionId = conn.sessionId;
      state.poolName  = conn.poolName || (config.miningMode === 'solo' ? 'Solo Node' : null);
      state.connected = true; state.reconnecting = false; state.reconnectAttempt = 0;
      pushLog(`Reconnected to ${state.poolName || 'pool'}.`);
      await fetchNewWork();
      spawnWorkers();
    } catch (err) {
      state.lastError = err.message;
      pushLog(`Reconnect failed: ${err.message}`);
      scheduleReconnect();
    }
  }, delay);
}

// ── Mining control ────────────────────────────────────────────────────────────
let workInterval = null, hashRateInterval = null;

async function startMining() {
  if (state.running) return { ok: true, message: 'Already running' };
  if (!config.walletAddress) return { ok: false, message: 'Set your GYDS wallet address in Wallet Settings first.' };
  if (!config.rpcEndpoint)   return { ok: false, message: 'Set the RPC endpoint in Wallet Settings first.' };
  cancelReconnect();
  try {
    const conn = await rpc('mining_connect', {
      minerAddress: config.walletAddress, workerName: config.workerName, mode: config.miningMode,
    });
    state.sessionId = conn.sessionId;
    state.poolName  = conn.poolName || (config.miningMode === 'solo' ? 'Solo Node' : null);
    state.connected = true;
  } catch (err) {
    state.lastError = err.message;
    pushLog(`Connection failed: ${err.message}`);
    return { ok: false, message: `Could not connect: ${err.message}` };
  }

  state.running = true; state.startTime = Date.now();
  state.validShares = 0; state.rejectedShares = 0; state.totalReward = 0;
  state.lastError = null; state.hashHistory = [];
  pushLog(`[${config.miningMode.toUpperCase()}] Mining GYDS on "${config.rpcEndpoint}" as "${config.workerName}" (${config.walletAddress})`);

  await fetchNewWork();
  spawnWorkers();

  workInterval = setInterval(async () => {
    try { await fetchNewWork(); }
    catch (err) { pushLog(`Work poll failed: ${err.message}`); if (!state.reconnecting) scheduleReconnect(); }
  }, 15000);

  hashRateInterval = setInterval(() => {
    state.hashRate = state.hashesThisSecond;
    state.hashesThisSecond = 0;
    state.hashHistory.push({ ts: Date.now(), hr: state.hashRate });
    if (state.hashHistory.length > 300) state.hashHistory.shift();
  }, 1000);

  return { ok: true, message: 'GYDS mining started' };
}

async function stopMining() {
  if (!state.running && !state.reconnecting) return { ok: true, message: 'Already stopped' };
  cancelReconnect();
  state.running = false;
  if (workInterval)     { clearInterval(workInterval);     workInterval = null; }
  if (hashRateInterval) { clearInterval(hashRateInterval); hashRateInterval = null; }
  stopWorkers();
  try { if (state.sessionId) await rpc('mining_disconnect', { sessionId: state.sessionId }); } catch {}
  state.connected = false; state.sessionId = null; state.hashRate = 0;
  pushLog('Mining stopped.');
  return { ok: true, message: 'Mining stopped' };
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!config.webPassword) return next();
  const provided = req.headers['x-miner-password'] || req.query.password;
  if (provided === config.webPassword) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Status ────────────────────────────────────────────────────────────────────
app.get('/api/status', requireAuth, (req, res) => {
  const cpus    = os.cpus().length;
  const loadavg = os.loadavg();
  const effScore = (state.running && state.hashRate > 0)
    ? Math.round(state.hashRate / Math.max(loadavg[0], 0.01)) : 0;
  const hpsPerThread = config.effectiveThreads > 0
    ? Math.round(state.hashRate / config.effectiveThreads) : 0;

  res.json({
    running: state.running, connected: state.connected,
    reconnecting: state.reconnecting, reconnectAttempt: state.reconnectAttempt,
    poolName: state.poolName,
    hashRate: state.hashRate, hashHistory: state.hashHistory.slice(-120),
    validShares: state.validShares, rejectedShares: state.rejectedShares,
    totalReward: state.totalReward,
    currentDifficulty: state.currentDifficulty, blockHeight: state.blockHeight,
    uptime: state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0,
    lastError: state.lastError,
    log: state.log.slice(-100),
    wallet: {
      walletAddress:  config.walletAddress,
      rpcEndpoint:    config.rpcEndpoint,
      cfClientId:     config.cfClientId,
      miningMode:     config.miningMode,
    },
    efficiency: { effScore, hpsPerThread },
    config: {
      workerName:       config.workerName,
      baseThreads:      config.baseThreads,
      effectiveThreads: config.effectiveThreads,
      batchSize:        config.batchSize,
      overclock:        config.overclock,
      webPort:          config.webPort,
      hasPassword:      !!config.webPassword,
      cpus,
    },
    system: {
      cpus, hostname: os.hostname(), platform: os.platform(),
      loadavg,
      freeMemMb:  Math.round(os.freemem()  / 1024 / 1024),
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
    },
  });
});

// ── Wallet settings ───────────────────────────────────────────────────────────
app.post('/api/wallet', requireAuth, async (req, res) => {
  const wasRunning = state.running;
  if (wasRunning) await stopMining();

  const b = req.body || {};
  if (typeof b.walletAddress  === 'string') config.walletAddress  = b.walletAddress.trim();
  if (typeof b.rpcEndpoint    === 'string') config.rpcEndpoint    = b.rpcEndpoint.trim();
  if (typeof b.cfClientId     === 'string') config.cfClientId     = b.cfClientId.trim();
  if (typeof b.cfClientSecret === 'string') config.cfClientSecret = b.cfClientSecret;
  if (b.miningMode === 'solo' || b.miningMode === 'pool') config.miningMode = b.miningMode;

  try { if (config.rpcEndpoint) validateRpcUrl(config.rpcEndpoint); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }

  saveConfig(config);
  pushLog(`Wallet settings updated. Wallet: ${config.walletAddress.slice(0, 10) || '(none)'}…`);

  if (wasRunning) await startMining();
  res.json({ ok: true });
});

// ── Test RPC ──────────────────────────────────────────────────────────────────
app.post('/api/test-rpc', requireAuth, async (req, res) => {
  const result = await probeRpc();
  res.json(result);
});

// ── Mining control ────────────────────────────────────────────────────────────
app.post('/api/start', requireAuth, async (req, res) => res.json(await startMining()));
app.post('/api/stop',  requireAuth, async (req, res) => res.json(await stopMining()));

// ── Mining settings ───────────────────────────────────────────────────────────
app.post('/api/config', requireAuth, async (req, res) => {
  const wasRunning = state.running;
  if (wasRunning) await stopMining();

  const body = req.body || {};
  const cpuCount = os.cpus().length;
  if (body.workerName) config.workerName = String(body.workerName).trim();
  if (typeof body.webPassword === 'string') config.webPassword = body.webPassword;
  if (Number.isFinite(body.batchSize) && body.batchSize >= 100) config.batchSize  = Math.floor(body.batchSize);
  if (Number.isFinite(body.overclock) && body.overclock >= 0.5) config.overclock  = body.overclock;
  if (Number.isFinite(body.threads)   && body.threads   >= 0)   config.baseThreads= Math.floor(body.threads);

  const resolved = config.baseThreads > 0 ? config.baseThreads : cpuCount;
  config.effectiveThreads = Math.max(1, Math.round(resolved * (config.overclock || 1)));

  saveConfig(config);
  pushLog(`Config updated: ${config.effectiveThreads} thread(s), batch=${config.batchSize}, overclock=${config.overclock}×`);

  if (wasRunning) await startMining();
  res.json({ ok: true, config });
});

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(app);
server.listen(config.webPort, '0.0.0.0', () => {
  pushLog(`Dashboard on http://0.0.0.0:${config.webPort}`);
});

process.on('SIGINT',  async () => { await stopMining(); process.exit(0); });
process.on('SIGTERM', async () => { await stopMining(); process.exit(0); });

// Auto-start if a wallet address is configured
if (config.walletAddress) {
  setTimeout(() => startMining(), 2000);
} else {
  pushLog('No wallet address configured — open the dashboard to set one and start mining.');
}
