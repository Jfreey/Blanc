#!/usr/bin/env bash
#
# dev.sh — 一键启动开发环境
#   后端 server.mjs → http://localhost:8787
#   前端 vite       → http://localhost:5173  (HMR，/api 反代到 8787)
#
# 用法:
#   ./dev.sh          启动 后端 + 前端
#   ./dev.sh --kill   先杀掉占用端口的旧进程再启动
#   ./dev.sh --api    只启动后端
#   ./dev.sh --web    只启动前端
#
# Ctrl+C 一次即干净关闭全部进程。

set -uo pipefail

# 关键：不启用 job control（无 set -m），子进程与本脚本同属一个进程组，
# 终端 Ctrl+C 的 SIGINT 会同时送到 脚本 + server.mjs + vite（含其 esbuild 子进程），
# 一次性全部退出。不依赖 bash 的 trap/exit 语义 —— macOS 自带的 bash 3.2 在
# trap 里 exit 不可靠，会留下一个退不掉的壳进程。

cd "$(dirname "$0")" || exit 1

API_PORT="${PORT:-8787}"
WEB_PORT="${VITE_PORT:-5173}"
export BLANC_API_PORT="$API_PORT"   # vite.config.js 据此反代 /api，保证与后端一致

KILL_PORTS=0
ONLY_API=0
ONLY_WEB=0

usage() {
  cat <<'EOF'
dev.sh — 一键启动开发环境（后端 server.mjs + 前端 vite）

用法:
  ./dev.sh          启动 后端 + 前端
  ./dev.sh --kill   先杀掉占用端口的旧进程再启动
  ./dev.sh --api    只启动后端
  ./dev.sh --web    只启动前端
  ./dev.sh -h       显示本帮助

Ctrl+C 关闭全部进程。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --kill) KILL_PORTS=1 ;;
    --api)  ONLY_API=1 ;;
    --web)  ONLY_WEB=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1（-h 看用法）" >&2; exit 1 ;;
  esac
  shift
done

# ---- 颜色（非 TTY 时关闭）------------------------------------------
if [ -t 1 ]; then
  C_API=$'\033[36m'; C_WEB=$'\033[35m'; C_DIM=$'\033[2m'
  C_ERR=$'\033[31m'; C_OK=$'\033[32m'; C_0=$'\033[0m'
else
  C_API=""; C_WEB=""; C_DIM=""; C_ERR=""; C_OK=""; C_0=""
fi

die() { printf '%s✗ %s%s\n' "$C_ERR" "$1" "$C_0" >&2; exit 1; }

# ---- 前置检查 ------------------------------------------------------
command -v node >/dev/null 2>&1 || die "找不到 node，请先安装或用 mise / nvm 激活"
[ -d node_modules ] || die "缺少 node_modules，先跑一次 npm i"

# ---- 端口 ----------------------------------------------------------
port_busy() { lsof -ti ":$1" -sTCP:LISTEN >/dev/null 2>&1; }

free_port() {
  local pids
  pids="$(lsof -ti ":$1" -sTCP:LISTEN 2>/dev/null)"
  [ -n "$pids" ] || return 0
  printf '%s→ 杀掉占用 :%s 的旧进程 %s%s\n' "$C_DIM" "$1" "$pids" "$C_0"
  echo "$pids" | xargs kill 2>/dev/null
  sleep 1
}

check_port() {
  port_busy "$1" || return 0
  if [ "$KILL_PORTS" -eq 1 ]; then
    free_port "$1"
    port_busy "$1" && die ":$1 仍被占用，手动查：lsof -i :$1"
    return 0
  fi
  die ":$1 已被占用。用 ./dev.sh --kill 先停旧实例，或换个端口：PORT=8788 ./dev.sh"
}

WANT_API=1; WANT_WEB=1
[ "$ONLY_API" -eq 1 ] && WANT_WEB=0
[ "$ONLY_WEB" -eq 1 ] && WANT_API=0

[ "$WANT_API" -eq 1 ] && check_port "$API_PORT"
[ "$WANT_WEB" -eq 1 ] && check_port "$WEB_PORT"

# ---- 进程回收 ------------------------------------------------------
# 只为「脚本被信号终止」兜底（Ctrl+C 已由进程组 SIGINT 自行处理）
PIDS=()
CLEANED=0

cleanup() {
  [ "$CLEANED" -eq 1 ] && return 0
  CLEANED=1
  printf '\n%s停掉进程...%s' "$C_DIM" "$C_0"
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    kill -TERM "$pid" 2>/dev/null
  done
  wait 2>/dev/null
  printf '%s已退出%s\n' "$C_DIM" "$C_0"
}

trap cleanup EXIT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP

# ---- 启动 ----------------------------------------------------------
# awk 而非 sed：macOS 的 BSD sed 没有 -u，管道输出会被缓冲住看不到实时日志
pipe_to() {  # $1=颜色 $2=标签 $3..=命令
  local color="$1" label="$2"; shift 2
  "$@" > >(awk -v c="$color" -v l="$label" -v r="$C_0" \
    '{printf "%s%s%s │ %s\n", c, l, r, $0; fflush()}') 2>&1 &
  PIDS+=("$!")
}

printf '%s启动开发环境%s  (%s)\n\n' "$C_OK" "$C_0" "$(node -v)"

if [ "$WANT_API" -eq 1 ]; then
  pipe_to "$C_API" "api" node server.mjs
fi
if [ "$WANT_WEB" -eq 1 ]; then
  pipe_to "$C_WEB" "web" node node_modules/vite/bin/vite.js --port "$WEB_PORT" --strictPort
fi

sleep 2

printf '\n'
if [ "$WANT_API" -eq 1 ]; then
  printf '  %s后端 API%s  http://localhost:%s\n' "$C_API" "$C_0" "$API_PORT"
fi
if [ "$WANT_WEB" -eq 1 ]; then
  printf '  %s前端 UI%s   http://localhost:%s\n' "$C_WEB" "$C_0" "$WEB_PORT"
fi
printf '  %s数据目录%s   ~/.blanc/\n' "$C_DIM" "$C_0"
printf '  %sCtrl+C 关闭全部%s\n\n' "$C_DIM" "$C_0"

# ---- 监控：任一进程退出即整体收尾 ----------------------------------
while true; do
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '%s✗ 进程 %s 退出，关闭其余进程%s\n' "$C_ERR" "$pid" "$C_0"
      exit 1
    fi
  done
  sleep 1
done