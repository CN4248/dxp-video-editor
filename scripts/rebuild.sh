#!/usr/bin/env bash
# CineCut 快速重建：只重建 app 层，复用 ffmpeg/字体依赖层。
# 用法：
#   bash scripts/rebuild.sh            # 构建并启动
#   bash scripts/rebuild.sh --build-only
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "找不到 docker 命令" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "需要 Docker Compose v2（docker compose）" >&2
  exit 1
fi

# 强制 BuildKit：分层缓存和并发构建都更好。
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

build_only=0
compose_args=()
for arg in "$@"; do
  if [[ "$arg" == "--build-only" ]]; then
    build_only=1
  else
    compose_args+=("$arg")
  fi
done

start=$(date +%s)
echo "==> 构建 CineCut（复用依赖层，正常只需几秒）"
docker compose build "${compose_args[@]}"

if (( build_only == 0 )); then
  echo "==> 启动/更新容器"
  docker compose up -d --no-build "${compose_args[@]}"
fi

echo "==> 完成，用时 $(( $(date +%s) - start )) 秒"
echo "   提示：只有修改 Dockerfile 依赖层、基础镜像或 APK_MIRROR 时才会重装 ffmpeg。"
