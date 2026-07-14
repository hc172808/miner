#!/usr/bin/env node
/**
 * GYDS Miner — single-coin dashboard, full production build.
 *
 * New in this version:
 *  - Multiple RPC / Litenode endpoints with automatic failover
 *    config.rpcEndpoints = [{ id, label, url, cfClientId, cfClientSecret }]
 *    rpc() tries each endpoint in order; switches on failure.
 *  - CRUD API for endpoints: GET/POST/PUT/DELETE /api/endpoints
 *  - /api/endpoints/:id/test — probe a single endpoint
 *  - /api/status now includes endpoints[] + activeEndpointIdx
 */

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const http   = require('http');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const express = require('express');

// ── Paths ─────────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const cfgIdx     = args.indexOf('--config');
const configPath = cfgIdx !== -1 && args[cfgIdx + 1]
  ? path.resolve(args[cfgIdx + 1])
  : path.join(__dirname, 'config.json');
const statsPath     = path.join(__dirname, 'stats.json');
const logPath       = path.join(__dirname, 'miner.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;

// ── Config ────────────────────────────────────────────────────────────────────
function makeEndpoint(url = '', label = 'Primary', cfId = '', cfSec = '') {
  return { id: crypto.randomUUID(), label, url, cfClientId: cfId, cfClientSecret: cfSec };
}

const DEFAULT_CONFIG = {
  walletAddress: '', miningMode: 'pool',
  rpcEndpoints: [makeEndpoint('https://netlifegy.com/api/mining/rpc', 'Primary')],
  workerName: os.hostname(),
  threads: 0, overclock: 1, batchSize: 20000, batchDelayMs: 0,
  webPort: 5000, webPassword: '',
};

function computeThreads(raw) {
  const cpus      = os.cpus().length;
  const base      = Number.isFinite(raw.threads)  && raw.threads  >= 0   ? Math.floor(raw.threads) : 0;
  const overclock = Number.isFinite(raw.overclock) && raw.overclock >= 0.5 ? raw.overclock : 1;
  const resolved  = base > 0 ? base : cpus;
  return { baseThreads: base, overclock, effectiveThreads: Math.max(1, Math.round(resolved * overclock)) };
}

function normaliseEndpoints(raw) {
  // New format: rpcEndpoints[]
  if (Array.isArray(raw.rpcEndpoints) && raw.rpcEndpoints.length > 0) {
    return raw.rpcEndpoints.map(e => ({
      id:            e.id            || crypto.randomUUID(),
      label:         e.label         || 'Node',
      url:           e.url           || '',
      cfClientId:    e.cfClientId    || '',
      cfClientSecret:e.cfClientSecret|| '',
    }));
  }
  // Migrate legacy flat fields
  const url = raw.rpcEndpoint || DEFAULT_CONFIG.rpcEndpoints[0].url;
  return [makeEndpoint(url, 'Primary', raw.cfClientId || '', raw.cfClientSecret || '')];
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log('[miner] Created default config.json');
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Migrate coins[] → flat
  let walletAddress = raw.walletAddress || '';
  let miningMode    = raw.miningMode    || 'pool';
  if (!walletAddress && Array.isArray(raw.coins) && raw.coins.length > 0) {
    const a   = raw.coins.find(c => c.id === raw.activeCoinId) || raw.coins[0];
    walletAddress = a.walletAddress || '';
    miningMode    = a.miningMode    || 'pool';
  }

  const { baseThreads, overclock, effectiveThreads } = computeThreads(raw);
  return {
    walletAddress,
    miningMode: miningMode === 'solo' ? 'solo' : 'pool',
    rpcEndpoints: normaliseEndpoints(raw),
    workerName:   raw.workerName || os.hostname(),
    baseThreads, overclock, effectiveThreads,
    batchSize:    Number.isFinite(raw.batchSize)    && raw.batchSize    >= 100 ? Math.floor(raw.batchSize)    : 20000,
    batchDelayMs: Number.isFinite(raw.batchDelayMs) && raw.batchDelayMs >= 0   ? Math.floor(raw.batchDelayMs) : 0,
    webPort:      Number.isFinite(raw.webPort) ? raw.webPort : 5000,
    webPassword:  raw.webPassword || '',
  };
}

function saveConfig(cfg) {
  if (fs.existsSync(configPath)) {
    try { fs.copyFileSync(configPath, configPath + '.backup'); } catch {}
  }
  fs.writeFileSync(configPath, JSON.stringify({
    walletAddress:  cfg.walletAddress,
    miningMode:     cfg.miningMode,
    rpcEndpoints:   cfg.rpcEndpoints,
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
    if (fs.existsSync(statsPath))
      return { ...DEFAULT_STATS, ...JSON.parse(fs.readFileSync(statsPath, 'utf8')) };
  } catch {}
  return { ...DEFAULT_STATS };
}
function saveStats() {
  try { fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2)); } catch {}
}
let stats = loadStats();
setInterval(() => {
  if (state.running) { stats.lifetimeMiningSeconds += 10; stats.lastUpdated = new Date().toISOString(); }
  saveStats();
}, 10000);

// ── Log file ──────────────────────────────────────────────────────────────────
function writeLogFile(line) {
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > LOG_MAX_BYTES)
      fs.renameSync(logPath, logPath + '.old');
    fs.appendFileSync(logPath, line + '\n');
  } catch {}
}

