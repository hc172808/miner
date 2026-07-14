#!/usr/bin/env node
/**
 * GYDS Miner — single-coin dashboard with full production features.
 *
 * Additions over v1:
 *  - Persistent stats (stats.json): shares/reward/uptime survive restarts
 *  - Worker crash recovery: exit-event listener replaces crashed threads
 *  - Worker stall watchdog: restart workers if no hashes for 60 s
 *  - Start/stop mutex: prevents race conditions from rapid UI clicks
 *  - Share retry: one automatic retry before marking a share rejected
 *  - Rate limiting: blocks IP for 5 min after 10 bad password attempts
 *  - Config backup: copies config.json → config.backup.json before every save
 *  - Log file: appends to miner.log (capped at 5 MB)
 *  - Circuit breaker: stops auto-reconnect after 20 failures; needs manual restart
 *  - /health endpoint: no auth, for uptime monitors
 *  - state.reconnectAt: lets the UI show exact countdown to next retry
 *  - CPU throttle: configurable batchDelayMs between worker batches
 */

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const http   = require('http');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const express = require('express');

// ── Paths ──────────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const cfgIdx     = args.indexOf('--config');
const configPath = cfgIdx !== -1 && args[cfgIdx + 1]
  ? path.resolve(args[cfgIdx + 1])
  : path.join(__dirname, 'config.json');
const statsPath  = path.join(__dirname, 'stats.json');
const logPath    = path.join(__dirname, 'miner.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

// ── Config ────────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  walletAddress: '', rpcEndpoint: 'https://netlifegy.com/api/mining/rpc',
  cfClientId: '', cfClientSecret: '', miningMode: 'pool',
  workerName: os.hostname(),
  threads: 0, overclock: 1, batchSize: 20000, batchDelayMs: 0,
  webPort: 5000, webPassword: '',
};

function computeThreads(raw) {
  const cpus      = os.cpus().length;
  const base      = Number.isFinite(raw.threads)   && raw.threads   >= 0   ? Math.floor(raw.threads) : 0;
  const overclock = Number.isFinite(raw.overclock)  && raw.overclock >= 0.5 ? raw.overclock : 1;
  const resolved  = base > 0 ? base : cpus;
  return { baseThreads: base, overclock, effectiveThreads: Math.max(1, Math.round(resolved * overclock)) };
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log('[miner] Created default config.json');
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Migrate old coins[] format
  let walletAddress = raw.walletAddress || '';
  let rpcEndpoint   = raw.rpcEndpoint   || DEFAULT_CONFIG.rpcEndpoint;
  let cfClientId    = raw.cfClientId    || '';
  let cfClientSecret= raw.cfClientSecret|| '';
  let miningMode    = raw.miningMode    || 'pool';
  if (!walletAddress && Array.isArray(raw.coins) && raw.coins.length > 0) {
    const a = raw.coins.find(c => c.id === raw.activeCoinId) || raw.coins[0];
    walletAddress = a.walletAddress || '';
    rpcEndpoint   = a.rpcEndpoint   || rpcEndpoint;
    cfClientId    = a.cfClientId    || '';
    cfClientSecret= a.cfClientSecret|| '';
    miningMode    = a.miningMode    || 'pool';
  }

  const { baseThreads, overclock, effectiveThreads } = computeThreads(raw);
  return {
    walletAddress, rpcEndpoint, cfClientId, cfClientSecret,
    miningMode: miningMode === 'solo' ? 'solo' : 'pool',
    workerName:   raw.workerName   || os.hostname(),
    baseThreads, overclock, effectiveThreads,
    batchSize:    Number.isFinite(raw.batchSize)    && raw.batchSize    >= 100 ? Math.floor(raw.batchSize)   : 20000,
    batchDelayMs: Number.isFinite(raw.batchDelayMs) && raw.batchDelayMs >= 0   ? Math.floor(raw.batchDelayMs): 0,
    webPort:      Number.isFinite(raw.webPort) ? raw.webPort : 5000,
    webPassword:  raw.webPassword || '',
  };
}

function saveConfig(cfg) {
  // Backup before overwriting
  if (fs.existsSync(configPath)) {
    try { fs.copyFileSync(configPath, configPath + '.backup'); } catch {}
  }
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
    batchDelayMs:   cfg.batchDelayMs,
    webPort:        cfg.webPort,
    webPassword:    cfg.webPassword,
  }, null, 2));
}

