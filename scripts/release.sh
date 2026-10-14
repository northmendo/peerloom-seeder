#!/usr/bin/env bash
# PeerLoom Seeder release (app-specific config in scripts/app.conf)
# Usage: ./scripts/release.sh [vX.Y.Z] [--retag] [--check-versions] [--skip-...]
#
# The non-phone profile of /home/tim/peerloomllc/RELEASE-PIPELINE.md: same
# step numbers and gate wording, and the phone steps (2, 3, 4, 4e, 8-11) are
# absent. Modelled on PearOffice's scripts/release.sh, which also tags its
# private source repo and publishes on a public releases repo.
#
# One run builds every package: Linux tarballs, .deb and AppImage (x64 and
# arm64), macOS .pkg (Apple silicon and Intel, signed and notarized on the
# Mac Mini), the Windows installer, the Umbrel image (amd64 and arm64) and
# the StartOS .s9pk. The downloads go on the public RELEASES_REPO, where the
# installed seeders look for updates; the tag goes on this repo.
#
# Flags:
#   vX.Y.Z             Override the auto-detected version (default: next patch)
#   --retag            Delete and recreate a stranded local tag from a failed run
#   --check-versions   Print what each channel has published and exit
#   --skip-github      Skip the GitHub release
#   --skip-linux       Skip the Linux downloads (tarballs, .deb, AppImage)
#   --skip-macos       Skip the macOS packages
#   --skip-windows     Skip the Windows installer
#   --skip-desktop     Skip macOS, Windows and Linux
#   --skip-umbrel      Skip the Umbrel image and store updates
#   --skip-start9      Skip the StartOS package and registry
#   --skip-seeder-store  Both of the above
#   --skip-nostr       Skip the Nostr announcement
#
# Optional env (scripts/.env): GITHUB_TOKEN, GITHUB_REMOTE, SIGN_WITH (nsec for
# the Nostr note), APP_SIGN_ID / PKG_SIGN_ID / NOTARY_PROFILE (macOS signing,
# see scripts/dist-macos.js).
#
# Needs: gh, podman and skopeo (logged in to ghcr), start-cli-1.1.0, makensis,
# the Mac Mini, and clones of ../website, ../peerloom-umbrel-app-store and
# ../umbrel-apps (PeerLoom's fork) beside this repo.

set -euo pipefail
trap 'echo; echo "Interrupted (SIGINT) - aborting release."; exit 130' INT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PEERLOOM="$(dirname "$REPO_ROOT")"

RELEASE_LIB="$REPO_ROOT/../peerloom-release/release-lib.sh"
if [ ! -f "$RELEASE_LIB" ]; then
  echo "error: $RELEASE_LIB not found - clone peerloomllc/peerloom-release beside this repo" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$RELEASE_LIB"

# A1: config, then secrets.
if [ -f "$SCRIPT_DIR/app.conf" ]; then set -a; source "$SCRIPT_DIR/app.conf"; set +a; fi
if [ -f "$SCRIPT_DIR/.env" ]; then set -a; source "$SCRIPT_DIR/.env"; set +a; fi
for _k in APP_NAME APP_ID RELEASES_REPO UMBREL_IMAGE; do
  if [ -z "${!_k:-}" ]; then echo "error: $_k is not set - check $SCRIPT_DIR/app.conf" >&2; exit 1; fi
done

