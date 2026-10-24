#!/usr/bin/env bash

# Copyright (c) 2021-2026 community-scripts ORG
# Author: PeerLoom LLC
# License: MIT | https://github.com/northmendo/peerloom-seeder/raw/main/LICENSE
# Source: https://github.com/northmendo/peerloom-seeder

# PeerLoom Seeder LXC — creates a Debian 12 container and installs the
# seeder (Node dashboard host + Bare seeder process) from the northmendo
# fork, with the hardened systemd service from packaging/debian/. The
# runbook the install follows is docs/DEBIAN-LXC.md.
#
# Run on the Proxmox VE host (not inside a container):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/northmendo/peerloom-seeder/main/packaging/proxmox/peerloom-seeder.sh)"
#
# Every prompt has an escape hatch for unattended runs (community-scripts
# convention): export the variable and no menu is shown.
#   CT_ID=110 DISK_SIZE=8 BIND_ADDR=0.0.0.0 LIMIT_GB=25 PORT=8761 STORAGE=local \
#     bash packaging/proxmox/peerloom-seeder.sh
#
# A matching JSON metadata file (peerloom-seeder.json) sits next to this
# script, in the format the community-scripts repos keep in json/.

set -Eeuo pipefail

APP="PeerLoom Seeder"
DEFAULT_DISK=8          # GB for the container's rootfs
DEFAULT_LIMIT=25        # GB stored per paired device (the seeder's own default)
DEFAULT_PORT=8761       # dashboard port
DEFAULT_BIND=0.0.0.0    # dashboard bind: every interface (a password is required)
NODE_MAJOR=22           # package.json engines: node >= 20; NodeSource LTS
REPO="https://github.com/northmendo/peerloom-seeder"
STORAGE=${STORAGE:-local}

# --- helpers (catch_errors / verb_chk style, as in the community scripts) ----

function_header_variables() {
  # The banner and the shared colors; the interactive settings next, then
  # catch_errors arms set -Eeuo pipefail with the trap.
  RD=$(printf '\033[01;31m'); GN=$(printf '\033[01;32m'); YW=$(printf '\033[33m')
  BL=$(printf '\033[36m'); BGN=$(printf '\033[1;92m'); CL=$(printf '\033[m')
  BACKTITLE="PeerLoom Seeder (community-scripts style)"
  header_info
}

header_info() {
  clear 2>/dev/null || true  # a headless shell (no TERM) just skips the clear
  printf '%s\n' "${YW}  ____                  _                 ${CL}"
  printf '%s\n' "${YW} |  _ \\ __ ___   ____ _(_)_ __   __ _ _   _ ${CL}"
  printf '%s\n' "${YW} | |_) / _\` \\ \\ / / _\` | | '_ \\ / _\` | | | |${CL}"
  printf '%s\n' "${YW} |  __/ (_| |\\ V / (_| | | | | | (_| | |_| |${CL}"
  printf '%s\n' "${YW} |_|   \\__,_| \\_/ \\__,_|_| |_| |_|\\__, |\\__, |${CL}"
  printf '%s\n' "${YW}  S e e d e r   ( L X C )         |___/ |___/ ${CL}"
  printf '\n%s\n' "  A blind seeder for PeerLoom apps: stores encrypted data it"
  printf '%s\n' "  cannot read, serves it while your phones sleep."
  printf '%s\n\n' "  Runbook: ${REPO}/blob/main/docs/DEBIAN-LXC.md"
}

catch_errors() {
  set -Eeuo pipefail
  trap 'error_handler $LINENO "$BASH_COMMAND"' ERR
}

error_handler() {
  local exit_code=$? line=$1 command=$2
  printf '%s\n' "${RD}[ERROR]${CL} line ${line}: \`${command}\` exited ${exit_code}" >&2
  exit "$exit_code"
}

die() { printf '%s %s\n' "${RD}[ERROR]${CL}" "$*" >&2; exit 1; }

msg_info() { printf '%s\n' "${BL}[INFO]${CL} $*"; }
msg_ok()   { printf '%s\n' "${GN}[OK]${CL} $*"; }

