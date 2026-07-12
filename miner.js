#!/usr/bin/env node
/**
 * GYDS Miner — standalone Node.js miner for Ubuntu/any Linux server.
 *
 * - Connects to a GYDS full node's mining RPC (mining_connect / mining_getWork /
 *   mining_submitShare / mining_getStats / mining_getPoolInfo), the same
 *   JSON-RPC protocol used by the in-browser miner (src/lib/miningClient.ts).
 * - Spreads hashing across worker_threads (one per CPU core by default).
 * - Serves a small web dashboard (Express) so you can monitor/control the
 *   miner remotely from a browser.
 *
 * Usage:
 *   node miner.js                     # uses config.json next to this file
 *   node miner.js --config my.json    # custom config path
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { Worker } = require('worker_threads');
const express = require('express');

// ── Config ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const configFlagIdx = args.indexOf('--config');
const configPath = configFlagIdx !== -1 && args[configFlagIdx + 1]
  ? path.resolve(args[configFlagIdx + 1])
  : path.join(__dirname, 'config.json');

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    const examplePath = path.join(__dirname, 'config.example.json');
    fs.copyFileSync(examplePath, configPath);
    console.log(`[gyds-miner] No config.json found — created one from config.example.json at ${configPath}`);
    console.log(`[gyds-miner] Edit it (or use the web dashboard) to set your wallet address, then restart.`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const cpuCount = os.cpus().length;
  // baseThreads: 0 means "auto" (use all CPU cores). Stored as-is in config.json — never overwritten with the computed value.
  const baseThreads = Number.isFinite(raw.threads) && raw.threads >= 0 ? Math.floor(raw.threads) : 0;
  // overclock: multiplier applied at runtime only; 1 = no overclock.
  const overclock = Number.isFinite(raw.overclock) && raw.overclock >= 0.5 ? raw.overclock : 1;
  // effectiveThreads: computed once here, used to spawn workers. Never persisted.
  const resolvedBase = baseThreads > 0 ? baseThreads : cpuCount;
  const effectiveThreads = Math.max(1, Math.round(resolvedBase * overclock));
  return {
    rpcEndpoint: raw.rpcEndpoint || 'https://netlifegy.com/api/mining/rpc',
    minerAddress: raw.minerAddress || '',
    workerName: raw.workerName || os.hostname(),
    baseThreads,        // raw — what gets saved to disk (0 = auto)
    effectiveThreads,   // derived — what gets spawned, never saved
    batchSize: Number.isFinite(raw.batchSize) && raw.batchSize >= 100 ? Math.floor(raw.batchSize) : 20000,
    overclock,
    webPort: Number.isFinite(raw.webPort) ? raw.webPort : 5000,
    webPassword: raw.webPassword || '',
  };
}

/** Persist only the raw, non-derived fields. effectiveThreads is always recomputed on load. */
function saveConfig(cfg) {
  const toWrite = {
    rpcEndpoint: cfg.rpcEndpoint,
    minerAddress: cfg.minerAddress,
    workerName: cfg.workerName,
    threads: cfg.baseThreads,   // always save the raw base, never effectiveThreads
    batchSize: cfg.batchSize,
    overclock: cfg.overclock,
    webPort: cfg.webPort,
    webPassword: cfg.webPassword,
  };
  fs.writeFileSync(configPath, JSON.stringify(toWrite, null, 2));
}

let config = loadConfig();

// ── RPC client ───────────────────────────────────────────────────────────────
let rpcId = 1;
async function rpc(method, params) {
  const res = await fetch(config.rpcEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: rpcId++ }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'RPC error');
  return data.result;
}

// ── Miner state ──────────────────────────────────────────────────────────────
const state = {
  running: false,
  connected: false,
  sessionId: null,
  workers: [],
  currentJob: null,
  hashRate: 0,
  hashesThisSecond: 0,
  validShares: 0,
  rejectedShares: 0,
  totalReward: 0,
  currentDifficulty: null,
  blockHeight: 0,
  poolName: null,
  startTime: null,
  lastError: null,
  log: [],
};

