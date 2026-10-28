#!/bin/bash
# 把 appex 塞进打包好的 .app，然后重签名。
#
# Tauri 没有「app extension」的概念，bundle.macOS.files 只会把文件丢进
# Contents/Resources —— Quick Look 只认 Contents/PlugIns/*.appex，
# 所以只能在 tauri build 之后手工注入并重签（ad-hoc 本机自用）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APPEX="$HERE/build/BlancQuickLook.appex"

APP="${1:-}"
if [ -z "$APP" ]; then
  APP="$(ls -dt "$HERE"/../src-tauri/target/release/bundle/macos/*.app 2>/dev/null | head -1)"
fi
[ -n "$APP" ] && [ -d "$APP" ] || { echo "找不到 .app：$APP" >&2; exit 1; }
[ -d "$APPEX" ] || { echo "先跑 build-ql.sh" >&2; exit 1; }

# 沙盒 Quick Look 扩展必须有真实签名身份才能建容器：
# ad-hoc 签的 appex 一被拉起就在 _libsecinit_appsandbox 里 SIGTRAP，
# 崩在我们自己的代码之前（EXC_BREAKPOINT / libSystem_initializer）。
# 所以没证书时直接跳过注入，而不是往包里塞一个必崩的扩展。
# 拿到 Developer ID 后本脚本会自动改用该身份签名，无需改代码。
# 只认真正的 Developer ID。**本机自签名不行**（2026-10-22 实测）：
# 扩展能注进去、也能签名，但沙盒容器建不起来；Quick Look 不会回落到系统自带的
# 纯文本预览，而是每个 .md 按空格都弹「找不到扩展 org.blanc.notes.quicklook」。
# 所以 "Blanc Local Signing"（只用来稳住 TCC 授权的那张）不能算 --
# 否则装了本机构建后，按空格预览比没有扩展还糟。
SIGN_ID="${TAURI_SIGN_ID:-}"
if [ -z "$SIGN_ID" ]; then
  # 注意 || true：没证书时 grep 返回 1，配合 set -e + pipefail 会让脚本
  # 在打印「跳过注入」提示之前就静默退出（曾经踩过，只看到 exit=1 没有输出）
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | grep -oE '"Developer ID Application: [^"]+"' | head -1 | tr -d '"' || true)"
fi
if [ -z "$SIGN_ID" ]; then
  # 关键：把**之前注进去过**的 appex 摘掉。旧版本只要找到任意签名身份就注入，
  # 于是自签名那次留下的扩展一直注册在 LaunchServices 里 —— 不摘的话装了新构建
  # 还是继续弹「找不到扩展」，看起来像没修。
  APPEX_IN_APP="$APP/Contents/PlugIns/BlancQuickLook.appex"
  if [ -d "$APPEX_IN_APP" ]; then
    pluginkit -r "$APPEX_IN_APP" 2>/dev/null || true
    rm -rf "$APPEX_IN_APP"
    rmdir "$APP/Contents/PlugIns" 2>/dev/null || true
    echo "[quicklook] 已摘除残留的 appex 并注销注册"
  fi
  cat >&2 <<'MSG'
[quicklook] 跳过注入：没有 Developer ID 签名身份。
           Quick Look 扩展必须开沙盒，而沙盒需要真实签名身份才能初始化容器；
           ad-hoc / 自签名的 appex 都起不来，系统不会回落纯文本预览，
           而是每次按空格都弹「找不到扩展」。
           装 Apple Developer 证书后重跑 npm run tauri:build 即可自动启用，
           或用 TAURI_SIGN_ID="Developer ID Application: ..." 指定身份。
MSG
  exit 0
fi
echo "[quicklook] 使用签名身份: $SIGN_ID"

HOST_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
QL_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APPEX/Contents/Info.plist")"
case "$QL_ID" in
  "$HOST_ID".*) ;;
  *) echo "appex 的 bundle id 必须以宿主 app id 开头：需要 $HOST_ID.*，实际 $QL_ID" >&2; exit 1 ;;
esac

mkdir -p "$APP/Contents/PlugIns"
rm -rf "$APP/Contents/PlugIns/BlancQuickLook.appex"
cp -R "$APPEX" "$APP/Contents/PlugIns/"

# 顺序有讲究：先签 appex，再签外层。
# 外层【绝不能加 --deep】—— --deep 会用外层的签名参数把嵌套代码重新签一遍，
# appex 的 entitlement（沙盒）会被整个冲掉，于是系统拒绝加载这个扩展，
# 表现为「按空格没反应 / qlmanage 说不产生预览」，而且日志里什么线索都没有。
# 正确做法：签完 appex 后签外层且不加 --deep，外层会把 appex 原样封进 CodeResources。
codesign --force --sign "$SIGN_ID" --options runtime --timestamp --entitlements "$HERE/entitlements.plist" \
  "$APP/Contents/PlugIns/BlancQuickLook.appex"
codesign --force --sign "$SIGN_ID" "$APP"
codesign --verify --deep --strict "$APP"

# 自检：沙盒 entitlement 必须还在，否则 Quick Look 加载不了
if ! codesign -d --entitlements :- "$APP/Contents/PlugIns/BlancQuickLook.appex" 2>/dev/null | grep -q app-sandbox; then
  echo "!! appex 的沙盒 entitlement 在注入过程中丢了，Quick Look 不会加载它" >&2
  exit 1
fi

# 重新登记，Quick Look 靠 LaunchServices 发现新扩展
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREG" -f "$APP"

echo "已注入 -> $APP/Contents/PlugIns/BlancQuickLook.appex"
codesign -dv --entitlements - "$APP" 2>/dev/null | grep -q . || true
"$LSREG" -dump 2>/dev/null | grep -A3 -i "quicklook.preview" | grep -i "blanc" | head -3 || true
