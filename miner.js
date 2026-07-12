#!/usr/bin/env node
/**
 * Multi-coin Miner — connects to any GYDS-compatible mining RPC.
 * Features: multi-coin wallets, auto-reconnect, hash-rate chart, efficiency score.
 */
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const http = require('http');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const express = require('express');

// ── Config ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const configFlagIdx = args.indexOf('--config');
const configPath = configFlagIdx !== -1 && args[configFlagIdx + 1]
  ? path.resolve(args[configFlagIdx + 1])
  : path.join(__dirname, 'config.json');

function computeThreads(raw) {
  const cpuCount = os.cpus().length;
  const base     = Number.isFinite(raw.threads)  && raw.threads  >= 0   ? Math.floor(raw.threads) : 0;
  const overclock= Number.isFinite(raw.overclock) && raw.overclock >= 0.5 ? raw.overclock : 1;
  const resolved = base > 0 ? base : cpuCount;
  return { baseThreads: base, overclock, effectiveThreads: Math.max(1, Math.round(resolved * overclock)) };
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log('[miner] Created default config.json — open the dashboard to configure.');
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const { baseThreads, overclock, effectiveThreads } = computeThreads(raw);

  // Migrate legacy flat config → coins array
  let coins = Array.isArray(raw.coins) ? raw.coins : [];
  if (coins.length === 0 && raw.minerAddress) {
    coins = [{
      id: 'default',
      name: detectCoin(raw.minerAddress).name,
      symbol: detectCoin(raw.minerAddress).symbol,
      walletAddress: raw.minerAddress,
      rpcEndpoint: raw.rpcEndpoint || 'https://netlifegy.com/api/mining/rpc',
      cfClientId: raw.cfClientId || '',
      cfClientSecret: raw.cfClientSecret || '',
      miningMode: 'pool',
    }];
  }
  // Ensure every coin has miningMode
  coins = coins.map(c => ({ miningMode: 'pool', ...c }));

  return {
    coins,
    activeCoinId: raw.activeCoinId || (coins[0]?.id ?? null),
    workerName:   raw.workerName   || os.hostname(),
    baseThreads, overclock, effectiveThreads,
    batchSize: Number.isFinite(raw.batchSize) && raw.batchSize >= 100 ? Math.floor(raw.batchSize) : 20000,
    webPort:   Number.isFinite(raw.webPort) ? raw.webPort : 5000,
    webPassword: raw.webPassword || '',
  };
}

const DEFAULT_CONFIG = {
  coins: [], activeCoinId: null,
  workerName: os.hostname(),
  threads: 0, overclock: 1, batchSize: 20000,
  webPort: 5000, webPassword: '',
};

function saveConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify({
    coins:        cfg.coins,
    activeCoinId: cfg.activeCoinId,
    workerName:   cfg.workerName,
    threads:      cfg.baseThreads,
    overclock:    cfg.overclock,
    batchSize:    cfg.batchSize,
    webPort:      cfg.webPort,
    webPassword:  cfg.webPassword,
  }, null, 2));
}

let config = loadConfig();

// ── Coin presets ──────────────────────────────────────────────────────────────
const COIN_PRESETS = [
  { symbol: 'GYDS',   name: 'GYDS',           suggestedRpc: 'https://netlifegy.com/api/mining/rpc' },
  { symbol: 'ETH',    name: 'Ethereum',        suggestedRpc: '' },
  { symbol: 'MONAD',  name: 'Monad',           suggestedRpc: '' },
  { symbol: 'BNB',    name: 'BNB Chain',       suggestedRpc: '' },
  { symbol: 'MATIC',  name: 'Polygon',         suggestedRpc: '' },
  { symbol: 'AVAX',   name: 'Avalanche',       suggestedRpc: '' },
  { symbol: 'SOL',    name: 'Solana',          suggestedRpc: '' },
  { symbol: 'TRX',    name: 'Tron',            suggestedRpc: '' },
  { symbol: 'ADA',    name: 'Cardano',         suggestedRpc: '' },
  { symbol: 'XMR',    name: 'Monero',          suggestedRpc: '' },
  { symbol: 'BTC',    name: 'Bitcoin',         suggestedRpc: '' },
  { symbol: 'LTC',    name: 'Litecoin',        suggestedRpc: '' },
  { symbol: 'DOGE',   name: 'Dogecoin',        suggestedRpc: '' },
  { symbol: 'XRP',    name: 'Ripple',          suggestedRpc: '' },
  { symbol: 'CUSTOM', name: 'Custom Network',  suggestedRpc: '' },
];

