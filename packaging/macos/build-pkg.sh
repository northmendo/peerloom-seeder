#!/bin/bash
# Build PeerLoomSeeder-<version>-<arch>.pkg from a staged payload. Runs on a
# Mac; scripts/dist-macos.js stages the payload on Linux and calls this over
# ssh.
#
#   build-pkg.sh <staged dir> <version> <arm64|x64> <out dir>
#
# Env: APP_SIGN_ID, PKG_SIGN_ID (codesign / productbuild identities; empty
# builds an unsigned test package), NOTARY_PROFILE (notarytool keychain
# profile), KEYCHAIN_PATH, SKIP_NOTARIZE=1.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
STAGED="$1"; VERSION="$2"; ARCH="$3"; OUT="$4"
APP_SIGN_ID="${APP_SIGN_ID-Developer ID Application}"
PKG_SIGN_ID="${PKG_SIGN_ID-Developer ID Installer}"
NOTARY_PROFILE="${NOTARY_PROFILE:-pearcircle-seeder-notary}"
KEYCHAIN_PATH="${KEYCHAIN_PATH:-$HOME/Library/Keychains/buildkey.keychain-db}"
case "$ARCH" in arm64) HOST_ARCH=arm64 ;; x64) HOST_ARCH=x86_64 ;; *) echo "arch must be arm64 or x64" >&2; exit 2 ;; esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
root="$work/root"
lib="$root/usr/local/lib/peerloom-seeder"
mkdir -p "$lib/installer" "$work/scripts" "$OUT"
cp -R "$STAGED/." "$lib/"
cp "$here/com.peerloomllc.seeder.plist" "$lib/installer/"
cp "$here/uninstall.sh" "$lib/uninstall.sh"
chmod 0755 "$lib/uninstall.sh" "$lib/node" "$lib/bare"
cp "$here/postinstall" "$work/scripts/postinstall"
chmod 0755 "$work/scripts/postinstall"

# The icon, from the 1024 px PNG staged beside the payload.
if [ -f "$STAGED/../icon-1024.png" ]; then
  iconset="$work/AppIcon.iconset"; mkdir -p "$iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$STAGED/../icon-1024.png" --out "$iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$STAGED/../icon-1024.png" --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$lib/AppIcon.icns"
fi

if [ -n "$APP_SIGN_ID" ]; then
  if [ -e "$KEYCHAIN_PATH" ]; then
    security unlock-keychain -p "" "$KEYCHAIN_PATH" 2>/dev/null || true
    security list-keychains -s "$KEYCHAIN_PATH" "$HOME/Library/Keychains/login.keychain-db" /Library/Keychains/System.keychain >/dev/null 2>&1 || true
  fi
  # Every Mach-O in the payload: the addons first, then the two runtimes with
  # the JIT entitlements. Notarization rejects any unsigned binary.
  n=0
  while IFS= read -r f; do
    if file "$f" | grep -q Mach-O; then
      codesign --force --options runtime --timestamp --sign "$APP_SIGN_ID" "$f"
      n=$((n + 1))
    fi
  done < <(find "$lib" -type f \( -name '*.bare' -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \))
  echo "signed $n addons"
  for b in node bare; do
    codesign --force --options runtime --timestamp --entitlements "$here/entitlements.plist" --sign "$APP_SIGN_ID" "$lib/$b"
  done
else
  codesign --force --sign - "$lib/node"
  codesign --force --sign - "$lib/bare"
fi

component="$work/PeerLoomSeeder-component.pkg"
pkgbuild --analyze --root "$root" "$work/component.plist" >/dev/null
# Not relocatable: macOS would otherwise install over a copy it finds elsewhere.
/usr/libexec/PlistBuddy -c 'Set :0:BundleIsRelocatable false' "$work/component.plist" 2>/dev/null || true
pkgbuild --root "$root" --component-plist "$work/component.plist" --identifier com.peerloomllc.seeder \
  --version "$VERSION" --scripts "$work/scripts" --install-location / "$component" >/dev/null

res="$work/Resources"
mkdir -p "$res"
cp "$here/Resources/welcome.html" "$res/"
cp "$STAGED/LICENSE.txt" "$res/LICENSE.txt"
sed -e "s/__VERSION__/$VERSION/" -e "s/__ARCH__/$HOST_ARCH/" "$here/Distribution.xml" > "$work/Distribution.xml"
pkg="$OUT/PeerLoomSeeder-$VERSION-$ARCH.pkg"
if [ -n "$PKG_SIGN_ID" ]; then
  productbuild --distribution "$work/Distribution.xml" --resources "$res" --package-path "$work" --sign "$PKG_SIGN_ID" --timestamp "$pkg" >/dev/null
  if [ "${SKIP_NOTARIZE:-0}" != 1 ]; then
    xcrun notarytool submit "$pkg" --keychain-profile "$NOTARY_PROFILE" --keychain "$KEYCHAIN_PATH" --wait
    xcrun stapler staple "$pkg"
  fi
else
  productbuild --distribution "$work/Distribution.xml" --resources "$res" --package-path "$work" "$pkg" >/dev/null
  echo "unsigned test package: install with sudo installer -allowUntrusted -pkg $pkg -target /"
fi
echo "built $pkg"
