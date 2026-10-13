#!/bin/bash
# Installs a PeerLoom Seeder .deb update as root, through pkexec (from
# PearCircle's seeder). `peerloom-seeder update` downloads the .deb and checks
# its .sha256; this checks the file again before `dpkg -i`, so the polkit rule
# (one user, this one root-owned script) cannot be used to install anything
# else.
#
# Usage: pkexec /opt/peerloom-seeder/updater-helper.sh <deb> <sha256> <user> <version>
set -euo pipefail
DEB="${1:-}"
WANT_SHA="${2:-}"
TARGET_USER="${3:-}"
VERSION="${4:-}"
log () { echo "[peerloom-seeder updater] $*"; }
if [ -z "$TARGET_USER" ] && [ -n "${PKEXEC_UID:-}" ]; then TARGET_USER="$(getent passwd "$PKEXEC_UID" | cut -d: -f1)"; fi
[ -n "$DEB" ] && [ -f "$DEB" ] || { log "no .deb at '$DEB'; nothing changed"; exit 1; }
GOT_SHA="$(sha256sum "$DEB" | awk '{print $1}')"
if [ -z "$WANT_SHA" ] || [ "$GOT_SHA" != "$WANT_SHA" ]; then log "checksum does not match; nothing changed"; exit 1; fi
[ "$(dpkg-deb -f "$DEB" Package)" = peerloom-seeder ] || { log "that is not a peerloom-seeder package; nothing changed"; exit 1; }
dpkg -i "$DEB" || { log "dpkg could not install $VERSION"; exit 1; }
# Last: restarting ends the service this was started from.
if [ -n "$TARGET_USER" ] && [ "$TARGET_USER" != root ]; then
  TARGET_UID="$(id -u "$TARGET_USER" 2>/dev/null || true)"
  [ -n "$TARGET_UID" ] && runuser -u "$TARGET_USER" -- env "XDG_RUNTIME_DIR=/run/user/$TARGET_UID" systemctl --user restart --no-block peerloom-seeder.service 2>/dev/null || true
fi
log "installed $VERSION"
