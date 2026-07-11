// worker.js — one mining thread. Repeatedly hashes candidate nonces against
// the current job's target and reports back to the parent thread whenever it
// finds a share (hash < target) or exhausts its nonce batch.
const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');

let job = workerData?.job || null;
let minerAddress = workerData?.minerAddress || '';
let running = true;
let hashes = 0;

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
  const batchSize = 20000;
  let nonce = BigInt(job.nonceStart || 0);

  for (let i = 0; i < batchSize && running; i++) {
    const hash = computeHash(job.prevBlockHash, minerAddress, nonce.toString());
    hashes++;

    const hashValue = BigInt('0x' + hash);
    if (hashValue < target) {
      parentPort.postMessage({
        type: 'share',
        jobId: job.jobId,
        nonce: nonce.toString(16),
        hash,
      });
    }
    nonce++;
  }

  // Keep nonce space distinct across batches for this worker.
  if (job) job.nonceStart = Number(nonce);

  setImmediate(mineLoop);
}

parentPort.on('message', (msg) => {
  if (msg.type === 'job') {
    job = msg.job;
  } else if (msg.type === 'stop') {
    running = false;
  }
});

mineLoop();