function pushLog(line) {
  const entry = `[${new Date().toISOString()}] ${line}`;
  state.log.push(entry);
  if (state.log.length > 300) state.log.shift();
  console.log(entry);
}

function spawnWorkers() {
  for (let i = 0; i < config.effectiveThreads; i++) {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { minerAddress: config.minerAddress, job: state.currentJob, batchSize: config.batchSize },
    });
    worker.on('message', (msg) => onWorkerMessage(worker, msg));
    worker.on('error', (err) => pushLog(`Worker ${i} error: ${err.message}`));
    state.workers.push(worker);
  }
  pushLog(`Spawned ${config.effectiveThreads} mining thread(s).`);
}

function stopWorkers() {
  for (const w of state.workers) {
    try { w.postMessage({ type: 'stop' }); w.terminate(); } catch {}
  }
  state.workers = [];
}

function broadcastJob() {
  for (const w of state.workers) {
    w.postMessage({ type: 'job', job: state.currentJob });
  }
}

async function onWorkerMessage(worker, msg) {
  if (msg.type === 'hashes') {
    state.hashesThisSecond += msg.count;
  } else if (msg.type === 'share') {
    if (!state.currentJob || msg.jobId !== state.currentJob.jobId) return; // stale share
    try {
      const result = await rpc('mining_submitShare', {
        sessionId: state.sessionId,
        nonce: msg.nonce,
        hash: msg.hash,
        jobId: msg.jobId,
      });
      if (result?.accepted) {
        state.validShares++;
        state.totalReward += Number(result.reward || 0);
        pushLog(`Share accepted (reward: ${result.reward ?? 0} GYDS)`);
        await fetchNewWork(); // job likely advanced after an accepted share
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

async function fetchNewWork() {
  try {
    const work = await rpc('mining_getWork', { sessionId: state.sessionId });
    if (!work) return;
    state.currentJob = { ...work, nonceStart: Math.floor(Math.random() * 1e9) };
    state.blockHeight = work.blockHeight ?? state.blockHeight;
    state.currentDifficulty = work.difficulty ?? state.currentDifficulty;
    broadcastJob();
  } catch (err) {
    pushLog(`Failed to fetch work: ${err.message}`);
  }
}

let workInterval = null;
let hashRateInterval = null;

async function startMining() {
  if (state.running) return { ok: true, message: 'Already running' };
  if (!config.minerAddress) {
    return { ok: false, message: 'Set a miner wallet address first (via config.json or the dashboard).' };
  }

  try {
    const conn = await rpc('mining_connect', { minerAddress: config.minerAddress, workerName: config.workerName });
    state.sessionId = conn.sessionId;
    state.poolName = conn.poolName || null;
    state.connected = true;
  } catch (err) {
    state.lastError = err.message;
    pushLog(`Connection failed: ${err.message}`);
    return { ok: false, message: `Could not connect to RPC: ${err.message}` };
  }

  state.running = true;
  state.startTime = Date.now();
  state.validShares = 0;
  state.rejectedShares = 0;
  state.totalReward = 0;
  state.lastError = null;
  pushLog(`Connected to ${state.poolName || 'pool'} as "${config.workerName}" (${config.minerAddress})`);

  await fetchNewWork();
  spawnWorkers();

  workInterval = setInterval(fetchNewWork, 15000);
  hashRateInterval = setInterval(() => {
    state.hashRate = state.hashesThisSecond;
    state.hashesThisSecond = 0;
  }, 1000);

  return { ok: true, message: 'Mining started' };
}

async function stopMining() {
  if (!state.running) return { ok: true, message: 'Already stopped' };
  state.running = false;
  if (workInterval) clearInterval(workInterval);
  if (hashRateInterval) clearInterval(hashRateInterval);
  stopWorkers();
  try {
    if (state.sessionId) await rpc('mining_disconnect', { sessionId: state.sessionId });
  } catch {}
  state.connected = false;
  state.sessionId = null;
  state.hashRate = 0;
  pushLog('Mining stopped.');
  return { ok: true, message: 'Mining stopped' };
}

// ── Web dashboard ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!config.webPassword) return next();
  const provided = req.headers['x-miner-password'] || req.query.password;
  if (provided === config.webPassword) return next();
  res.status(401).json({ error: 'Unauthorized — invalid dashboard password' });
}

app.get('/api/status', requireAuth, (req, res) => {
  res.json({
    running: state.running,
    connected: state.connected,
    poolName: state.poolName,
    hashRate: state.hashRate,
    validShares: state.validShares,
    rejectedShares: state.rejectedShares,
    totalReward: state.totalReward,
    currentDifficulty: state.currentDifficulty,
    blockHeight: state.blockHeight,
    uptime: state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0,
    lastError: state.lastError,
    log: state.log.slice(-100),
    config: {
      rpcEndpoint: config.rpcEndpoint,
      minerAddress: config.minerAddress,
      workerName: config.workerName,
      baseThreads: config.baseThreads,         // raw (0 = auto); bound to the threads input
      effectiveThreads: config.effectiveThreads, // computed; shown in system info only
      batchSize: config.batchSize,
      overclock: config.overclock,
      webPort: config.webPort,
      cpus: os.cpus().length,
      hasPassword: !!config.webPassword,
    },
    system: {
      cpus: os.cpus().length,
      hostname: os.hostname(),
      platform: os.platform(),
      loadavg: os.loadavg(),
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
    },
  });
});

app.post('/api/start', requireAuth, async (req, res) => {
  const result = await startMining();
  res.json(result);
});

app.post('/api/stop', requireAuth, async (req, res) => {
  const result = await stopMining();
  res.json(result);
});

app.post('/api/config', requireAuth, async (req, res) => {
  const wasRunning = state.running;
  if (wasRunning) await stopMining();

  const body = req.body || {};
  const cpuCount = os.cpus().length;

  // Update only the raw/stored fields — never write effectiveThreads back to config.
  if (body.rpcEndpoint) config.rpcEndpoint = String(body.rpcEndpoint).trim();
  if (body.minerAddress) config.minerAddress = String(body.minerAddress).trim();
  if (body.workerName) config.workerName = String(body.workerName).trim();
  if (Number.isFinite(body.batchSize) && body.batchSize >= 100) config.batchSize = Math.floor(body.batchSize);
  if (Number.isFinite(body.overclock) && body.overclock >= 0.5) config.overclock = body.overclock;
  // baseThreads: 0 means auto. Accept 0 explicitly from dashboard "0 = auto" input.
  if (Number.isFinite(body.threads) && body.threads >= 0) config.baseThreads = Math.floor(body.threads);
  if (typeof body.webPassword === 'string') config.webPassword = body.webPassword;

  // Recompute effectiveThreads from raw values — identical formula as loadConfig.
  const resolvedBase = config.baseThreads > 0 ? config.baseThreads : cpuCount;
  config.effectiveThreads = Math.max(1, Math.round(resolvedBase * (config.overclock || 1)));

  // Persist only the raw fields (saveConfig already does this correctly).
  saveConfig(config);
  pushLog(`Configuration updated: ${config.effectiveThreads} effective thread(s) (base=${config.baseThreads || 'auto'}, overclock=${config.overclock}×, batch=${config.batchSize}).`);

  if (wasRunning) await startMining();
  res.json({ ok: true, config });
});

const server = http.createServer(app);
server.listen(config.webPort, '0.0.0.0', () => {
  pushLog(`Web dashboard listening on http://0.0.0.0:${config.webPort}`);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', async () => { await stopMining(); process.exit(0); });
process.on('SIGTERM', async () => { await stopMining(); process.exit(0); });

// Auto-start mining on boot if a wallet address is already configured.
if (config.minerAddress) {
  startMining();
} else {
  pushLog('No miner wallet address configured yet — open the dashboard to set one and start mining.');
}