# verb_chk MESSAGE COMMAND... — the classic "do a step, say so" helper:
# prints MESSAGE, runs COMMAND quietly, dies loudly if it fails.
verb_chk() {
  local message=$1
  shift
  msg_info "${message}"
  if ! "$@" >/dev/null 2>&1; then
    die "${message}: failed"
  fi
  msg_ok "${message}"
}

# whiptail input with a default. A Cancel exits 1 quietly (the || makes the
# failed command substitution exempt from set -e, so no error-handler noise).
wt_input() {
  local value
  value=$(whiptail --backtitle "$BACKTITLE" --title "$1" --inputbox "$2" 10 70 "$3" 3>&1 1>&2 2>&3) || exit 1
  printf '%s' "$value"
}

# --- the settings menus ------------------------------------------------------

settings() {
  if ! command -v whiptail >/dev/null 2>&1; then
    die "whiptail is required (it ships with Proxmox VE)"
  fi
  # An exported variable means an unattended run: no menu for that setting.
  local preset=0
  if [[ -n "${CT_ID:-}" || -n "${DISK_SIZE:-}" || -n "${BIND_ADDR:-}" || -n "${LIMIT_GB:-}" || -n "${PORT:-}" ]]; then
    preset=1
  fi
  CT_ID=${CT_ID:-$(wt_input "$APP - CT ID" "Container ID to create" "$(pvesh get /cluster/nextid)")}
  if [[ ! "$CT_ID" =~ ^[0-9]+$ ]]; then die "CT ID must be a number"; fi
  if pct status "$CT_ID" >/dev/null 2>&1; then die "CT $CT_ID already exists"; fi

  DISK_SIZE=${DISK_SIZE:-$(wt_input "$APP - disk" "Rootfs disk size (GB)" "$DEFAULT_DISK")}
  if [[ ! "$DISK_SIZE" =~ ^[0-9]+$ ]] || (( DISK_SIZE < 2 )); then
    die "Disk size must be a whole number of GB (at least 2)"
  fi

  BIND_ADDR=${BIND_ADDR:-$(wt_input "$APP - bind" "Dashboard bind address.
0.0.0.0   = reachable from your LAN (a password is required and generated)
127.0.0.1 = reachable inside the container only" "$DEFAULT_BIND")}
  if [[ ! "$BIND_ADDR" =~ ^(0\.0\.0\.0|127\.0\.0\.1|localhost|::1|[0-9]{1,3}(\.[0-9]{1,3}){3})$ ]]; then
    die "Bind address must be 0.0.0.0, 127.0.0.1, localhost, ::1 or an IPv4 address"
  fi

  LIMIT_GB=${LIMIT_GB:-$(wt_input "$APP - storage limit" "Storage limit per device (GB; the seeder's default is $DEFAULT_LIMIT)" "$DEFAULT_LIMIT")}
  if [[ ! "$LIMIT_GB" =~ ^[0-9]+$ ]] || (( LIMIT_GB < 1 )); then
    die "Storage limit must be a whole number of GB"
  fi

  PORT=${PORT:-$(wt_input "$APP - port" "Dashboard port" "$DEFAULT_PORT")}
  if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
    die "Port must be a whole number from 1 to 65535"
  fi

  # Ask for a final yes only when the menus were shown (an exported set of
  # variables means an unattended run).
  if (( preset == 0 )); then
    if ! whiptail --backtitle "$BACKTITLE" --title "$APP - ready?" --yesno \
      "Create ${APP} as CT ${CT_ID}?
  disk:      ${DISK_SIZE} GB
  bind:      ${BIND_ADDR}
  port:      ${PORT}
  limit:     ${LIMIT_GB} GB per device
  OS:        Debian 12 (unprivileged, DHCP on vmbr0)" 14 72; then
      exit 1
    fi
  fi
  catch_errors
}

# --- the container ----------------------------------------------------------

build_container() {
  msg_info "Looking for the Debian 12 template (storage ${STORAGE})"
  TEMPLATE=$(pveam available 2>/dev/null | awk '{print $NF}' | grep '^debian-12-standard' | sort -V | tail -1)
  if [[ -z "$TEMPLATE" ]]; then
    die "no debian-12-standard template found by pveam (run: pveam available)"
  fi
  if ! pveam list "$STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
    verb_chk "Downloading ${TEMPLATE}" pveam download "$STORAGE" "$TEMPLATE"
  else
    msg_ok "Template ${TEMPLATE} is already on ${STORAGE}"
  fi

  # 256 random bytes filtered to alphanumerics, then cut to 20: a fixed-size
  # read upstream of tr, or `tr | head -c` dies on SIGPIPE under pipefail.
  CT_PASSWORD=$(head -c 256 /dev/urandom | tr -dc 'A-Za-z0-9')
  CT_PASSWORD=${CT_PASSWORD:0:20}
  msg_info "Creating CT ${CT_ID} (unprivileged, DHCP on vmbr0)"
  verb_chk "Creating CT ${CT_ID}" pct create "$CT_ID" "${STORAGE}:vztmpl/${TEMPLATE}" \
    --hostname peerloom-seeder \
    --unprivileged 1 \
    --cores 1 --memory 1024 --swap 512 \
    --rootfs "${STORAGE}:${DISK_SIZE}" \
    --net0 "name=eth0,bridge=vmbr0,ip=dhcp,firewall=1" \
    --password "$CT_PASSWORD" \
    --onboot 1 \
    --start 1
  msg_ok "Created CT ${CT_ID}"
}

# --- the whole run ----------------------------------------------------------

function_header_variables
command -v pct >/dev/null 2>&1 || die "this runs on a Proxmox VE host (pct not found)"
command -v pveam >/dev/null 2>&1 || die "this runs on a Proxmox VE host (pveam not found)"

settings
build_container

# The install runs INSIDE the container, as root. The heredoc is quoted, so
# nothing expands on the host: the container's bash reads APP_BIND, APP_PORT
# and NODE_MAJOR from the env lxc-attach carries.
msg_info "Installing ${APP} in CT ${CT_ID}"
lxc-attach "$CT_ID" -- env APP_BIND="$BIND_ADDR" APP_PORT="$PORT" NODE_MAJOR="$NODE_MAJOR" bash -s <<'INSTALL'
set -Eeuo pipefail
trap 'printf "[ERROR] line %s: \`%s\` exited %s\n" "$LINENO" "$BASH_COMMAND" "$?" >&2' ERR

msg_info() { printf '[INFO] %s\n' "$*"; }
msg_ok()   { printf '[OK] %s\n' "$*"; }
verb_chk() {
  local message=$1
  shift
  msg_info "${message}"
  if ! "$@" >/dev/null 2>&1; then
    printf '[ERROR] %s: failed\n' "${message}" >&2
    exit 1
  fi
  msg_ok "${message}"
}

export DEBIAN_FRONTEND=noninteractive
verb_chk "Updating Debian" apt-get update
verb_chk "Upgrading Debian" apt-get -y dist-upgrade
verb_chk "Installing curl, git, gnupg" apt-get install -y curl git ca-certificates gnupg

# Node LTS from NodeSource (the seeder's package.json: engines node >= 20)
install -d -m 0755 /etc/apt/keyrings
curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
verb_chk "Installing Node.js" apt-get update
verb_chk "Installing Node.js" apt-get install -y nodejs
msg_ok "Node $(node --version)"

verb_chk "Cloning the seeder" git clone --depth 1 https://github.com/northmendo/peerloom-seeder /opt/peerloom-seeder
cd /opt/peerloom-seeder
msg_info "Installing npm dependencies (this takes a few minutes)"
if ! npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1; then
  printf '[ERROR] npm install: failed\n' >&2
  exit 1
fi
msg_ok "npm dependencies installed"
verb_chk "Building the Bare seeder bundle" npm run build

# The service's environment file — the bind config of docs/DEBIAN-LXC.md.
# 0.0.0.0 is only safe because the dashboard host refuses a non-loopback
# bind without a password; one is minted on first start and saved at
# $SEEDER_DATA/dashboard-password (0600).
cat >/etc/peerloom-seeder.env <<EOF
# Created by the PeerLoom Seeder LXC script. See docs/DEBIAN-LXC.md.
SEEDER_DATA=/var/lib/peerloom-seeder
SEEDER_HOST=${APP_BIND}
SEEDER_PORT=${APP_PORT}
SEEDER_NO_UPDATE_CHECK=1
EOF
chmod 600 /etc/peerloom-seeder.env

# The hardened system unit, mirroring packaging/debian/peerloom-seeder.service.
cat >/etc/systemd/system/peerloom-seeder.service <<'EOF'
[Unit]
Description=PeerLoom Seeder (blind seeder + dashboard)
Documentation=https://github.com/northmendo/peerloom-seeder/blob/main/docs/DEBIAN-LXC.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/peerloom-seeder
EnvironmentFile=/etc/peerloom-seeder.env
ExecStart=/usr/bin/node host/server.js
Restart=on-failure
RestartSec=5
DynamicUser=yes
StateDirectory=peerloom-seeder
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectClock=yes
ProtectControlGroups=yes
ProtectHostname=yes
ProtectKernelLogs=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
EOF

verb_chk "Enabling the service" systemctl daemon-reload
verb_chk "Starting the service" systemctl enable --now peerloom-seeder
msg_ok "Service installed"
INSTALL

# Wait for the dashboard to answer (it answers 401 without a session — that
# is the design: a 0.0.0.0 dashboard is never unauthenticated).
msg_info "Waiting for the dashboard to come up"
WAITED=0
until pct exec "$CT_ID" -- curl -s -o /dev/null "http://127.0.0.1:${PORT}/api/status"; do
  WAITED=$((WAITED + 1))
  if (( WAITED > 45 )); then
    die "the dashboard did not come up (see: pct exec $CT_ID -- journalctl -u peerloom-seeder)"
  fi
  sleep 2
done
msg_ok "Dashboard answers on port ${PORT} (401 without a session, as it should)"

# Apply the per-device storage limit through the dashboard's own API, with
# the password the first start minted (root in the container can read it;
# its alphabet is z32, so it is safe inside a JSON string).
DASH_PASSWORD=$(pct exec "$CT_ID" -- cat /var/lib/peerloom-seeder/dashboard-password | tr -d '\n')
pct exec "$CT_ID" -- bash -s <<EOF
set -e
curl -s -c /root/.peerloom-jar -H 'content-type: application/json' \
  -d '{"password":"${DASH_PASSWORD}"}' http://127.0.0.1:${PORT}/api/login >/dev/null
curl -s -b /root/.peerloom-jar -H 'content-type: application/json' \
  -d '{"bytes":${LIMIT_GB}000000000}' http://127.0.0.1:${PORT}/api/limit >/dev/null
rm -f /root/.peerloom-jar
EOF
msg_ok "Storage limit set to ${LIMIT_GB} GB per device"

CT_IP=$(pct exec "$CT_ID" -- hostname -I | awk '{print $1}')

msg_ok "Completed successfully"
printf '\n%s\n' "${BGN}${APP} is running in CT ${CT_ID}.${CL}"
printf '  %-12s %s\n' "Dashboard:" "${BGN}http://${CT_IP}:${PORT}${CL}"
printf '  %-12s %s\n' "Password:" "${DASH_PASSWORD}"
printf '  %-12s %s\n' "" "(also in the CT at /var/lib/peerloom-seeder/dashboard-password)"
printf '  %-12s %s\n' "CT root:" "${CT_PASSWORD} (pct enter ${CT_ID})"
printf '\n%s\n' "The P2P swarm listens on every interface on a random UDP port — that is"
printf '%s\n' "how peers reach it; only the dashboard needs its port reachable."
printf '%s\n\n' "Runbook: ${REPO}/blob/main/docs/DEBIAN-LXC.md"
