#!/bin/sh
# 一次性：在本机生成并信任一张自签名代码签名证书（"Blanc Local Signing"）。
#
# 目的只有一个 —— 让每次构建出来的 Blanc 在 macOS 眼里是**同一个应用**。
# ad-hoc 签名每次 cdhash 都变，TCC 的文档目录授权跟不住，于是每次重装都要重新点允许。
#
# 这张证书只在本机有效（其他机器不认），不能替代 Developer ID 分发签名；
# 私钥进登录钥匙串，证书文件留在临时目录里，跑完即删。
#
# 重复运行是安全的：已经有同名身份就直接退出。
set -e

NAME="Blanc Local Signing"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$NAME\""; then
  echo "✓ 已存在签名身份：$NAME"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

echo "→ 生成自签名证书…"
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout key.pem -out cert.pem \
  -subj "/CN=$NAME" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

echo "→ 导入登录钥匙串（codesign 可直接使用，不弹窗）…"
# -legacy：OpenSSL 3 默认的 PKCS12 加密算法 macOS 的 Security.framework 读不了
openssl pkcs12 -export -legacy -inkey key.pem -in cert.pem \
  -out id.p12 -passout pass:blanc -name "$NAME"
security import id.p12 -k "$HOME/Library/Keychains/login.keychain-db" \
  -P blanc -T /usr/bin/codesign -T /usr/bin/security

echo "→ 信任这张证书（仅用于代码签名）…"
security add-trusted-cert -r trustRoot \
  -k "$HOME/Library/Keychains/login.keychain-db" cert.pem

security find-identity -v -p codesigning | grep "$NAME"
echo "✓ 完成。之后 npm run tauri:build 会自动用它签名。"
