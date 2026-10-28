#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export CIRNO_LOCAL_BACKEND=llama-server
exec "$SCRIPT_DIR/start-pi.sh" "$@"
