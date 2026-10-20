#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PI_DIR="$PROJECT_DIR/../Pi"
if [ ! -s "$PROJECT_DIR/.runtime/llama.token" ] || [ ! -s "$PROJECT_DIR/.runtime/api.token" ]; then
  "$PROJECT_DIR/.venv/bin/cirno-route" --config "$PROJECT_DIR/config.json" init >/dev/null
fi
export CIRNO_GATEWAY_API_KEY="$(cat "$PROJECT_DIR/.runtime/gateway.token")"
export CIRNO_LLAMA_API_KEY="$(cat "$PROJECT_DIR/.runtime/llama.token")"
export PI_OFFLINE=1
export PI_TELEMETRY=0
exec "$PI_DIR/pi" --offline --model cirno-gateway/claude-sonnet-4-6 --thinking off \
  --extension "$PROJECT_DIR/packages/pi-extension/index.ts" "$@"
