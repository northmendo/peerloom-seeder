#!/usr/bin/env bash
# Export assets/icon.svg to the PNG sizes the dashboard and stores use:
# assets/icon-<size>.png, and host/icon.png (64 px, the browser tab).
set -euo pipefail
cd "$(dirname "$0")/.."
for size in 64 256 512 1024; do
  inkscape assets/icon.svg --export-type=png --export-width="$size" --export-filename="assets/icon-$size.png" >/dev/null 2>&1
done
cp assets/icon-64.png host/icon.png
echo "exported assets/icon-{64,256,512,1024}.png and host/icon.png"
