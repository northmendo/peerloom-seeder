#!/bin/bash
# Remove PeerLoom Seeder from this Mac (run as root).
#   uninstall.sh --keep    keep the data folder (default): reinstalling later
#                          brings back the same seeder, devices and backups
#   uninstall.sh --purge   delete the data folder too
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
LABEL=com.peerloomllc.seeder
PLIST="/Library/LaunchDaemons/$LABEL.plist"
USER_NAME=$(/usr/libexec/PlistBuddy -c 'Print :UserName' "$PLIST" 2>/dev/null || true)
DATA_DIR=$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:SEEDER_DATA' "$PLIST" 2>/dev/null || true)
for l in $LABEL $LABEL.updater; do
  launchctl bootout "system/$l" 2>/dev/null || true
  rm -f "/Library/LaunchDaemons/$l.plist"
done
rm -rf /usr/local/lib/peerloom-seeder "/Applications/PeerLoom Seeder.app" "/Applications/Uninstall PeerLoom Seeder.app" "/Library/Application Support/PeerLoom Seeder"
pkgutil --forget com.peerloomllc.seeder >/dev/null 2>&1 || true
if [ "${1:-}" = --purge ] && [ -n "$DATA_DIR" ] && [ -d "$DATA_DIR" ]; then
  rm -rf "$DATA_DIR"
  echo "removed PeerLoom Seeder and its data"
else
  echo "removed PeerLoom Seeder; its data is still in ${DATA_DIR:-~/Library/Application Support/PeerLoom Seeder}"
fi
