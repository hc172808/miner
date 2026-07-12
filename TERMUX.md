# Running GYDS Miner on Android (Termux)

This guide sets up the miner on your Android phone using [Termux](https://termux.dev).

## 1 — Install Termux

Install from **F-Droid** (recommended — Google Play version is outdated):
https://f-droid.org/packages/com.termux/

## 2 — Install Node.js inside Termux

Open Termux and run:

```bash
pkg update && pkg upgrade -y
pkg install nodejs git -y
```

Verify:

```bash
node -v    # should show v18 or newer
npm -v
```

## 3 — Get the miner files

**Option A — clone from your repo (if it's on GitHub):**

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git gyds-miner
cd gyds-miner
```

**Option B — copy files manually:**

Use a file manager or `termux-setup-storage` to copy the project folder to Termux storage.

## 4 — Install dependencies

```bash
cd gyds-miner        # or wherever you placed the files
npm install
```

## 5 — Configure

Edit `config.json` before starting (or use the web dashboard after starting):

```bash
nano config.json
```

Set at minimum:

```json
{
  "rpcEndpoint": "https://rpc.nelifegy.com",
  "minerAddress": "0xYourWalletAddress",
  "workerName": "android-termux",
  "threads": 0,
  "batchSize": 20000,
  "overclock": 1,
  "webPort": 5000,
  "webPassword": "changeme"
}
```

> **Tip:** Set `webPassword` so no one on your local network can control the miner via the dashboard.

## 6 — Start the miner

```bash
node miner.js
```

You should see:

```
[...] Web dashboard listening on http://0.0.0.0:5000
```

## 7 — Open the dashboard on your phone

While the miner is running, open your phone's browser and go to:

```
http://localhost:5000
```

Or from another device on the same Wi-Fi:

```
http://<your-phone-ip>:5000
```

To find your phone's IP inside Termux:

```bash
ip addr show | grep 'inet '
```

## 8 — Keep it running in the background (optional)

Install a Termux session manager:

```bash
pkg install tmux -y
tmux new -s miner
node miner.js
# Press Ctrl+B then D to detach — miner keeps running
# Re-attach anytime with: tmux attach -t miner
```

Or use **Termux:Boot** (from F-Droid) to auto-start on phone reboot.

## Tips for mobile mining

| Setting | Suggestion |
|---|---|
| Threads | Start with `1` or `2` — phones have few cores and thermal limits |
| Batch size | `5000`–`10000` for phones (lower = less heat per tick) |
| Overclock | Keep at `1` on phones to avoid overheating |
| Charger | Always plug in — mining drains battery fast |
| Cooling | Avoid covering the phone while mining |

## Troubleshooting

| Problem | Fix |
|---|---|
| `node: not found` | Run `pkg install nodejs` again |
| `Cannot connect to RPC` | Check your internet connection; verify `rpcEndpoint` in config |
| Dashboard won't load | Make sure miner is still running in Termux; check the port is 5000 |
| Phone gets too hot | Reduce `threads` and `batchSize` via the dashboard |
