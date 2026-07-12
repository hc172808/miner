# GYDS Miner

A standalone Node.js miner for the GYDS network with a built-in web dashboard for monitoring and control.

## How to run

The workflow starts automatically. The dashboard is served on **port 5000**.

```bash
node miner.js
```

## Configuration

Edit `config.json` or use the web dashboard at runtime:

| Field | Default | Description |
|---|---|---|
| `rpcEndpoint` | `https://netlifegy.com/api/mining/rpc` | GYDS node RPC URL |
| `minerAddress` | _(required)_ | GYDS wallet address for rewards |
| `workerName` | `replit-rig-1` | Label shown in pool stats |
| `threads` | `0` (auto = CPU count) | Base thread count |
| `batchSize` | `20000` | Hashes per worker tick — higher = more CPU per tick |
| `overclock` | `1` | Thread multiplier (e.g. `2` = 2× threads beyond CPU count) |
| `webPort` | `5000` | Dashboard port (keep at 5000 on Replit) |
| `webPassword` | _(empty)_ | Optional dashboard password |

## Overclocking

- **Overclock multiplier**: Effective threads = `baseThreads × overclock`. Setting to `2` doubles the thread count beyond your CPU core count. Use with caution — too many threads can slow hashing due to context-switching overhead.
- **Batch size**: Controls how many hashes each thread computes per event-loop tick. Higher values increase throughput on idle CPUs but may cause latency spikes.

## Stack

- Node.js (≥18), `worker_threads` for multi-threaded hashing
- Express for the web dashboard
- SHA-256 hashing via Node's built-in `crypto`

## User preferences

- Dashboard port: 5000 (required for Replit webview)
