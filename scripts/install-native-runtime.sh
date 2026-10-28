#!/bin/sh
# Default native backend, installed inside the plugin; never updates global packages.
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
npm ci --prefix "$PROJECT_DIR/packages/pi-extension/native-runtime" --ignore-scripts --no-audit --no-fund
printf '%s\n' 'Native runtime installed. Start with ./scripts/start-pi.sh; use ./scripts/start-pi-llama.sh for the legacy server backend.'
