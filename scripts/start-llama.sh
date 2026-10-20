#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"
if [ ! -x .venv/bin/cirno-route ]; then
  printf '%s\n' '请先运行 uv sync --python 3.12' >&2
  exit 1
fi
.venv/bin/cirno-route init
exec llama-server \
  --offline \
  -hf HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive:Q4_K_M \
  --no-mmproj --jinja -c 8192 -ngl all --reasoning off \
  --host 127.0.0.1 --port 18080 --alias cirno-gemma-e4b \
  --parallel 1 --no-webui \
  --api-key-file "$PROJECT_DIR/.runtime/llama.token"
