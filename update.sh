#!/bin/bash
# update.sh — pull the latest changes from GitHub and restart the miner

set -e

REPO_URL="https://github.com/hc172808/miner"
BRANCH="main"

echo ""
echo "========================================"
echo "  GYDS Miner — Update Script"
echo "========================================"
echo ""

# ── Check we're inside a git repo ────────────────────────────────────────────
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  echo "❌  Not a git repository. Exiting."
  exit 1
fi

# ── Show current version ──────────────────────────────────────────────────────
BEFORE=$(git rev-parse --short HEAD)
echo "📌  Current commit : $BEFORE"
echo "🌐  Remote         : $REPO_URL"
echo "🌿  Branch         : $BRANCH"
echo ""

# ── Fetch & pull ──────────────────────────────────────────────────────────────
echo "⬇️   Fetching updates from origin…"
git fetch origin "$BRANCH"

AFTER=$(git rev-parse --short "origin/$BRANCH")

if [ "$BEFORE" = "$AFTER" ]; then
  echo ""
  echo "✅  Already up to date. Nothing to do."
  echo ""
  exit 0
fi

echo ""
echo "🔄  Applying updates ($BEFORE → $AFTER)…"
git pull origin "$BRANCH"

# ── Show what changed ─────────────────────────────────────────────────────────
echo ""
echo "📋  Changes applied:"
git log --oneline "$BEFORE..HEAD"

# ── Install / update dependencies if package.json changed ────────────────────
if git diff --name-only "$BEFORE" HEAD | grep -q "package.json"; then
  echo ""
  echo "📦  package.json changed — running npm install…"
  npm install
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  ✅  Update complete!"
echo "  Restart the miner for changes to take effect."
echo "  Run:  node miner.js"
echo "========================================"
echo ""