// ── Coin auto-detection ───────────────────────────────────────────────────────
function detectCoin(address) {
  if (!address) return { name: 'Unknown', symbol: '?', suggestedRpc: '' };
  const a = address.trim();

  // EVM-compatible (GYDS, ETH, Monad, BNB, MATIC, AVAX, etc.)
  if (/^0x[0-9a-fA-F]{40}$/.test(a))
    return { name: 'GYDS / EVM', symbol: 'GYDS', suggestedRpc: 'https://netlifegy.com/api/mining/rpc' };
  // Bitcoin legacy & bech32
  if (/^(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(a) || /^bc1[a-z0-9]{6,87}$/.test(a))
    return { name: 'Bitcoin',  symbol: 'BTC',  suggestedRpc: '' };
  // Litecoin
  if (/^[LM][a-km-zA-HJ-NP-Z1-9]{26,33}$/.test(a))
    return { name: 'Litecoin', symbol: 'LTC',  suggestedRpc: '' };
  // Dogecoin
  if (/^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}$/.test(a))
    return { name: 'Dogecoin', symbol: 'DOGE', suggestedRpc: '' };
  // Tron (T + 33 base58 chars)
  if (/^T[A-HJ-NP-Za-km-z1-9]{33}$/.test(a))
    return { name: 'Tron',     symbol: 'TRX',  suggestedRpc: '' };
  // Cardano Shelley
  if (/^addr1[a-z0-9]{50,}$/.test(a))
    return { name: 'Cardano',  symbol: 'ADA',  suggestedRpc: '' };
  // Cardano Byron
  if (/^(Ae2|DdzFF)[a-zA-Z0-9]+$/.test(a))
    return { name: 'Cardano',  symbol: 'ADA',  suggestedRpc: '' };
  // Monero (95 chars, starts with 4 or 8)
  if (/^[48][0-9A-Za-z]{94}$/.test(a))
    return { name: 'Monero',   symbol: 'XMR',  suggestedRpc: '' };
  // Ripple / XRP
  if (/^r[a-km-zA-HJ-NP-Z1-9]{24,34}$/.test(a))
    return { name: 'Ripple',   symbol: 'XRP',  suggestedRpc: '' };
  // Solana (base58, typically 43–44 chars)
  if (/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(a))
    return { name: 'Solana',   symbol: 'SOL',  suggestedRpc: '' };

  return { name: 'Custom Network', symbol: 'CUSTOM', suggestedRpc: '' };
}

// ── RPC client ────────────────────────────────────────────────────────────────
let rpcId = 1;
function activeCoin() {
  return config.coins.find(c => c.id === config.activeCoinId) || config.coins[0] || null;
}

async function rpc(method, params) {
  const coin = activeCoin();
  if (!coin) throw new Error('No coin configured. Add a coin in the dashboard first.');
  const headers = { 'Content-Type': 'application/json' };
  if (coin.cfClientId)     headers['CF-Access-Client-Id']     = coin.cfClientId;
  if (coin.cfClientSecret) headers['CF-Access-Client-Secret'] = coin.cfClientSecret;

  const res = await fetch(coin.rpcEndpoint, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: rpcId++ }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    if (res.status === 302 || res.status === 403) {
      throw new Error('Blocked by Cloudflare Access — set CF Service Token for this coin in the dashboard.');
    }
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'RPC error');
  return data.result;
}

// ── Miner state ───────────────────────────────────────────────────────────────
const RECONNECT_DELAYS = [5000, 15000, 30000, 60000, 120000, 300000]; // ms

const state = {
  running:          false,
  connected:        false,
  reconnecting:     false,
  reconnectAttempt: 0,
  reconnectTimer:   null,
  sessionId:        null,
  workers:          [],
  currentJob:       null,
  hashRate:         0,
  hashesThisSecond: 0,
  validShares:      0,
  rejectedShares:   0,
  totalReward:      0,
  currentDifficulty:null,
  blockHeight:      0,
  poolName:         null,
  startTime:        null,
  lastError:        null,
  log:              [],
  // rolling hash-rate history (one sample/sec, max 300 = 5 min)
  hashHistory:      [],
};

function pushLog(line) {
  const entry = `[${new Date().toISOString()}] ${line}`;
  state.log.push(entry);
  if (state.log.length > 300) state.log.shift();
  console.log(entry);
}