# The highest X.Y.Z tag of the image on ghcr (anonymous pull token). "" when unknown.
_umbrel_latest_version() {
  local host="${UMBREL_IMAGE%%/*}" repo="${UMBREL_IMAGE#*/}" token
  token=$(curl -s --max-time 8 "https://${host}/token?scope=repository:${repo}:pull" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
  [ -z "$token" ] && return 0
  curl -s --max-time 8 -H "Authorization: Bearer $token" "https://${host}/v2/${repo}/tags/list" 2>/dev/null \
    | python3 -c "
import sys, json
best = ()
for t in json.load(sys.stdin).get('tags', []) or []:
    p = tuple(int(x) for x in t.lstrip('v').split('.') if x.isdigit())
    if len(p) == 3 and p > best: best = p
print('.'.join(map(str, best)) if best else '')
" 2>/dev/null || echo ""
}

# A fresh checkout of <repo>'s <remote>/<base> on <branch>, removed on exit.
WORKTREES=()
_worktree_cleanup() {
  local w
  for w in "${WORKTREES[@]:-}"; do
    [ -n "$w" ] && { git -C "${w%%|*}" worktree remove --force "${w#*|}" 2>/dev/null || true; }
  done
  WORKTREES=()
  return 0
}
_kill_tree() {
  local _c
  for _c in $(pgrep -P "$1" 2>/dev/null); do _kill_tree "$_c"; done
  kill "$1" 2>/dev/null || true
}
_on_exit() {
  _worktree_cleanup
  if [ -n "${_MAC_PID:-}" ] && kill -0 "$_MAC_PID" 2>/dev/null; then _kill_tree "$_MAC_PID"; fi
  return 0
}
trap _on_exit EXIT
_worktree() {
  local repo="$1" remote="$2" base="$3" branch="$4"
  WT="$(mktemp -d)/wt"
  git -C "$repo" fetch -q "$remote"
  git -C "$repo" worktree add -q -B "$branch" "$WT" "$remote/$base"
  WORKTREES+=("$repo|$WT")
}

# Version, release notes and image digest in an Umbrel app folder.
# Usage: _umbrel_bump <app-dir> <version> <digest> <notes>
_umbrel_bump() {
  node - "$@" <<'EOF'
const fs = require('fs')
const [dir, v, digest, notes] = process.argv.slice(2)
let app = fs.readFileSync(dir + '/umbrel-app.yml', 'utf8')
app = app.replace(/^version: .*$/m, `version: "${v}"`)
app = app.replace(/^releaseNotes: [\s\S]*?(?=^\S)/m, 'releaseNotes: >-\n' + notes.split('\n').map((l) => (l ? '  ' + l : '')).join('\n') + '\n')
fs.writeFileSync(dir + '/umbrel-app.yml', app)
let compose = fs.readFileSync(dir + '/docker-compose.yml', 'utf8')
compose = compose.replace(/peerloom-seeder:[\w.]+@sha256:[0-9a-f]+/, `peerloom-seeder:${v}@${digest}`)
fs.writeFileSync(dir + '/docker-compose.yml', compose)
EOF
}

_ask() { # _ask <question> <default y|n> -> 0 for yes
  local _r
  while true; do
    read -rp "    $1 $([ "$2" = y ] && echo '[Y/n]' || echo '[y/N]') " _r || { echo; echo "Aborted."; exit 0; }
    _r="${_r:-$2}"
    case "$_r" in [Yy]) return 0 ;; [Nn]) return 1 ;; *) echo "    Please enter y or n." ;; esac
  done
}

