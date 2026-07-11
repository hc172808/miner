# GYDS Miner

A standalone Node.js miner for the GYDS network that runs on Ubuntu (or any
Linux/macOS/Windows server with Node.js) and ships with a built-in web
dashboard for monitoring and remote control.

## Features
- Connects to any GYDS full node's mining RPC (`mining_connect`,
  `mining_getWork`, `mining_submitShare`, `mining_getStats`) — the same
  protocol used by the in-browser miner.
- Multi-threaded hashing via Node's `worker_threads` (defaults to one thread
  per CPU core).
- Web dashboard (Express) to view hash rate, shares, rewards, and system
  stats, and to start/stop mining or change configuration — no SSH required
  after setup.
- Runs as a `systemd` service: auto-starts on boot, restarts on crash.
- Optional dashboard password protection.

## Quick install (Ubuntu / Debian)

```bash
tar xzf gyds-miner.tar.gz   # or unzip, if you downloaded a zip
cd gyds-miner
sudo bash install.sh
```

The installer will:
1. Install Node.js 20.x if it isn't already present.
2. Copy the miner to `/opt/gyds-miner`.
3. Install dependencies.
4. Register and start a `gyds-miner` systemd service.
5. Open the dashboard port in `ufw` if it's active.
6. Print the dashboard URL.

## Configure

Open the dashboard at `http://<server-ip>:4500` and fill in:
- **RPC Endpoint** — your GYDS node's mining RPC URL (defaults to
  `https://netlifegy.com/api/mining/rpc`).
- **Miner Wallet Address** — the GYDS wallet address that should receive
  mining rewards.
- **Worker Name** — a label for this rig (shown in pool stats).
- **Threads** — how many CPU threads to dedicate to mining.
- **Dashboard Password** — optional, protects the dashboard/API.

You can also edit `/opt/gyds-miner/config.json` directly and restart the
service:

```json
{
  "rpcEndpoint": "https://netlifegy.com/api/mining/rpc",
  "minerAddress": "0xYourWalletAddressHere",
  "workerName": "ubuntu-rig-1",
  "threads": 0,
  "webPort": 4500,
  "webPassword": ""
}
```

`threads: 0` means "use all CPU cores". Set `webPassword` to require a
password before the dashboard/API can be used.

## Manual usage (without systemd)

```bash
cd gyds-miner
npm install
node miner.js                 # uses config.json next to miner.js
node miner.js --config /path/to/custom.json
```

## Managing the service

```bash
systemctl status gyds-miner     # check status
journalctl -u gyds-miner -f     # tail logs
systemctl restart gyds-miner    # restart (e.g. after editing config.json)
systemctl stop gyds-miner       # stop
```

## Uninstall

```bash
sudo systemctl disable --now gyds-miner
sudo rm -f /etc/systemd/system/gyds-miner.service
sudo rm -rf /opt/gyds-miner
sudo systemctl daemon-reload
```

## Notes
- The dashboard binds to `0.0.0.0` so it's reachable from other machines on
  your network — set `webPassword` if the server is internet-facing, and/or
  put it behind a firewall/VPN.
- The hashing algorithm mirrors the project's reference implementation
  (`src/lib/miningClient.ts`); actual reward accounting and difficulty are
  controlled by whatever GYDS node/pool you connect to.
