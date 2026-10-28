/**
 * 发布构建的入口（package.json 的 tauri:build 调这个，而不是直接 npx tauri build）。
 *
 * 多做的事只有一件：**找到本机的自签名代码签名身份就带上**。
 *
 * 为什么需要：未签名（ad-hoc）的 app，每次构建 cdhash 都会变，macOS 的 TCC
 * （文档/桌面/下载目录访问授权）把它当成**另一个应用**，于是每次装新构建都要
 * 重新点一次「允许访问」。用一张固定的自签名证书签，designated requirement 变成
 *   identifier "org.blanc.notes" and certificate leaf = H"<固定指纹>"
 * 跨构建不变，授权就留住了。
 *
 * 证书怎么来：见 scripts/make-signing-cert.sh（只在本机跑一次，私钥进登录钥匙串）。
 * 没有证书的机器照旧 ad-hoc 签名 —— 构建不会失败，只是每次要重新授权。
 * 也可以用 APPLE_SIGNING_IDENTITY 显式指定别的身份（比如真 Developer ID）。
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CERT_NAME = "Blanc Local Signing";
const env = { ...process.env };

if (!env.APPLE_SIGNING_IDENTITY) {
  const r = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  if ((r.stdout || "").includes(`"${CERT_NAME}"`)) {
    env.APPLE_SIGNING_IDENTITY = CERT_NAME;
    console.log(`[build] 用自签名身份签名：${CERT_NAME}`);
  } else {
    console.log("[build] 没找到自签名身份，按 ad-hoc 签名（每次重装需重新授权目录访问）");
  }
}

const bin = join(process.cwd(), "node_modules", ".bin", "tauri");
const r = spawnSync(bin, ["build", "--config", "desktop/src-tauri/tauri.conf.json"], {
  stdio: "inherit",
  env,
});
process.exit(r.status ?? 1);