# A2: arguments.
RELEASE_TAG=""
RETAG=false
CHECK_VERSIONS_ONLY=false
SKIP_GITHUB=false
SKIP_NOSTR=false
SKIP_LINUX=false
SKIP_MACOS=false
SKIP_WINDOWS=false
SKIP_UMBREL=false
SKIP_START9=false
for arg in "$@"; do
  case "$arg" in
    --retag) RETAG=true ;;
    --check-versions) CHECK_VERSIONS_ONLY=true ;;
    --skip-github) SKIP_GITHUB=true ;;
    --skip-nostr) SKIP_NOSTR=true ;;
    --skip-linux) SKIP_LINUX=true ;;
    --skip-macos) SKIP_MACOS=true ;;
    --skip-windows) SKIP_WINDOWS=true ;;
    --skip-desktop) SKIP_LINUX=true; SKIP_MACOS=true; SKIP_WINDOWS=true ;;
    --skip-umbrel) SKIP_UMBREL=true ;;
    --skip-start9) SKIP_START9=true ;;
    --skip-seeder-store) SKIP_UMBREL=true; SKIP_START9=true ;;
    v[0-9]*.[0-9]*.[0-9]*)
      if [[ ! "$arg" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "Error: tag must be vX.Y.Z (got: $arg)"; exit 1; fi
      RELEASE_TAG="$arg"
      ;;
    -h|--help) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $arg (see --help)"; exit 1 ;;
  esac
done

if ! $CHECK_VERSIONS_ONLY; then release_lib_require_current; fi
cd "$REPO_ROOT"

# A3: the tag, from local git tags only.
if [ -z "$RELEASE_TAG" ]; then
  LATEST=$(git tag --sort=-version:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || echo "")
  if [ -z "$LATEST" ]; then
    # No tag yet: the first release is package.json's version as it stands.
    RELEASE_TAG="v$(node -p "require('./package.json').version")"
    echo "==> No prior tags found; first release is $RELEASE_TAG (package.json)"
  else
    IFS='.' read -r MAJOR MINOR PATCH <<< "${LATEST#v}"
    RELEASE_TAG="v${MAJOR}.${MINOR}.$((PATCH + 1))"
    echo "==> Auto-detected next version: $RELEASE_TAG  (latest tag was $LATEST)"
  fi
fi
APP_VERSION="${RELEASE_TAG#v}"

# A4: --retag.
if $RETAG; then
  if git tag | grep -q "^${RELEASE_TAG}$"; then
    echo "==> --retag: deleting stranded local tag $RELEASE_TAG..."
    git tag -d "$RELEASE_TAG"
  else
    echo "==> --retag: local tag $RELEASE_TAG not found, nothing to clean up."
  fi
fi

if ! $CHECK_VERSIONS_ONLY; then
  _confirm "Release tag will be $RELEASE_TAG — proceed with build?"
fi

# A5: credentials. Nothing is required: Nostr is skipped without SIGN_WITH.
GH_TOKEN=$(_github_token)
REPO_SLUG=$(_remote_slug)

# A6: what each channel has published.
echo "==> Checking published versions..."
GH_VERSION=$(_github_latest_version "$GH_TOKEN" "$RELEASES_REPO")
UMBREL_VERSION_CURRENT=$(_umbrel_latest_version)
echo "    GitHub       : ${GH_VERSION:-unknown} ($RELEASES_REPO)"
echo "    Umbrel image : ${UMBREL_VERSION_CURRENT:-unknown} ($UMBREL_IMAGE)"
if $CHECK_VERSIONS_ONLY; then exit 0; fi
if [ -n "$GH_VERSION" ] && [ "$(_ver_cmp "$GH_VERSION" "$APP_VERSION")" = gt ]; then
  echo "Error: GitHub already has $GH_VERSION, newer than $APP_VERSION."
  exit 1
fi

# A7: destinations.
PUBLISH_GITHUB=true
PUBLISH_NOSTR=true
$SKIP_GITHUB && PUBLISH_GITHUB=false
$SKIP_NOSTR && PUBLISH_NOSTR=false
[ -z "${SIGN_WITH:-}" ] && PUBLISH_NOSTR=false
echo "==> Select publish destinations for $RELEASE_TAG:"
if $PUBLISH_GITHUB && ! _ask "GitHub release on $RELEASES_REPO?" y; then PUBLISH_GITHUB=false; fi
if ! $SKIP_UMBREL && ! _ask "Umbrel image and store updates?" y; then SKIP_UMBREL=true; fi
if ! $SKIP_START9 && ! _ask "StartOS package and registry?" y; then SKIP_START9=true; fi
if $PUBLISH_NOSTR && ! _ask "Nostr announcement?" y; then PUBLISH_NOSTR=false; fi

PUBLISH_FAILED=false
ARTIFACTS=()
_MAC_PID=""
START9_S9PK=""
UMBREL_BUILT=false

# Step 0: the version everywhere it is written.
echo "==> Updating the version to $APP_VERSION..."
node scripts/release/bump.js "$APP_VERSION"
git diff --stat -- package.json package-lock.json packaging/start9/startos
_confirm "package.json version looks correct — proceed with bundle builds?"

# Step 1: the verify gate (unpiped, so a red suite stops the release).
echo "==> Running the verify gate (npm test)..."
npm test
_BUILD_SUMMARY="Tests"

# Step 5: release notes from the merged PRs since the last tag.
echo "==> Writing release notes..."
HAND_NOTES="notes/release-${APP_VERSION}.md"
if [ -f "$HAND_NOTES" ]; then
  echo "    Starting from $HAND_NOTES"
  cp "$HAND_NOTES" release_notes.md
else
  PREV_TAG=$(git tag --sort=-version:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | grep -v "^${RELEASE_TAG}$" | head -1 || echo "")
  if [ -n "$PREV_TAG" ]; then LOG_RANGE="${PREV_TAG}..HEAD"; echo "    Commits since $PREV_TAG"
  else LOG_RANGE="HEAD"; echo "    No previous tag - including all commits"; fi
  declare -A PR_NUM_FOR_SHA
  if [ -n "$REPO_SLUG" ] && [ -n "$GH_TOKEN" ]; then
    while IFS='|' read -r sha subject; do
      if [[ "$subject" =~ Merge\ pull\ request\ #([0-9]+) ]]; then PR_NUM_FOR_SHA["$sha"]="${BASH_REMATCH[1]}"; fi
    done < <(git log "$LOG_RANGE" --merges --format="%H|%s")
  fi
  FEAT_LINES=""
  FIX_LINES=""
  OTHER_LINES=""
  while IFS= read -r sha; do
    [[ -z "$sha" ]] && continue
    SUBJECT=$(git log -1 --format="%s" "$sha")
    TITLE="$SUBJECT"
    if [[ "$TITLE" =~ ^Merge\ pull\ request\ #[0-9]+\ from\ (.+)$ ]]; then
      BRANCH_TITLE="${BASH_REMATCH[1]}"
      PR_NUM="${PR_NUM_FOR_SHA[$sha]:-}"
      if [ -n "$PR_NUM" ] && [ -n "$REPO_SLUG" ] && [ -n "$GH_TOKEN" ]; then
        API_TITLE=$(curl -sf -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
          "https://api.github.com/repos/${REPO_SLUG}/pulls/${PR_NUM}" 2>/dev/null \
          | python3 -c "import sys,json; print(json.load(sys.stdin).get('title',''))" 2>/dev/null || echo "")
        [ -n "$API_TITLE" ] && TITLE="$API_TITLE"
      fi
      if [[ "$TITLE" == "$SUBJECT" ]]; then
        TITLE=$(printf '%s' "$BRANCH_TITLE" | sed -E 's|^[^/]+/||; s|^[^/]+/||; s/[-_]/ /g')
      fi
    fi
    _add_entry "$TITLE" ""
  done < <(git log "$LOG_RANGE" --merges --format="%H" --reverse)
  NOTES="## What's Changed\n\n"
  if [ -z "$FEAT_LINES" ] && [ -z "$FIX_LINES" ] && [ -z "$OTHER_LINES" ]; then
    NOTES="${NOTES}No commits since last release.\n"
  else
    [ -n "$FEAT_LINES" ] && NOTES="${NOTES}### ✨ Improvements\n\n${FEAT_LINES}\n"
    [ -n "$FIX_LINES"  ] && NOTES="${NOTES}### 🐛 Bug Fixes\n\n${FIX_LINES}\n"
    [ -n "$OTHER_LINES" ] && NOTES="${NOTES}### 🔧 Other\n\n${OTHER_LINES}\n"
  fi
  printf "%b" "$NOTES" > release_notes.md
fi
sed -i 's/\*\*//g' release_notes.md
echo "    Opening release notes in vi (write them for the people running the seeder, rule 13)..."
vi release_notes.md
echo "--- Release notes ---"
cat release_notes.md
echo "---"
_confirm "Release notes look good?"
node scripts/release/bump.js --notes release_notes.md

# Steps 5b-5d: the slow builds, best effort, after the notes.
_build() { # _build <label> <log> <command...>
  local _label="$1" _log="$2"; shift 2
  echo "--> $_label"
  if "$@" > "$_log" 2>&1 < /dev/null; then echo "    $_label OK."; return 0; fi
  echo "    WARNING: $_label failed, skipping it. Log: $_log"
  return 1
}
_P="$REPO_ROOT/dist/pkg"
_V="$APP_VERSION"

# 5b: desktop. The Mac build runs on the Mac Mini in the background.
if $SKIP_MACOS; then
  echo "--> macOS    (skipped)"
else
  _MAC_DONE="$(mktemp -d)"
  ( _build "macOS .pkg, Apple silicon and Intel (signed, notarized)" /tmp/peerloom-seeder-build-macos.log node scripts/dist-macos.js \
      && touch "$_MAC_DONE/ok" ) > "$_MAC_DONE/report" 2>&1 < /dev/null &
  _MAC_PID=$!
  echo "--> macOS    (on the Mac Mini, in the background)"
fi
if $SKIP_WINDOWS; then
  echo "--> Windows  (skipped)"
else
  _build "Windows installer" /tmp/peerloom-seeder-build-windows.log node scripts/dist-windows.js \
    && ARTIFACTS+=("$_P/PeerLoomSeeder-Setup-$_V.exe")
fi
# 5b2: Linux.
if $SKIP_LINUX; then
  echo "--> Linux    (skipped)"
else
  _build "Linux tarballs (x64, arm64) with the update smoke test" /tmp/peerloom-seeder-build-linux.log node scripts/dist-linux.js \
    && ARTIFACTS+=("$_P/peerloom-seeder-$_V-linux-x64.tar.gz" "$_P/peerloom-seeder-$_V-linux-arm64.tar.gz")
  _build "Linux .deb and AppImage" /tmp/peerloom-seeder-build-installers.log node scripts/dist-installers.js \
    && ARTIFACTS+=("$_P/peerloom-seeder_${_V}_amd64.deb" "$_P/peerloom-seeder_${_V}_arm64.deb" \
                   "$_P/PeerLoomSeeder-$_V-x86_64.AppImage" "$_P/PeerLoomSeeder-$_V-aarch64.AppImage")
fi
# 5d: store packages (the Umbrel image is pushed after the tag).
if ! $SKIP_UMBREL || ! $SKIP_START9; then
  if PUSH=0 _build "Umbrel image (amd64, arm64, not pushed yet)" /tmp/peerloom-seeder-build-umbrel.log scripts/build-umbrel-image.sh "$APP_VERSION"; then
    UMBREL_BUILT=true
  fi
fi
if ! $SKIP_START9 && $UMBREL_BUILT; then
  if _build "StartOS package" /tmp/peerloom-seeder-build-start9.log bash -c 'cd packaging/start9 && npm install --silent --no-audit --no-fund && make && make'; then
    _s9="$REPO_ROOT/packaging/start9/${APP_ID}_x86_64.s9pk"
    _got=$(start-cli-1.1.0 s9pk inspect "$_s9" manifest 2>/dev/null \
      | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null || echo "")
    if [ "$_got" = "$APP_VERSION:0" ]; then START9_S9PK="$_s9"
    else echo "    WARNING: the .s9pk says ${_got:-nothing}, expected $APP_VERSION:0; skipping it."; fi
  fi
fi
if [ -n "$_MAC_PID" ]; then
  echo "==> Waiting for the Mac build..."
  wait "$_MAC_PID" || true
  _MAC_PID=""
  cat "$_MAC_DONE/report"
  [ -e "$_MAC_DONE/ok" ] && ARTIFACTS+=("$_P/PeerLoomSeeder-$_V-arm64.pkg" "$_P/PeerLoomSeeder-$_V-x64.pkg")
fi
[ -n "$START9_S9PK" ] && ARTIFACTS+=("$START9_S9PK")

# 5e: checksums for everything that ships (the dist scripts write most; this
# covers the rest and catches a file that is missing).
_have=()
for _f in "${ARTIFACTS[@]}"; do
  if [ -f "$_f" ]; then
    ( cd "$(dirname "$_f")" && sha256sum "$(basename "$_f")" > "$(basename "$_f").sha256" )
    _have+=("$_f")
  else
    echo "    WARNING: expected $_f, not found."
  fi
done
ARTIFACTS=("${_have[@]}")
echo ""
echo "==> Built ${#ARTIFACTS[@]} download(s):"
for _f in "${ARTIFACTS[@]}"; do echo "    - $(basename "$_f")  ($(du -sh "$_f" | cut -f1))"; done
_RELEASE_SUMMARY="${#ARTIFACTS[@]} download(s)"
$UMBREL_BUILT && _RELEASE_SUMMARY="$_RELEASE_SUMMARY, Umbrel image"
_confirm "$_RELEASE_SUMMARY ready to publish?"

# Step 6: commit the bumps this run made.
GIT_REMOTE="${GITHUB_REMOTE:-}"
if [ -z "$GIT_REMOTE" ]; then
  if git remote | grep -q '^github$'; then GIT_REMOTE="github"; else GIT_REMOTE="origin"; fi
fi
_bump_paths=(package.json package-lock.json packaging/start9/startos/manifest/index.ts packaging/start9/startos/versions "$HAND_NOTES")
_bump_existing=()
for _p in "${_bump_paths[@]}"; do [ -e "$_p" ] && _bump_existing+=("$_p"); done
if [ -n "$(git status --porcelain -- "${_bump_existing[@]}")" ]; then
  echo "==> Committing version bumps for $APP_VERSION..."
  git add -- "${_bump_existing[@]}"
  git commit -q -m "chore(release): $APP_VERSION" || echo "    WARNING: version-bump commit failed." >&2
fi

# Step 6b: push the branch and the tag (the point of no return).
echo ""
echo "    Remote : $GIT_REMOTE"
echo "    Tag    : $RELEASE_TAG"
echo "    Branch : $(git rev-parse --abbrev-ref HEAD)"
echo "    Commit : $(git rev-parse --short HEAD)  $(git log -1 --format='%s')"
_confirm "Push branch $(git rev-parse --abbrev-ref HEAD) + tag $RELEASE_TAG to $GIT_REMOTE? (This cannot be undone without a force-delete)"
_branch="$(git rev-parse --abbrev-ref HEAD)"
git push "$GIT_REMOTE" "$_branch" || echo "    WARNING: branch push failed - push $_branch by hand." >&2
echo "==> Tagging and pushing $RELEASE_TAG..."
git tag "$RELEASE_TAG" 2>/dev/null || echo "    Tag already exists locally"
git push "$GIT_REMOTE" "$RELEASE_TAG" || echo "    Tag already on remote"

# Step 7: the GitHub release on the public releases repo.
if $PUBLISH_GITHUB && [ ${#ARTIFACTS[@]} -gt 0 ]; then
  RELEASE_ASSETS=()
  for _a in "${ARTIFACTS[@]}"; do RELEASE_ASSETS+=("$_a"); [ -f "${_a}.sha256" ] && RELEASE_ASSETS+=("${_a}.sha256"); done
  echo ""
  echo "    Repo   : $RELEASES_REPO"
  echo "    Tag    : $RELEASE_TAG"
  _confirm "Create public GitHub release $RELEASE_TAG and upload ${#RELEASE_ASSETS[@]} assets?"
  if gh release view "$RELEASE_TAG" -R "$RELEASES_REPO" >/dev/null 2>&1; then
    echo "    GitHub release $RELEASE_TAG already exists - replacing its notes and assets."
    gh release edit "$RELEASE_TAG" -R "$RELEASES_REPO" --notes-file release_notes.md >/dev/null \
      && gh release upload "$RELEASE_TAG" -R "$RELEASES_REPO" --clobber "${RELEASE_ASSETS[@]}" \
      || { PUBLISH_FAILED=true; echo "ERROR: updating the GitHub release failed."; }
  elif gh release create "$RELEASE_TAG" -R "$RELEASES_REPO" --title "$APP_NAME $APP_VERSION" \
         --notes-file release_notes.md "${RELEASE_ASSETS[@]}"; then
    echo "==> All ${#RELEASE_ASSETS[@]} assets uploaded."
  else
    PUBLISH_FAILED=true
    echo "ERROR: creating the GitHub release failed. The tag is pushed; re-run with $RELEASE_TAG --retag"
  fi
else
  echo "==> Skipping the GitHub release."
fi

# Step 7b: the stores.
_store_notes="Updated PeerLoom Seeder to $APP_VERSION. Release notes: https://github.com/$RELEASES_REPO/releases/tag/$RELEASE_TAG"
if ! $SKIP_UMBREL && $UMBREL_BUILT; then
  echo ""
  echo "==> Umbrel for $APP_VERSION..."
  if _ask "Push $UMBREL_IMAGE:$APP_VERSION (amd64, arm64) to ghcr?" y; then
    PUSH=1 scripts/build-umbrel-image.sh "$APP_VERSION" > /tmp/peerloom-seeder-push-umbrel.log 2>&1 < /dev/null \
      || { PUBLISH_FAILED=true; echo "    ERROR: pushing the image failed. Log: /tmp/peerloom-seeder-push-umbrel.log"; }
  fi
  _digest=""
  if skopeo inspect --raw "docker://$UMBREL_IMAGE:$APP_VERSION" >/dev/null 2>&1; then
    _digest="sha256:$(skopeo inspect --raw "docker://$UMBREL_IMAGE:$APP_VERSION" | sha256sum | cut -d' ' -f1)"
  else
    echo "    No $UMBREL_IMAGE:$APP_VERSION on ghcr, so the Umbrel stores are not updated."
  fi
  if [ -n "$_digest" ]; then
    # PeerLoom's community store. The first release adds the app folder from
    # packaging/umbrel; later ones bump it.
    _worktree "$PEERLOOM/peerloom-umbrel-app-store" origin master "$APP_ID-v$APP_VERSION"; _store="$WT"
    if [ ! -d "$_store/$APP_ID" ]; then
      mkdir -p "$_store/$APP_ID"
      cp packaging/umbrel/umbrel-app.yml packaging/umbrel/docker-compose.yml "$_store/$APP_ID/"
      cp assets/icon.svg "$_store/$APP_ID/icon.svg"
      sed -i "s#ghcr.io/peerloomllc/peerloom-seeder:VERSION@sha256:DIGEST#ghcr.io/peerloomllc/peerloom-seeder:0.0.0@sha256:$(printf '0%.0s' $(seq 1 64))#" "$_store/$APP_ID/docker-compose.yml"
      git -C "$_store" add "$APP_ID"
    fi
    _umbrel_bump "$_store/$APP_ID" "$APP_VERSION" "$_digest" "$_store_notes"
    git -C "$_store" diff --stat HEAD
    if _ask "Open the PeerLoom community store PR for $APP_VERSION?" y; then
      git -C "$_store" add -A
      git -C "$_store" commit -qm "$APP_ID: $APP_VERSION"
      git -C "$_store" push -q -f origin "$APP_ID-v$APP_VERSION"
      (cd "$_store" && gh pr create --base master --title "$APP_ID: $APP_VERSION" \
        --body "Image pinned to the multi-arch manifest-list digest ($_digest).") || echo "    WARNING: could not open the store PR."
    fi
    # The official store: a bump PR once the app is listed there. The first
    # listing is its own review, opened by hand.
    _fork="$PEERLOOM/umbrel-apps"
    git -C "$_fork" remote get-url upstream >/dev/null 2>&1 \
      || git -C "$_fork" remote add upstream https://github.com/getumbrel/umbrel-apps.git
    git -C "$_fork" fetch -q upstream
    if git -C "$_fork" cat-file -e "upstream/master:$APP_ID/umbrel-app.yml" 2>/dev/null; then
      _worktree "$_fork" upstream master "$APP_ID-v$APP_VERSION"; _official="$WT"
      _umbrel_bump "$_official/$APP_ID" "$APP_VERSION" "$_digest" "$_store_notes"
      if _ask "Open the official getumbrel/umbrel-apps update PR for $APP_VERSION?" y; then
        git -C "$_official" commit -qam "$APP_ID: update to $APP_VERSION"
        git -C "$_official" push -q -f origin "HEAD:$APP_ID-v$APP_VERSION"
        gh pr create --repo getumbrel/umbrel-apps --base master --head "peerloomllc:$APP_ID-v$APP_VERSION" \
          --title "$APP_ID: update to $APP_VERSION" \
          --body "Bump PeerLoom Seeder to $APP_VERSION (image pinned to the multi-arch manifest-list digest)." \
          || echo "    WARNING: could not open the official store PR."
      fi
    else
      echo "    $APP_ID is not in the official Umbrel store yet: its first listing is a separate PR."
    fi
  fi
fi
if ! $SKIP_START9 && [ -n "$START9_S9PK" ] && $PUBLISH_GITHUB; then
  echo ""
  echo "==> StartOS registry for $APP_VERSION..."
  _worktree "$PEERLOOM/website" origin main "registry/$APP_ID-$APP_VERSION"; _site="$WT"
  if START_CLI=start-cli-1.1.0 node packaging/start9/registry/build-registry-04.js "$START9_S9PK" \
       --url "https://peerloomllc.com/package/v1/$APP_ID.s9pk" --icon packaging/start9/icon.png \
       --out "$_site/registry/0.4/index.json"; then
    _url="https://github.com/$RELEASES_REPO/releases/download/$RELEASE_TAG/${APP_ID}_x86_64.s9pk"
    sed -i "\#^/*package/v1/$APP_ID.s9pk #d" "$_site/_redirects"
    printf '/package/v1/%s.s9pk  %s  302\n//package/v1/%s.s9pk  %s  302\n' "$APP_ID" "$_url" "$APP_ID" "$_url" >> "$_site/_redirects"
    git -C "$_site" diff --stat
    if _ask "Open the website PR for the StartOS registry ($APP_VERSION)? (Merging it publishes.)" y; then
      git -C "$_site" commit -qam "StartOS registry: PeerLoom Seeder $APP_VERSION"
      git -C "$_site" push -q -f origin "registry/$APP_ID-$APP_VERSION"
      (cd "$_site" && gh pr create --title "StartOS registry: PeerLoom Seeder $APP_VERSION" \
        --body "$APP_ID $APP_VERSION:0 in registry/0.4/index.json and its s9pk redirect to the $RELEASE_TAG release asset.") \
        || echo "    WARNING: could not open the website PR."
    fi
  else
    echo "    WARNING: building the StartOS registry entry failed - refresh it by hand."
  fi
fi

# Step 12: Nostr.
if ! $PUBLISH_NOSTR; then
  echo "==> Skipping the Nostr announcement."
elif $PUBLISH_FAILED; then
  echo "==> Skipping the Nostr announcement - a publish step failed."
elif ! command -v nak &>/dev/null; then
  echo "==> Skipping the Nostr announcement - nak not found."
else
  BULLETS=$(grep -E '^\s*[-*] ' release_notes.md | sed -E 's/^\s*[-*]\s+/• /' | head -8)
  NOTE_CONTENT="${APP_NAME} ${RELEASE_TAG} is out!"$'\n\n'"${APP_TAGLINE:-}"
  [ -n "$BULLETS" ] && NOTE_CONTENT+=$'\n\n'"What's new:"$'\n'"${BULLETS}"
  NOTE_CONTENT+=$'\n\n'"${APP_WEBSITE:-}"$'\n'"https://github.com/${RELEASES_REPO}/releases/tag/${RELEASE_TAG}"
  NOTE_CONTENT+=$'\n\n'"${NOSTR_HASHTAGS:-}"
  NOSTR_RELAYS=(wss://relay.damus.io wss://nos.lol wss://relay.primal.net wss://relay.nostr.net)
  NOSTR_DRAFT=$(mktemp /tmp/nostr-note-XXXXXX.txt)
  printf '%s' "$NOTE_CONTENT" > "$NOSTR_DRAFT"
  vi "$NOSTR_DRAFT"
  NOTE_CONTENT=$(cat "$NOSTR_DRAFT"); rm -f "$NOSTR_DRAFT"
  echo "$NOTE_CONTENT" | sed 's/^/      /'
  _confirm "Post this note to Nostr?"
  nak event --sec "$SIGN_WITH" -k 1 -c "$NOTE_CONTENT" "${NOSTR_RELAYS[@]}" \
    && echo "    Nostr announcement posted." \
    || echo "    WARNING: Nostr publish failed (the release itself is done)."
fi

# Step 13: what happened, per destination.
echo ""
echo "==> $APP_NAME $RELEASE_TAG"
$PUBLISH_GITHUB && _report "GitHub" "published" || _report "GitHub" "skipped"
$UMBREL_BUILT && ! $SKIP_UMBREL && _report "Umbrel" "built" || _report "Umbrel" "skipped"
[ -n "$START9_S9PK" ] && _report "StartOS" "built" || _report "StartOS" "skipped"
$PUBLISH_NOSTR && _report "Nostr" "announced" || _report "Nostr" "skipped"
if $PUBLISH_FAILED; then
  echo ""
  echo "    WARNING: at least one publish step failed. Scroll up for which."
  echo "    Re-run with ./scripts/release.sh $RELEASE_TAG --retag once fixed."
  exit 1
fi