// ── Worker management ─────────────────────────────────────────────────────────
function spawnWorkers() {
  const coin = activeCoin();
  for (let i = 0; i < config.effectiveThreads; i++) {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: {
        minerAddress: coin?.walletAddress || '',
        job: state.currentJob,
        batchSize: config.batchSize,
      },
    });
    worker.on('message', (msg) => onWorkerMessage(worker, msg));
    worker.on('error',   (err) => pushLog(`Worker ${i} error: ${err.message}`));
    state.workers.push(worker);
  }
  pushLog(`Spawned ${config.effectiveThreads} thread(s) for ${coin?.symbol || '?'}.`);
}

function stopWorkers() {
  for (const w of state.workers) {
    try { w.postMessage({ type: 'stop' }); w.terminate(); } catch {}
  }
  state.workers = [];
}

function broadcastJob() {
  for (const w of state.workers) w.postMessage({ type: 'job', job: state.currentJob });
}

async function onWorkerMessage(worker, msg) {
  if (msg.type === 'hashes') {
    state.hashesThisSecond += msg.count;
  } else if (msg.type === 'share') {
    if (!state.currentJob || msg.jobId !== state.currentJob.jobId) return;
    try {
      const result = await rpc('mining_submitShare', {
        sessionId: state.sessionId,
        nonce: msg.nonce, hash: msg.hash, jobId: msg.jobId,
      });
      if (result?.accepted) {
        state.validShares++;
        state.totalReward += Number(result.reward || 0);
        pushLog(`Share accepted! Reward: ${result.reward ?? 0} ${activeCoin()?.symbol || ''}`);
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

// ── Work fetching ─────────────────────────────────────────────────────────────
async function fetchNewWork() {
  try {
    const work = await rpc('mining_getWork', { sessionId: state.sessionId });
    if (!work) return;
    state.currentJob      = { ...work, nonceStart: Math.floor(Math.random() * 1e9) };
    state.blockHeight     = work.blockHeight  ?? state.blockHeight;
    state.currentDifficulty = work.difficulty ?? state.currentDifficulty;
    broadcastJob();
  } catch (err) {
    pushLog(`Failed to fetch work: ${err.message}`);
    // If we lose the work feed while running, trigger a reconnect
    if (state.running && !state.reconnecting) scheduleReconnect();
  }
}

// ── Auto-reconnect ────────────────────────────────────────────────────────────
function cancelReconnect() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  state.reconnecting     = false;
  state.reconnectAttempt = 0;
}

function scheduleReconnect() {
  if (state.reconnectTimer) return; // already queued
  const delay = RECONNECT_DELAYS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  state.reconnecting = true;
  pushLog(`Connection lost — reconnecting in ${delay / 1000}s (attempt ${state.reconnectAttempt + 1})…`);
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    state.reconnectAttempt++;
    // Full restart: reconnect session + fresh workers
    stopWorkers();
    state.connected = false;
    state.sessionId = null;
    const coin = activeCoin();
    if (!coin) { state.reconnecting = false; return; }
    try {
      const mode = coin.miningMode || 'pool';
      const conn = await rpc('mining_connect', { minerAddress: coin.walletAddress, workerName: config.workerName, mode });
      state.sessionId = conn.sessionId;
      state.poolName  = conn.poolName || (mode === 'solo' ? 'Solo Node' : null);
      state.connected = true;
      state.reconnecting = false;
      state.reconnectAttempt = 0;
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
let workInterval     = null;
let hashRateInterval = null;

async function startMining() {
  if (state.running) return { ok: true, message: 'Already running' };
  const coin = activeCoin();
  if (!coin) return { ok: false, message: 'No coin configured. Add a coin in the dashboard first.' };
  if (!coin.walletAddress) return { ok: false, message: `Set a wallet address for ${coin.name} first.` };
  if (!coin.rpcEndpoint)   return { ok: false, message: `Set an RPC endpoint for ${coin.name} first.` };

  cancelReconnect();

  try {
    const mode = coin.miningMode || 'pool';
    const conn = await rpc('mining_connect', { minerAddress: coin.walletAddress, workerName: config.workerName, mode });
    state.sessionId = conn.sessionId;
    state.poolName  = conn.poolName || (mode === 'solo' ? 'Solo Node' : null);
    state.connected = true;
  } catch (err) {
    state.lastError = err.message;
    pushLog(`Connection failed: ${err.message}`);
    return { ok: false, message: `Could not connect: ${err.message}` };
  }

  state.running           = true;
  state.startTime         = Date.now();
  state.validShares       = 0;
  state.rejectedShares    = 0;
  state.totalReward       = 0;
  state.lastError         = null;
  state.hashHistory       = [];
  const mode = coin.miningMode || 'pool';
  pushLog(`[${mode.toUpperCase()}] Mining ${coin.symbol} on "${coin.rpcEndpoint}" as "${config.workerName}" (${coin.walletAddress})`);

  await fetchNewWork();
  spawnWorkers();

  workInterval = setInterval(async () => {
    try { await fetchNewWork(); }
    catch (err) {
      pushLog(`Work poll failed: ${err.message}`);
      if (!state.reconnecting) scheduleReconnect();
    }
  }, 15000);

  hashRateInterval = setInterval(() => {
    state.hashRate = state.hashesThisSecond;
    state.hashesThisSecond = 0;
    // push to rolling history
    state.hashHistory.push({ ts: Date.now(), hr: state.hashRate });
    if (state.hashHistory.length > 300) state.hashHistory.shift();
  }, 1000);

  return { ok: true, message: `Mining ${coin.symbol} started` };
}

async function stopMining() {
  if (!state.running && !state.reconnecting) return { ok: true, message: 'Already stopped' };
  cancelReconnect();
  state.running = false;
  if (workInterval)     { clearInterval(workInterval);     workInterval = null; }
  if (hashRateInterval) { clearInterval(hashRateInterval); hashRateInterval = null; }
  stopWorkers();
  try {
    if (state.sessionId) await rpc('mining_disconnect', { sessionId: state.sessionId });
  } catch {}
  state.connected = false;
  state.sessionId = null;
  state.hashRate  = 0;
  pushLog('Mining stopped.');
  return { ok: true, message: 'Mining stopped' };
}

// ── Web dashboard ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!config.webPassword) return next();
  const provided = req.headers['x-miner-password'] || req.query.password;
  if (provided === config.webPassword) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Status
app.get('/api/status', requireAuth, (req, res) => {
  const coin     = activeCoin();
  const cpus     = os.cpus().length;
  const loadavg  = os.loadavg();
  const effScore = (state.running && state.hashRate > 0)
    ? Math.round(state.hashRate / Math.max(loadavg[0], 0.01))
    : 0;
  const hpsPerThread = config.effectiveThreads > 0
    ? Math.round(state.hashRate / config.effectiveThreads)
    : 0;

  res.json({
    running:           state.running,
    connected:         state.connected,
    reconnecting:      state.reconnecting,
    reconnectAttempt:  state.reconnectAttempt,
    poolName:          state.poolName,
    hashRate:          state.hashRate,
    hashHistory:       state.hashHistory.slice(-120), // last 2 min
    validShares:       state.validShares,
    rejectedShares:    state.rejectedShares,
    totalReward:       state.totalReward,
    currentDifficulty: state.currentDifficulty,
    blockHeight:       state.blockHeight,
    uptime:            state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0,
    lastError:         state.lastError,
    log:               state.log.slice(-100),
    activeCoin:        coin ? { id: coin.id, name: coin.name, symbol: coin.symbol, miningMode: coin.miningMode || 'pool' } : null,
    efficiency: { effScore, hpsPerThread },
    config: {
      activeCoinId:    config.activeCoinId,
      workerName:      config.workerName,
      baseThreads:     config.baseThreads,
      effectiveThreads:config.effectiveThreads,
      batchSize:       config.batchSize,
      overclock:       config.overclock,
      webPort:         config.webPort,
      cpus,
      hasPassword:     !!config.webPassword,
    },
    system: {
      cpus, hostname: os.hostname(), platform: os.platform(),
      loadavg,
      freeMemMb:  Math.round(os.freemem()  / 1024 / 1024),
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
    },
  });
});

// ── Coin management ───────────────────────────────────────────────────────────
app.get('/api/coins', requireAuth, (req, res) => {
  res.json({ coins: config.coins, activeCoinId: config.activeCoinId });
});

app.post('/api/coins', requireAuth, (req, res) => {
  const { walletAddress, rpcEndpoint, name, symbol, cfClientId, cfClientSecret, miningMode } = req.body || {};
  if (!walletAddress || !rpcEndpoint) return res.status(400).json({ error: 'walletAddress and rpcEndpoint are required.' });
  const detected = detectCoin(walletAddress);
  const coin = {
    id:            crypto.randomUUID(),
    name:          name   || detected.name,
    symbol:        symbol || detected.symbol,
    walletAddress: walletAddress.trim(),
    rpcEndpoint:   rpcEndpoint.trim(),
    cfClientId:    cfClientId    || '',
    cfClientSecret:cfClientSecret || '',
    miningMode:    (miningMode === 'solo' ? 'solo' : 'pool'),
  };
  config.coins.push(coin);
  if (!config.activeCoinId) config.activeCoinId = coin.id;
  saveConfig(config);
  pushLog(`Coin added: ${coin.symbol} [${coin.miningMode}] (${coin.walletAddress.slice(0, 10)}…)`);
  res.json({ ok: true, coin, coins: config.coins, activeCoinId: config.activeCoinId });
});

app.put('/api/coins/:id', requireAuth, async (req, res) => {
  const coin = config.coins.find(c => c.id === req.params.id);
  if (!coin) return res.status(404).json({ error: 'Coin not found.' });
  const b = req.body || {};
  if (b.walletAddress) coin.walletAddress = b.walletAddress.trim();
  if (b.rpcEndpoint)   coin.rpcEndpoint   = b.rpcEndpoint.trim();
  if (b.name)          coin.name          = b.name.trim();
  if (b.symbol)        coin.symbol        = b.symbol.trim();
  if (typeof b.cfClientId === 'string')     coin.cfClientId     = b.cfClientId.trim();
  if (typeof b.cfClientSecret === 'string') coin.cfClientSecret = b.cfClientSecret;
  if (b.miningMode === 'solo' || b.miningMode === 'pool') coin.miningMode = b.miningMode;
  saveConfig(config);
  res.json({ ok: true, coin });
});

app.delete('/api/coins/:id', requireAuth, async (req, res) => {
  const wasRunning = state.running && config.activeCoinId === req.params.id;
  if (wasRunning) await stopMining();
  config.coins = config.coins.filter(c => c.id !== req.params.id);
  if (config.activeCoinId === req.params.id) config.activeCoinId = config.coins[0]?.id ?? null;
  saveConfig(config);
  res.json({ ok: true, coins: config.coins, activeCoinId: config.activeCoinId });
});

app.post('/api/coins/:id/activate', requireAuth, async (req, res) => {
  const coin = config.coins.find(c => c.id === req.params.id);
  if (!coin) return res.status(404).json({ error: 'Coin not found.' });
  const wasRunning = state.running;
  if (wasRunning) await stopMining();
  config.activeCoinId = coin.id;
  saveConfig(config);
  pushLog(`Active coin switched to ${coin.symbol}.`);
  if (wasRunning) await startMining();
  res.json({ ok: true, activeCoinId: config.activeCoinId });
});

// Detect coin type from wallet address
app.post('/api/detect-coin', requireAuth, (req, res) => {
  const { walletAddress } = req.body || {};
  res.json(detectCoin(walletAddress));
});

// Known coin presets for the UI picker
app.get('/api/coin-presets', requireAuth, (req, res) => {
  res.json({ presets: COIN_PRESETS });
});

// ── General config ────────────────────────────────────────────────────────────
app.post('/api/start',  requireAuth, async (req, res) => res.json(await startMining()));
app.post('/api/stop',   requireAuth, async (req, res) => res.json(await stopMining()));

app.post('/api/config', requireAuth, async (req, res) => {
  const wasRunning = state.running;
  if (wasRunning) await stopMining();

  const body = req.body || {};
  const cpuCount = os.cpus().length;
  if (body.workerName)   config.workerName  = String(body.workerName).trim();
  if (typeof body.webPassword === 'string') config.webPassword = body.webPassword;
  if (Number.isFinite(body.batchSize)  && body.batchSize  >= 100) config.batchSize  = Math.floor(body.batchSize);
  if (Number.isFinite(body.overclock)  && body.overclock  >= 0.5) config.overclock  = body.overclock;
  if (Number.isFinite(body.threads)    && body.threads    >= 0)   config.baseThreads= Math.floor(body.threads);

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

// Auto-start if a coin with a wallet address is configured
const coin = activeCoin();
if (coin?.walletAddress) {
  startMining();
} else {
  pushLog('No coin configured yet — open the dashboard to add one and start mining.');
}
