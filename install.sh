#!/usr/bin/env bash
#
# GYDS Miner Installer
#
# Usage:
#   sudo bash install.sh
#

set -euo pipefail

INSTALL_DIR="/opt/gyds-miner"
SERVICE_NAME="gyds-miner"
NODE_MAJOR=20
RUN_USER="${SUDO_USER:-$(whoami)}"

if [ "$(id -u)" -ne 0 ]; then
    echo "Please run with sudo."
    exit 1
fi

echo "======================================"
echo "      GYDS Miner Installer"
echo "======================================"

########################################
# Install Node.js
########################################

NEED_NODE=0

if ! command -v node >/dev/null 2>&1; then
    NEED_NODE=1
else
    CURRENT_MAJOR=$(node -p "process.versions.node.split('.')[0]")
    if [ "$CURRENT_MAJOR" -lt "$NODE_MAJOR" ]; then
        NEED_NODE=1
    fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
    echo "Installing Node.js ${NODE_MAJOR}..."

    apt-get update
    apt-get install -y curl ca-certificates gnupg build-essential rsync

    mkdir -p /etc/apt/keyrings

    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor \
        -o /etc/apt/keyrings/nodesource.gpg

    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list

    apt-get update
    apt-get install -y nodejs
else
    echo "Node.js $(node -v) already installed."
fi

########################################
# Copy files
########################################

echo "Installing miner..."

mkdir -p "$INSTALL_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rsync -a \
    --exclude=node_modules \
    --exclude=.git \
    --exclude=install.sh \
    "$SCRIPT_DIR"/ "$INSTALL_DIR"/

cd "$INSTALL_DIR"

########################################
# Create config
########################################

if [ ! -f config.json ]; then
    cp config.example.json config.json
fi

########################################
# Reset npm configuration
########################################

echo "Resetting npm configuration..."

rm -f /root/.npmrc

if [ -n "${SUDO_USER:-}" ]; then
    rm -f "/home/${SUDO_USER}/.npmrc" || true
fi

npm config delete registry || true
npm config delete proxy || true
npm config delete https-proxy || true

npm config set registry https://registry.npmjs.org/

npm cache clean --force

########################################
# Remove Replit artifacts
########################################

echo "Removing old dependencies..."

rm -rf node_modules
rm -f package-lock.json

########################################
# Install packages
########################################

echo "Installing npm packages..."

npm install --omit=dev --no-audit --no-fund

########################################
# Permissions
########################################

chown -R "$RUN_USER:$RUN_USER" "$INSTALL_DIR"

########################################
# Systemd service
########################################

cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=GYDS Miner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(command -v node) ${INSTALL_DIR}/miner.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl restart ${SERVICE_NAME}

sleep 3

if systemctl is-active --quiet ${SERVICE_NAME}; then
    echo "Service started successfully."
else
    echo "Service failed to start."
    journalctl -u ${SERVICE_NAME} --no-pager -n 50
    exit 1
fi

########################################
# Firewall
########################################

WEB_PORT=$(node -e "try{console.log(require('./config.json').webPort||4500)}catch(e){console.log(4500)}")

if command -v ufw >/dev/null 2>&1; then
    ufw allow OpenSSH >/dev/null 2>&1 || true
    ufw allow ${WEB_PORT}/tcp >/dev/null 2>&1 || true
fi

IP_ADDR=$(ip route get 1.1.1.1 | awk '{print $7;exit}')

echo
echo "======================================"
echo "Installation Complete"
echo "======================================"
echo "Dashboard : http://${IP_ADDR}:${WEB_PORT}"
echo "Config    : ${INSTALL_DIR}/config.json"
echo "Logs      : journalctl -u ${SERVICE_NAME} -f"
echo "Restart   : systemctl restart ${SERVICE_NAME}"
echo "======================================"
