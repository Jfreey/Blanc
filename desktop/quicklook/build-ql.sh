#!/bin/bash
# 编 Quick Look appex，并用 ad-hoc 签名。
# 本机没有 Developer ID 证书（本机自用），codesign -s - 足够；
# 要分发给别人的话得换成 Developer ID 重签（外层 app 也一起）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/build/BlancQuickLook.appex"
SDK="$(xcrun --show-sdk-path)"
MIN="12.0"

rm -rf "$HERE/build" "$OUT"
mkdir -p "$OUT/Contents/MacOS"

# 出 universal 二进制：Apple Silicon + Intel
for ARCH in arm64 x86_64; do
  swiftc -O -sdk "$SDK" -target "${ARCH}-apple-macos${MIN}" \
    -framework AppKit -framework WebKit -framework QuickLookUI -framework Foundation \
    -o "$OUT/Contents/MacOS/BlancQuickLook.$ARCH" "$HERE/Preview.swift"
done
lipo -create -output "$OUT/Contents/MacOS/BlancQuickLook" \
  "$OUT/Contents/MacOS/BlancQuickLook.arm64" "$OUT/Contents/MacOS/BlancQuickLook.x86_64"
rm -f "$OUT/Contents/MacOS/BlancQuickLook."{arm64,x86_64}

cp "$HERE/Info.plist" "$OUT/Contents/Info.plist"
printf 'APPL????' > "$OUT/Contents/PkgInfo"

codesign --force --sign - --entitlements "$HERE/entitlements.plist" "$OUT"
codesign --verify --deep --strict "$OUT"

echo "OK -> $OUT"
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$OUT/Contents/Info.plist"
file "$OUT/Contents/MacOS/BlancQuickLook"
