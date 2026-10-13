#!/bin/bash
# PeerLoom Seeder's privileged updater (runs as root). The
# com.peerloomllc.seeder.updater LaunchDaemon starts it when a request lands in
# the requests folder, which only the seeder's user can write. The seeder
# (host/updates.js through @peerloom/host's update-apply) has downloaded a
# .pkg and checked it against the release's .sha256. This checks it again
# before installing:
#   1. the file's sha256 matches the request
#   2. it is signed by PeerLoom's Developer ID Installer team
#   3. Gatekeeper accepts it (notarized)
#   4. it is newer than the installed version (no downgrades)
# Adapted from PearCircle's seeder launcher.
set -euo pipefail
REQ_DIR="/Library/Application Support/PeerLoom Seeder/updates/requests"
REQ="$REQ_DIR/apply.json"
TEAM_ID="G79ALD29NA"
log () { echo "$(date -u +%FT%TZ) [updater] $*"; }

# WatchPaths also fires when the request is removed.
[ -f "$REQ" ] || exit 0
field () { /usr/bin/plutil -extract "$1" raw -o - "$REQ" 2>/dev/null || true; }
PKG="$(field pkgPath)"
WANT="$(field sha256)"
work="$(mktemp -d)"
# The request goes whatever happens, so a bad one cannot loop.
trap 'rm -f "$REQ"; rm -rf "$work"' EXIT

if [ -z "$PKG" ] || [ ! -f "$PKG" ]; then log "no package at '$PKG'"; exit 0; fi
# Work on a root-owned copy, so the file cannot change between the checks and
# the install.
cp "$PKG" "$work/update.pkg"
PKG="$work/update.pkg"
GOT="$(/usr/bin/shasum -a 256 "$PKG" | awk '{print $1}')"
if [ -z "$WANT" ] || [ "$GOT" != "$WANT" ]; then log "checksum does not match; refused"; exit 1; fi
if ! /usr/sbin/pkgutil --check-signature "$PKG" 2>&1 | grep -q "Developer ID Installer: .*($TEAM_ID)"; then log "not signed by $TEAM_ID; refused"; exit 1; fi
if ! /usr/sbin/spctl -a -vvv -t install "$PKG" 2>&1 | grep -q accepted; then log "not notarized; refused"; exit 1; fi
/usr/sbin/pkgutil --expand "$PKG" "$work/x" >/dev/null
NEW="$(sed -n 's/.*pkg-ref id="com.peerloomllc.seeder" version="\([0-9][0-9.]*\)".*/\1/p' "$work/x/Distribution" | head -n 1)"
OLD="$(cat /usr/local/lib/peerloom-seeder/VERSION 2>/dev/null || echo 0.0.0)"
if [ -z "$NEW" ] || [ "$NEW" = "$OLD" ] || [ "$(printf '%s\n%s\n' "$NEW" "$OLD" | sort -V | tail -n 1)" != "$NEW" ]; then
  log "package is $NEW, installed is $OLD; refused"; exit 1
fi
log "installing $NEW over $OLD"
if /usr/sbin/installer -pkg "$PKG" -target / >/dev/null 2>&1; then
  log "installed $NEW"
  rm -f "$(field pkgPath)" 2>/dev/null || true
else
  log "installer failed for $NEW"; exit 1
fi
