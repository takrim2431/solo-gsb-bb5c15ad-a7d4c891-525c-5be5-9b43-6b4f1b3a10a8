#!/usr/bin/env bash
# 端到端测试：用独立临时数据目录启动服务器 -> 跑测试 -> 清理
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${TEST_PORT:-3321}"
DATA_DIR="$(mktemp -d)"
trap 'kill "${SERVER_PID:-0}" 2>/dev/null || true; rm -rf "$DATA_DIR"' EXIT

DATA_DIR="$DATA_DIR" PORT="$PORT" node src/server.js >/tmp/rehearsal-test-server.log 2>&1 &
SERVER_PID=$!

for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.3
done

BASE="http://127.0.0.1:$PORT" node scripts/e2e.cjs