// ── RPC helpers ───────────────────────────────────────────────────────────────
let rpcId = 1;
let activeEndpointIdx = 0;

function validateRpcUrl(url) {
  if (!url) throw new Error('No URL provided.');
  let u;
  try { u = new URL(url); } catch { throw new Error(`Invalid URL: "${url}"`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new Error(`Protocol "${u.protocol.replace(':', '')}://" is not supported. Use HTTP or HTTPS.`);
}

async function callEndpoint(ep, method, params) {
  validateRpcUrl(ep.url);
  const headers = { 'Content-Type': 'application/json' };
  if (ep.cfClientId)     headers['CF-Access-Client-Id']     = ep.cfClientId;
  if (ep.cfClientSecret) headers['CF-Access-Client-Secret'] = ep.cfClientSecret;
  let res;
  try {
    res = await fetch(ep.url, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: rpcId++ }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(
      (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? `[${ep.label}] Timed out — is "${ep.url}" reachable?`
        : `[${ep.label}] Cannot reach "${ep.url}". (${err.message})`
    );
  }
  if (res.redirected && (res.url || '').includes('cloudflareaccess.com'))
    throw new Error(`[${ep.label}] Blocked by Cloudflare Access — set CF Service Token for this endpoint.`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html'))
    throw new Error(`[${ep.label}] Returned HTML — likely Cloudflare Access. Set CF Service Token.`);
  if (res.status === 401) throw new Error(`[${ep.label}] 401 Unauthorized.`);
  if (res.status === 403) throw new Error(`[${ep.label}] 403 Forbidden.`);
  if (!res.ok)            throw new Error(`[${ep.label}] HTTP ${res.status}.`);
  let data;
  try { data = await res.json(); } catch { throw new Error(`[${ep.label}] Response is not valid JSON.`); }
  if (data.error) throw new Error(data.error.message || 'RPC error');
  return data.result;
}

// Tries endpoints in round-robin from activeEndpointIdx; fails over on error
async function rpc(method, params) {
  const endpoints = config.rpcEndpoints.filter(e => e.url);
  if (!endpoints.length) throw new Error('No RPC endpoints configured. Add one in Wallet Settings.');
  let lastError;
  for (let attempt = 0; attempt < endpoints.length; attempt++) {
    const idx = (activeEndpointIdx + attempt) % endpoints.length;
    const ep  = endpoints[idx];
    try {
      const result = await callEndpoint(ep, method, params);
      if (attempt > 0) {
        activeEndpointIdx = idx;
        pushLog(`✓ Failover: now using "${ep.label}" (${ep.url})`);
      }
      return result;
    } catch (err) {
      lastError = err;
      if (attempt < endpoints.length - 1)
        pushLog(`⚠ "${ep.label}" failed — trying next endpoint… (${err.message})`);
    }
  }
  throw lastError;
}

// Share with one auto-retry
async function submitShare(params) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { return await rpc('mining_submitShare', params); }
    catch (err) {
      if (attempt === 2) throw err;
      pushLog(`Share submit failed, retrying… (${err.message})`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// Probe a single endpoint; returns { ok, latency, error?, serverInfo? }
async function probeEndpoint(ep) {
  try { validateRpcUrl(ep.url); } catch (e) { return { ok: false, error: e.message, latency: 0 }; }
  const headers = { 'Content-Type': 'application/json' };
  if (ep.cfClientId)     headers['CF-Access-Client-Id']     = ep.cfClientId;
  if (ep.cfClientSecret) headers['CF-Access-Client-Secret'] = ep.cfClientSecret;
  const t0 = Date.now();
  try {
    const res = await fetch(ep.url, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'mining_getInfo', params: {}, id: 0 }),
      signal: AbortSignal.timeout(10000),
    });
    const latency = Date.now() - t0;
    if (res.redirected && (res.url || '').includes('cloudflareaccess.com'))
      return { ok: false, error: 'Blocked by Cloudflare Access — set CF Service Token.', latency };
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html'))
      return { ok: false, error: 'Returned HTML — likely Cloudflare Access login.', latency };
    if (res.status === 401) return { ok: false, error: '401 Unauthorized.', latency };
    if (res.status === 403) return { ok: false, error: '403 Forbidden.', latency };
    if (!res.ok)            return { ok: false, error: `HTTP ${res.status}`, latency };
    let body; try { body = await res.json(); } catch { body = null; }
    return { ok: true, latency, serverInfo: body?.result || null };
  } catch (err) {
    const latency = Date.now() - t0;
    return { ok: false, latency,
      error: (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? 'Timed out after 10s — server unreachable or too slow.'
        : `Network error: ${err.message}` };
  }
}

// ── Miner state ───────────────────────────────────────────────────────────────
const MAX_RECONNECT_ATTEMPTS = 20;
const RECONNECT_DELAYS = [5000, 15000, 30000, 60000, 120000, 300000];

const state = {
  running: false, connected: false, actionInProgress: false,
  reconnecting: false, reconnectAttempt: 0, reconnectTimer: null,
  reconnectAt: null, circuitOpen: false,
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

// ── Workers ───────────────────────────────────────────────────────────────────
function spawnWorker(index) {
  const w = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: {
      minerAddress: config.walletAddress,
      job:          state.currentJob,
      batchSize:    config.batchSize,
      batchDelayMs: config.batchDelayMs,
    },
  });
  w.on('message', onWorkerMessage);
  w.on('error',   (err) => pushLog(`Worker ${index} error: ${err.message}`));
  w.on('exit',    (code) => {
    if (!state.running) return;
    pushLog(`Worker ${index} exited (code ${code}) — restarting…`);
    const idx = state.workers.indexOf(w);
    if (idx !== -1) {
      state.workers.splice(idx, 1);
      const rep = spawnWorker(idx);
      state.workers.splice(idx, 0, rep);
      if (state.currentJob) rep.postMessage({ type: 'job', job: state.currentJob });
    }
  });
  return w;
}

function spawnWorkers() {
  for (let i = 0; i < config.effectiveThreads; i++) state.workers.push(spawnWorker(i));
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

setInterval(() => {
  if (!state.running || state.workers.length === 0) return;
  const staleMs = Date.now() - state.lastHashTime;
  if (staleMs > 60000) {
    pushLog(`⚠ Workers stalled ${Math.round(staleMs / 1000)}s — restarting threads…`);
    stopWorkers(); spawnWorkers();
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
        state.validShares++; state.totalReward += Number(result.reward || 0);
        stats.lifetimeShares++; stats.lifetimeReward += Number(result.reward || 0);
        pushLog(`Share accepted! Reward: ${result.reward ?? 0} GYDS`);
        await fetchNewWork();
      } else {
        state.rejectedShares++; stats.lifetimeRejected++;
        pushLog(`Share rejected: ${result?.message || 'unknown reason'}`);
      }
    } catch (err) {
      state.rejectedShares++; stats.lifetimeRejected++;
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

// ── Reconnect / circuit breaker ───────────────────────────────────────────────
function cancelReconnect() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  state.reconnecting = false; state.reconnectAttempt = 0; state.reconnectAt = null;
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  if (state.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    state.circuitOpen = true; state.reconnecting = false; state.reconnectAt = null;
    pushLog(`⛔ Circuit breaker: gave up after ${MAX_RECONNECT_ATTEMPTS} attempts. Click Start to retry manually.`);
    return;
  }
  const delay = RECONNECT_DELAYS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  state.reconnecting = true; state.reconnectAt = Date.now() + delay;
  pushLog(`Connection lost — reconnecting in ${delay / 1000}s (${state.reconnectAttempt + 1}/${MAX_RECONNECT_ATTEMPTS})…`);
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null; state.reconnectAt = null; state.reconnectAttempt++;
    stopWorkers(); state.connected = false; state.sessionId = null;
    try {
      const conn = await rpc('mining_connect', {
        minerAddress: config.walletAddress, workerName: config.workerName, mode: config.miningMode,
      });
      state.sessionId = conn.sessionId;
      state.poolName  = conn.poolName || (config.miningMode === 'solo' ? 'Solo Node' : null);
      state.connected = true; state.reconnecting = false; state.reconnectAttempt = 0; state.circuitOpen = false;
      pushLog(`Reconnected to ${state.poolName || 'pool'}.`);
      await fetchNewWork(); spawnWorkers();
    } catch (err) {
      state.lastError = err.message; pushLog(`Reconnect failed: ${err.message}`); scheduleReconnect();
    }
  }, delay);
}

// ── Mining control (mutex) ────────────────────────────────────────────────────
let workInterval = null, hashRateInterval = null;

async function startMining() {
  if (state.actionInProgress) return { ok: false, message: 'Another action is in progress, please wait.' };
  if (state.running)          return { ok: true,  message: 'Already running' };
  if (!config.walletAddress)  return { ok: false, message: 'Set your GYDS wallet address in Wallet Settings first.' };
  if (!config.rpcEndpoints.some(e => e.url))
    return { ok: false, message: 'Add at least one RPC endpoint in Wallet Settings.' };

  state.actionInProgress = true; state.circuitOpen = false;
  cancelReconnect();

  try {
    const conn = await rpc('mining_connect', {
      minerAddress: config.walletAddress, workerName: config.workerName, mode: config.miningMode,
    });
    state.sessionId = conn.sessionId;
    state.poolName  = conn.poolName || (config.miningMode === 'solo' ? 'Solo Node' : null);
    state.connected = true;
  } catch (err) {
    state.lastError = err.message; state.actionInProgress = false;
    pushLog(`Connection failed: ${err.message}`);
    return { ok: false, message: `Could not connect: ${err.message}` };
  }

  state.running = true; state.startTime = Date.now();
  state.validShares = 0; state.rejectedShares = 0; state.totalReward = 0;
  state.lastError = null; state.hashHistory = []; state.lastHashTime = Date.now();
  stats.totalSessions++;
  if (!stats.firstStarted) stats.firstStarted = new Date().toISOString();

  const activeEp = config.rpcEndpoints.filter(e => e.url)[activeEndpointIdx] || config.rpcEndpoints[0];
  pushLog(`[${config.miningMode.toUpperCase()}] Mining GYDS via "${activeEp?.label}" as "${config.workerName}" (${config.walletAddress})`);

  await fetchNewWork(); spawnWorkers();

  workInterval = setInterval(async () => {
    try { await fetchNewWork(); }
    catch (err) { pushLog(`Work poll failed: ${err.message}`); if (!state.reconnecting) scheduleReconnect(); }
  }, 15000);

  hashRateInterval = setInterval(() => {
    state.hashRate = state.hashesThisSecond; state.hashesThisSecond = 0;
    state.hashHistory.push({ ts: Date.now(), hr: state.hashRate });
    if (state.hashHistory.length > 300) state.hashHistory.shift();
  }, 1000);

  state.actionInProgress = false;
  return { ok: true, message: 'GYDS mining started' };
}

async function stopMining() {
  if (state.actionInProgress) return { ok: false, message: 'Another action is in progress, please wait.' };
  if (!state.running && !state.reconnecting) return { ok: true, message: 'Already stopped' };
  state.actionInProgress = true; cancelReconnect(); state.running = false;
  if (workInterval)     { clearInterval(workInterval);     workInterval = null; }
  if (hashRateInterval) { clearInterval(hashRateInterval); hashRateInterval = null; }
  stopWorkers();
  try { if (state.sessionId) await rpc('mining_disconnect', { sessionId: state.sessionId }); } catch {}
  state.connected = false; state.sessionId = null; state.hashRate = 0;
  if (state.startTime) { stats.lifetimeMiningSeconds += Math.floor((Date.now() - state.startTime) / 1000); saveStats(); }
  pushLog('Mining stopped.'); state.actionInProgress = false;
  return { ok: true, message: 'Mining stopped' };
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const loginAttempts  = new Map();
const MAX_ATTEMPTS   = 10;
const BLOCK_DURATION = 5 * 60 * 1000;

function requireAuth(req, res, next) {
  if (!config.webPassword) return next();
  const ip  = req.ip || 'unknown';
  const now = Date.now();
  const att = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
  if (att.blockedUntil > now)
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil((att.blockedUntil - now) / 60000)} min.` });
  const provided = req.headers['x-miner-password'] || req.query.password;
  if (provided === config.webPassword) { loginAttempts.delete(ip); return next(); }
  att.count++;
  if (att.count >= MAX_ATTEMPTS) {
    att.blockedUntil = now + BLOCK_DURATION; att.count = 0;
    pushLog(`⚠ IP ${ip} blocked for 5 min after ${MAX_ATTEMPTS} failed login attempts.`);
  }
  loginAttempts.set(ip, att);
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// /health — no auth
app.get('/health', (req, res) => res.json({
  ok: true, running: state.running, connected: state.connected,
  reconnecting: state.reconnecting, circuitOpen: state.circuitOpen,
  hashRate: state.hashRate,
  uptime: state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0,
  timestamp: new Date().toISOString(),
}));

// /api/status
app.get('/api/status', requireAuth, (req, res) => {
  const cpus    = os.cpus().length;
  const loadavg = os.loadavg();
  const effScore     = (state.running && state.hashRate > 0) ? Math.round(state.hashRate / Math.max(loadavg[0], 0.01)) : 0;
  const hpsPerThread = config.effectiveThreads > 0 ? Math.round(state.hashRate / config.effectiveThreads) : 0;
  const validEps = config.rpcEndpoints.filter(e => e.url);

  res.json({
    running: state.running, connected: state.connected,
    reconnecting: state.reconnecting, reconnectAttempt: state.reconnectAttempt,
    reconnectAt: state.reconnectAt, circuitOpen: state.circuitOpen,
    poolName: state.poolName,
    hashRate: state.hashRate, hashHistory: state.hashHistory.slice(-120),
    validShares: state.validShares, rejectedShares: state.rejectedShares,
    totalReward: state.totalReward,
    currentDifficulty: state.currentDifficulty, blockHeight: state.blockHeight,
    uptime: state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0,
    lastError: state.lastError, log: state.log.slice(-100),
    stats: {
      lifetimeShares:        stats.lifetimeShares,
      lifetimeRejected:      stats.lifetimeRejected,
      lifetimeReward:        stats.lifetimeReward,
      lifetimeMiningSeconds: stats.lifetimeMiningSeconds,
      totalSessions:         stats.totalSessions,
      firstStarted:          stats.firstStarted,
    },
    wallet: { walletAddress: config.walletAddress, miningMode: config.miningMode },
    // Endpoints — strip cfClientSecret from response for security
    endpoints: config.rpcEndpoints.map((e, i) => ({
      id: e.id, label: e.label, url: e.url,
      cfClientId: e.cfClientId,
      hasCfSecret: !!e.cfClientSecret,
      active: validEps.length > 0 && validEps[activeEndpointIdx % validEps.length]?.id === e.id,
    })),
    activeEndpointIdx,
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

// ── Wallet (address + mode only) ──────────────────────────────────────────────
app.post('/api/wallet', requireAuth, async (req, res) => {
  const wasRunning = state.running;
  if (wasRunning) await stopMining();
  const b = req.body || {};
  if (typeof b.walletAddress === 'string') config.walletAddress = b.walletAddress.trim();
  if (b.miningMode === 'solo' || b.miningMode === 'pool') config.miningMode = b.miningMode;
  saveConfig(config);
  pushLog(`Wallet updated: ${config.walletAddress.slice(0, 10) || '(none)'}…`);
  if (wasRunning) await startMining();
  res.json({ ok: true });
});

// ── Endpoint CRUD ─────────────────────────────────────────────────────────────
// List
app.get('/api/endpoints', requireAuth, (req, res) => {
  res.json({
    endpoints: config.rpcEndpoints.map(e => ({
      id: e.id, label: e.label, url: e.url,
      cfClientId: e.cfClientId, hasCfSecret: !!e.cfClientSecret,
    })),
    activeEndpointIdx,
  });
});

// Add
app.post('/api/endpoints', requireAuth, (req, res) => {
  const b = req.body || {};
  const url = (b.url || '').trim();
  if (!url) return res.status(400).json({ ok: false, error: 'url is required.' });
  try { validateRpcUrl(url); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  const ep = {
    id:            crypto.randomUUID(),
    label:         (b.label || 'Node').trim(),
    url,
    cfClientId:    (b.cfClientId    || '').trim(),
    cfClientSecret: b.cfClientSecret || '',
  };
  config.rpcEndpoints.push(ep);
  saveConfig(config);
  pushLog(`Endpoint added: "${ep.label}" → ${ep.url}`);
  res.json({ ok: true, endpoint: { ...ep, cfClientSecret: undefined, hasCfSecret: !!ep.cfClientSecret } });
});

// Update
app.put('/api/endpoints/:id', requireAuth, (req, res) => {
  const ep = config.rpcEndpoints.find(e => e.id === req.params.id);
  if (!ep) return res.status(404).json({ ok: false, error: 'Endpoint not found.' });
  const b = req.body || {};
  if (typeof b.label === 'string')         ep.label         = b.label.trim();
  if (typeof b.url   === 'string') {
    const url = b.url.trim();
    try { validateRpcUrl(url); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    ep.url = url;
  }
  if (typeof b.cfClientId     === 'string') ep.cfClientId     = b.cfClientId.trim();
  if (typeof b.cfClientSecret === 'string') ep.cfClientSecret = b.cfClientSecret;
  saveConfig(config);
  pushLog(`Endpoint updated: "${ep.label}" → ${ep.url}`);
  res.json({ ok: true });
});

// Delete
app.delete('/api/endpoints/:id', requireAuth, (req, res) => {
  const idx = config.rpcEndpoints.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Endpoint not found.' });
  if (config.rpcEndpoints.length === 1)
    return res.status(400).json({ ok: false, error: 'Cannot delete the last endpoint.' });
  const [removed] = config.rpcEndpoints.splice(idx, 1);
  if (activeEndpointIdx >= config.rpcEndpoints.length) activeEndpointIdx = 0;
  saveConfig(config);
  pushLog(`Endpoint removed: "${removed.label}"`);
  res.json({ ok: true, endpoints: config.rpcEndpoints });
});

// Reorder (swap positions)
app.post('/api/endpoints/reorder', requireAuth, (req, res) => {
  const { fromIdx, toIdx } = req.body || {};
  const n = config.rpcEndpoints.length;
  if (fromIdx < 0 || fromIdx >= n || toIdx < 0 || toIdx >= n)
    return res.status(400).json({ ok: false, error: 'Invalid index.' });
  const [moved] = config.rpcEndpoints.splice(fromIdx, 1);
  config.rpcEndpoints.splice(toIdx, 0, moved);
  activeEndpointIdx = 0; // reset active to first after reorder
  saveConfig(config);
  res.json({ ok: true, endpoints: config.rpcEndpoints });
});

// Test a single endpoint
app.post('/api/endpoints/:id/test', requireAuth, async (req, res) => {
  const ep = config.rpcEndpoints.find(e => e.id === req.params.id);
  if (!ep) return res.status(404).json({ ok: false, error: 'Endpoint not found.' });
  const result = await probeEndpoint(ep);
  res.json({ id: ep.id, label: ep.label, url: ep.url, ...result });
});

// Test-all
app.post('/api/test-rpc', requireAuth, async (req, res) => {
  const results = await Promise.all(
    config.rpcEndpoints.map(ep => probeEndpoint(ep).then(r => ({ id: ep.id, label: ep.label, url: ep.url, ...r })))
  );
  res.json({ results });
});

// ── Mining control / config ───────────────────────────────────────────────────
app.post('/api/start', requireAuth, async (req, res) => res.json(await startMining()));
app.post('/api/stop',  requireAuth, async (req, res) => res.json(await stopMining()));

app.post('/api/config', requireAuth, async (req, res) => {
  const wasRunning = state.running;
  if (wasRunning) await stopMining();
  const b = req.body || {}, cpus = os.cpus().length;
  if (b.workerName)                                           config.workerName   = String(b.workerName).trim();
  if (typeof b.webPassword === 'string')                      config.webPassword  = b.webPassword;
  if (Number.isFinite(b.batchSize)    && b.batchSize    >= 100) config.batchSize    = Math.floor(b.batchSize);
  if (Number.isFinite(b.batchDelayMs) && b.batchDelayMs >= 0)   config.batchDelayMs = Math.floor(b.batchDelayMs);
  if (Number.isFinite(b.overclock)    && b.overclock    >= 0.5)  config.overclock    = b.overclock;
  if (Number.isFinite(b.threads)      && b.threads      >= 0)    config.baseThreads  = Math.floor(b.threads);
  const resolved = config.baseThreads > 0 ? config.baseThreads : cpus;
  config.effectiveThreads = Math.max(1, Math.round(resolved * (config.overclock || 1)));
  saveConfig(config);
  pushLog(`Config: ${config.effectiveThreads} threads, batch=${config.batchSize}, delay=${config.batchDelayMs}ms, overclock=${config.overclock}×`);
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
