#!/usr/bin/env bash
# Build the PeerLoom Seeder image, ghcr.io/peerloomllc/peerloom-seeder:<version>
# (version from package.json unless given), for amd64 and arm64. Stages each
# arch with scripts/stage.js into dist/umbrel/<arch>/ (no Node: the image has
# its own) and builds packaging/umbrel/Dockerfile on them. Needs podman, and
# qemu-user-static for the arm64 image.
#
#   PUSH=1        push the manifest list to ghcr (default: build only)
#   ARCHS=amd64   build one arch (default "amd64 arm64")
#
# Usage: scripts/build-umbrel-image.sh [version]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
IMAGE="${IMAGE:-ghcr.io/peerloomllc/peerloom-seeder}"
VERSION="${1:-$(node -p "require('./package.json').version")}"
TAG="$IMAGE:$VERSION"
PUSH="${PUSH:-0}"
ARCHS="${ARCHS:-amd64 arm64}"

rm -rf dist/umbrel
platforms=()
for a in $ARCHS; do
  case "$a" in amd64) t=linux-x64 ;; arm64) t=linux-arm64 ;; *) echo "unknown arch $a" >&2; exit 1 ;; esac
  node scripts/stage.js "$t" "dist/umbrel/$a"
  platforms+=("linux/$a")
done
# A plain image with this tag blocks --manifest as much as an old list does.
podman manifest rm "$TAG" 2>/dev/null || podman rmi "$TAG" 2>/dev/null || true
podman build --platform="$(IFS=,; echo "${platforms[*]}")" --manifest "$TAG" -f packaging/umbrel/Dockerfile dist/umbrel
if [ "$PUSH" = 1 ]; then
  podman manifest push --all "$TAG" "docker://$TAG"
  echo "pushed $TAG"
  skopeo inspect "docker://$TAG" --format '{{.Digest}}' 2>/dev/null || true
else
  echo "built $TAG (not pushed; PUSH=1 pushes)"
fi