let config = loadConfig();

// ── Persistent stats ──────────────────────────────────────────────────────────
const DEFAULT_STATS = {
  lifetimeShares: 0, lifetimeRejected: 0, lifetimeReward: 0,
  lifetimeMiningSeconds: 0, totalSessions: 0,
  firstStarted: null, lastUpdated: null,
};

function loadStats() {
  try {
    if (fs.existsSync(statsPath)) return { ...DEFAULT_STATS, ...JSON.parse(fs.readFileSync(statsPath, 'utf8')) };
  } catch {}
  return { ...DEFAULT_STATS };
}

function saveStats() {
  try { fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2)); } catch {}
}

let stats = loadStats();
setInterval(() => {
  if (state.running) {
    stats.lifetimeMiningSeconds += 10;
    stats.lastUpdated = new Date().toISOString();
  }
  saveStats();
}, 10000);

// ── Log file ──────────────────────────────────────────────────────────────────
function writeLogFile(line) {
  try {
    // Rotate if over size limit
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > LOG_MAX_BYTES) {
      fs.renameSync(logPath, logPath + '.old');
    }
    fs.appendFileSync(logPath, line + '\n');
  } catch {}
}

// ── RPC helpers ───────────────────────────────────────────────────────────────
let rpcId = 1;

function validateRpcUrl(endpoint) {
  if (!endpoint) throw new Error('No RPC endpoint set.');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error(`Invalid RPC URL: "${endpoint}"`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`Protocol "${url.protocol.replace(':', '')}://" is not supported. Use HTTP/HTTPS.`);
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
    throw new Error(
      (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? `RPC timed out after 15 s — is "${config.rpcEndpoint}" reachable?`
        : `Cannot reach RPC at "${config.rpcEndpoint}". (${err.message})`
    );
  }
  if (res.redirected && (res.url || '').includes('cloudflareaccess.com'))
    throw new Error('Blocked by Cloudflare Access — set your CF Service Token in Wallet Settings.');
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html'))
    throw new Error('RPC returned an HTML page — likely Cloudflare Access. Set the CF Service Token.');
  if (res.status === 401) throw new Error('RPC returned 401 Unauthorized.');
  if (res.status === 403) throw new Error('RPC returned 403 Forbidden.');
  if (!res.ok)            throw new Error(`RPC returned HTTP ${res.status}.`);
  let data;
  try { data = await res.json(); } catch { throw new Error('RPC response is not valid JSON.'); }
  if (data.error) throw new Error(data.error.message || 'RPC error');
  return data.result;
}

// Share submission with one automatic retry
async function submitShare(params) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await rpc('mining_submitShare', params);
    } catch (err) {
      if (attempt === 2) throw err;
      pushLog(`Share submit failed, retrying… (${err.message})`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
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
      return { ok: false, error: 'Blocked by Cloudflare Access — set CF Service Token.', latency };
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html'))
      return { ok: false, error: 'Server returned HTML — likely Cloudflare Access login.', latency };
    if (res.status === 401) return { ok: false, error: '401 Unauthorized.', latency };
    if (res.status === 403) return { ok: false, error: '403 Forbidden.', latency };
    if (!res.ok)            return { ok: false, error: `HTTP ${res.status}`, latency };
    let body; try { body = await res.json(); } catch { body = null; }
    return { ok: true, latency, serverInfo: body?.result || null };
  } catch (err) {
    const latency = Date.now() - t0;
    return { ok: false, latency,
      error: (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? 'Timed out after 10 s — server unreachable or too slow.'
        : `Network error: ${err.message}` };
  }
}

// ── Miner state ───────────────────────────────────────────────────────────────
const MAX_RECONNECT_ATTEMPTS = 20;
const RECONNECT_DELAYS = [5000, 15000, 30000, 60000, 120000, 300000];

const state = {
  running: false, connected: false, actionInProgress: false,
  reconnecting: false, reconnectAttempt: 0, reconnectTimer: null,
  reconnectAt: null,          // timestamp when next reconnect fires
  circuitOpen: false,         // true = gave up reconnecting
  sessionId: null, workers: [], currentJob: null,
  hashRate: 0, hashesThisSecond: 0, lastHashTime: 0,
  validShares: 0, rejectedShares: 0, totalReward: 0,
  currentDifficulty: null, blockHeight: 0, poolName: null,
  startTime: null, lastError: null, log: [], hashHistory: [],
};

function pushLog(line) {
  const entry = `[${new Date().toISOString()}] ${line}`;
  state.log.push(entry);
  if (state.log.length > 300) state.log.shift();
  console.log(entry);
  writeLogFile(entry);
}

// ── Worker management ─────────────────────────────────────────────────────────
function spawnWorker(index) {
  const w = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: {
      minerAddress: config.walletAddress,
      job:          state.currentJob,
      batchSize:    config.batchSize,
      batchDelayMs: config.batchDelayMs,
    },
  });
  w.on('message', (msg) => onWorkerMessage(msg));
  w.on('error',   (err) => pushLog(`Worker ${index} error: ${err.message}`));
  w.on('exit',    (code) => {
    if (!state.running) return; // intentional shutdown
    pushLog(`Worker ${index} exited (code ${code}) — restarting…`);
    // Remove from array and spawn a replacement
    const idx = state.workers.indexOf(w);
    if (idx !== -1) {
      state.workers.splice(idx, 1);
      const replacement = spawnWorker(idx);
      state.workers.splice(idx, 0, replacement);
      if (state.currentJob) replacement.postMessage({ type: 'job', job: state.currentJob });
    }
  });
  return w;
}

