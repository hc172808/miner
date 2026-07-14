// worker.js — one mining thread.
// Repeatedly hashes candidate nonces against the current job's target
// and reports back to the parent thread whenever it finds a share or
// exhausts its nonce batch.
//
// Supports batchDelayMs: a configurable sleep between batches so the
// miner doesn't pin all CPU cores at 100 %.
const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');

let job          = workerData?.job         || null;
let minerAddress = workerData?.minerAddress|| '';
let batchSize    = (Number.isFinite(workerData?.batchSize) && workerData.batchSize >= 100)
  ? Math.floor(workerData.batchSize) : 20000;
let batchDelayMs = (Number.isFinite(workerData?.batchDelayMs) && workerData.batchDelayMs >= 0)
  ? Math.floor(workerData.batchDelayMs) : 0;

let running = true;
let hashes  = 0;

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function computeHash(prevHash, address, nonce) {
  return sha256Hex(`${prevHash}${address}${nonce}`);
}

function reportHashcount() {
  if (hashes > 0) {
    parentPort.postMessage({ type: 'hashes', count: hashes });
    hashes = 0;
  }
}
setInterval(reportHashcount, 1000);

function mineLoop() {
  if (!running) return;
  if (!job) {
    setTimeout(mineLoop, 200);
    return;
  }

  const target = BigInt('0x' + job.target);
  let nonce    = BigInt(job.nonceStart || 0);

  for (let i = 0; i < batchSize && running; i++) {
    const hash      = computeHash(job.prevBlockHash, minerAddress, nonce.toString());
    hashes++;
    const hashValue = BigInt('0x' + hash);
    if (hashValue < target) {
      parentPort.postMessage({
        type: 'share', jobId: job.jobId,
        nonce: nonce.toString(16), hash,
      });
    }
    nonce++;
  }

  if (job) job.nonceStart = Number(nonce);

  // CPU throttle: sleep between batches when batchDelayMs > 0
  if (batchDelayMs > 0) {
    setTimeout(mineLoop, batchDelayMs);
  } else {
    setImmediate(mineLoop);
  }
}

parentPort.on('message', (msg) => {
  if (msg.type === 'job') {
    job = msg.job;
  } else if (msg.type === 'stop') {
    running = false;
  } else if (msg.type === 'config') {
    if (Number.isFinite(msg.batchSize)    && msg.batchSize    >= 100) batchSize    = Math.floor(msg.batchSize);
    if (Number.isFinite(msg.batchDelayMs) && msg.batchDelayMs >= 0)   batchDelayMs = Math.floor(msg.batchDelayMs);
  }
});

mineLoop();
