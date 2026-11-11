#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
npm ci --prefix "$PROJECT_DIR/packages/pi-extension/semantic-runtime" --ignore-scripts --no-audit --no-fund
printf '%s\n' 'Semantic runtime installed. Model files are verified and downloaded on first use.'