function spawnWorkers() {
  for (let i = 0; i < config.effectiveThreads; i++) {
    state.workers.push(spawnWorker(i));
  }
  state.lastHashTime = Date.now();
  pushLog(`Spawned ${config.effectiveThreads} thread(s) (batch=${config.batchSize}, delay=${config.batchDelayMs}ms).`);
}

function stopWorkers() {
  const toStop = state.workers.splice(0);
  for (const w of toStop) { try { w.postMessage({ type: 'stop' }); w.terminate(); } catch {} }
}

function broadcastJob() {
  for (const w of state.workers) w.postMessage({ type: 'job', job: state.currentJob });
}

// Worker stall watchdog — restart workers if no hashes for 60 s while mining
setInterval(() => {
  if (!state.running || state.workers.length === 0) return;
  const staleMs = Date.now() - state.lastHashTime;
  if (staleMs > 60000) {
    pushLog(`⚠ Workers stalled for ${Math.round(staleMs / 1000)}s — restarting threads…`);
    stopWorkers();
    spawnWorkers();
    if (state.currentJob) broadcastJob();
  }
}, 15000);

async function onWorkerMessage(msg) {
  if (msg.type === 'hashes') {
    state.hashesThisSecond += msg.count;
    state.lastHashTime = Date.now();
  } else if (msg.type === 'share') {
    if (!state.currentJob || msg.jobId !== state.currentJob.jobId) return;
    try {
      const result = await submitShare({
        sessionId: state.sessionId, nonce: msg.nonce, hash: msg.hash, jobId: msg.jobId,
      });
      if (result?.accepted) {
        state.validShares++;
        state.totalReward += Number(result.reward || 0);
        stats.lifetimeShares++;
        stats.lifetimeReward += Number(result.reward || 0);
        pushLog(`Share accepted! Reward: ${result.reward ?? 0} GYDS`);
        await fetchNewWork();
      } else {
        state.rejectedShares++;
        stats.lifetimeRejected++;
        pushLog(`Share rejected: ${result?.message || 'unknown reason'}`);
      }
    } catch (err) {
      state.rejectedShares++;
      stats.lifetimeRejected++;
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

// ── Auto-reconnect with circuit breaker ───────────────────────────────────────
function cancelReconnect() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  state.reconnecting = false; state.reconnectAttempt = 0; state.reconnectAt = null;
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  if (state.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    state.circuitOpen  = true;
    state.reconnecting = false;
    state.reconnectAt  = null;
    pushLog(`⛔ Circuit breaker: gave up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts. Click Start to try again.`);
    return;
  }
  const delay = RECONNECT_DELAYS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  state.reconnecting = true;
  state.reconnectAt  = Date.now() + delay;
  pushLog(`Connection lost — reconnecting in ${delay / 1000}s (attempt ${state.reconnectAttempt + 1}/${MAX_RECONNECT_ATTEMPTS})…`);
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    state.reconnectAt    = null;
    state.reconnectAttempt++;
    stopWorkers();
    state.connected = false; state.sessionId = null;
    try {
      const conn = await rpc('mining_connect', {
        minerAddress: config.walletAddress, workerName: config.workerName, mode: config.miningMode,
      });
      state.sessionId = conn.sessionId;
      state.poolName  = conn.poolName || (config.miningMode === 'solo' ? 'Solo Node' : null);
      state.connected = true; state.reconnecting = false; state.reconnectAttempt = 0; state.circuitOpen = false;
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

// ── Mining control (mutex-protected) ─────────────────────────────────────────
let workInterval = null, hashRateInterval = null;

async function startMining() {
  if (state.actionInProgress) return { ok: false, message: 'Another action is in progress, please wait.' };
  if (state.running)          return { ok: true,  message: 'Already running' };
  if (!config.walletAddress)  return { ok: false, message: 'Set your GYDS wallet address in Wallet Settings first.' };
  if (!config.rpcEndpoint)    return { ok: false, message: 'Set the RPC endpoint in Wallet Settings first.' };

  state.actionInProgress = true;
  state.circuitOpen      = false;
  cancelReconnect();

  try {
    const conn = await rpc('mining_connect', {
      minerAddress: config.walletAddress, workerName: config.workerName, mode: config.miningMode,
    });
    state.sessionId = conn.sessionId;
    state.poolName  = conn.poolName || (config.miningMode === 'solo' ? 'Solo Node' : null);
    state.connected = true;
  } catch (err) {
    state.lastError        = err.message;
    state.actionInProgress = false;
    pushLog(`Connection failed: ${err.message}`);
    return { ok: false, message: `Could not connect: ${err.message}` };
  }

  state.running = true; state.startTime = Date.now();
  state.validShares = 0; state.rejectedShares = 0; state.totalReward = 0;
  state.lastError = null; state.hashHistory = []; state.lastHashTime = Date.now();
  stats.totalSessions++;
  if (!stats.firstStarted) stats.firstStarted = new Date().toISOString();

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

  state.actionInProgress = false;
  return { ok: true, message: 'GYDS mining started' };
}

async function stopMining() {
  if (state.actionInProgress) return { ok: false, message: 'Another action is in progress, please wait.' };
  if (!state.running && !state.reconnecting) return { ok: true, message: 'Already stopped' };

  state.actionInProgress = true;
  cancelReconnect();
  state.running = false;
  if (workInterval)     { clearInterval(workInterval);     workInterval = null; }
  if (hashRateInterval) { clearInterval(hashRateInterval); hashRateInterval = null; }
  stopWorkers();
  try { if (state.sessionId) await rpc('mining_disconnect', { sessionId: state.sessionId }); } catch {}
  state.connected = false; state.sessionId = null; state.hashRate = 0;
  if (state.startTime) {
    stats.lifetimeMiningSeconds += Math.floor((Date.now() - state.startTime) / 1000);
    saveStats();
  }
  pushLog('Mining stopped.');
  state.actionInProgress = false;
  return { ok: true, message: 'Mining stopped' };
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const loginAttempts = new Map(); // ip → { count, blockedUntil }
const MAX_LOGIN_ATTEMPTS  = 10;
const LOGIN_BLOCK_MS      = 5 * 60 * 1000; // 5 minutes

function requireAuth(req, res, next) {
  if (!config.webPassword) return next();

  const ip      = req.ip || 'unknown';
  const now     = Date.now();
  const attempt = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };

  if (attempt.blockedUntil > now) {
    const waitMin = Math.ceil((attempt.blockedUntil - now) / 60000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${waitMin} min.` });
  }

  const provided = req.headers['x-miner-password'] || req.query.password;
  if (provided === config.webPassword) {
    loginAttempts.delete(ip);
    return next();
  }

  attempt.count++;
  if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
    attempt.blockedUntil = now + LOGIN_BLOCK_MS;
    attempt.count = 0;
    pushLog(`⚠ IP ${ip} blocked for 5 min after ${MAX_LOGIN_ATTEMPTS} failed login attempts.`);
  }
  loginAttempts.set(ip, attempt);
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── /health — no auth, for uptime monitors ────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok:           true,
    running:      state.running,
    connected:    state.connected,
    reconnecting: state.reconnecting,
    circuitOpen:  state.circuitOpen,
    hashRate:     state.hashRate,
    uptime:       state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0,
    timestamp:    new Date().toISOString(),
  });
});

// ── /api/status ────────────────────────────────────────────────────────────────
app.get('/api/status', requireAuth, (req, res) => {
  const cpus    = os.cpus().length;
  const loadavg = os.loadavg();
  const effScore    = (state.running && state.hashRate > 0) ? Math.round(state.hashRate / Math.max(loadavg[0], 0.01)) : 0;
  const hpsPerThread= config.effectiveThreads > 0 ? Math.round(state.hashRate / config.effectiveThreads) : 0;

  res.json({
    running: state.running, connected: state.connected,
    reconnecting: state.reconnecting, reconnectAttempt: state.reconnectAttempt,
    reconnectAt: state.reconnectAt,
    circuitOpen: state.circuitOpen,
    poolName: state.poolName,
    hashRate: state.hashRate, hashHistory: state.hashHistory.slice(-120),
    validShares: state.validShares, rejectedShares: state.rejectedShares,
    totalReward: state.totalReward,
    currentDifficulty: state.currentDifficulty, blockHeight: state.blockHeight,
    uptime: state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0,
    lastError: state.lastError,
    log: state.log.slice(-100),
    // Persistent lifetime stats
    stats: {
      lifetimeShares:        stats.lifetimeShares,
      lifetimeRejected:      stats.lifetimeRejected,
      lifetimeReward:        stats.lifetimeReward,
      lifetimeMiningSeconds: stats.lifetimeMiningSeconds,
      totalSessions:         stats.totalSessions,
      firstStarted:          stats.firstStarted,
    },
    wallet: {
      walletAddress: config.walletAddress,
      rpcEndpoint:   config.rpcEndpoint,
      cfClientId:    config.cfClientId,
      miningMode:    config.miningMode,
    },
    efficiency: { effScore, hpsPerThread },
    config: {
      workerName: config.workerName,
      baseThreads: config.baseThreads, effectiveThreads: config.effectiveThreads,
      batchSize: config.batchSize, batchDelayMs: config.batchDelayMs,
      overclock: config.overclock, webPort: config.webPort,
      hasPassword: !!config.webPassword, cpus,
    },
    system: {
      cpus, hostname: os.hostname(), platform: os.platform(), loadavg,
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
app.post('/api/test-rpc', requireAuth, async (req, res) => res.json(await probeRpc()));

// ── Mining control ────────────────────────────────────────────────────────────
app.post('/api/start', requireAuth, async (req, res) => res.json(await startMining()));
app.post('/api/stop',  requireAuth, async (req, res) => res.json(await stopMining()));

// ── Mining settings ───────────────────────────────────────────────────────────
app.post('/api/config', requireAuth, async (req, res) => {
  const wasRunning = state.running;
  if (wasRunning) await stopMining();
  const b = req.body || {};
  const cpus = os.cpus().length;
  if (b.workerName)                                          config.workerName   = String(b.workerName).trim();
  if (typeof b.webPassword === 'string')                     config.webPassword  = b.webPassword;
  if (Number.isFinite(b.batchSize)    && b.batchSize   >= 100)  config.batchSize    = Math.floor(b.batchSize);
  if (Number.isFinite(b.batchDelayMs) && b.batchDelayMs >= 0)   config.batchDelayMs = Math.floor(b.batchDelayMs);
  if (Number.isFinite(b.overclock)    && b.overclock   >= 0.5)  config.overclock    = b.overclock;
  if (Number.isFinite(b.threads)      && b.threads     >= 0)    config.baseThreads  = Math.floor(b.threads);
  const resolved = config.baseThreads > 0 ? config.baseThreads : cpus;
  config.effectiveThreads = Math.max(1, Math.round(resolved * (config.overclock || 1)));
  saveConfig(config);
  pushLog(`Config updated: ${config.effectiveThreads} thread(s), batch=${config.batchSize}, delay=${config.batchDelayMs}ms, overclock=${config.overclock}×`);
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

if (config.walletAddress) {
  setTimeout(() => startMining(), 2000);
} else {
  pushLog('No wallet address configured — open the dashboard to set one and start mining.');
}
