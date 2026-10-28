#!/bin/sh
# Install the versioned Pi recipe next to this checkout; keep existing user state.
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PI_DIR="$PROJECT_DIR/../Pi"
RECIPE="$PROJECT_DIR/tooling/pi"
mkdir -p "$PI_DIR"
cp "$RECIPE/package.json" "$RECIPE/package-lock.json" "$PI_DIR/"
npm ci --prefix "$PI_DIR"
for entry in pi pi-classifier pi-local; do
  cp "$RECIPE/$entry" "$PI_DIR/$entry"
  chmod +x "$PI_DIR/$entry"
done
mkdir -p "$PI_DIR/.state"
chmod 700 "$PI_DIR/.state"
if [ ! -e "$PI_DIR/.state/models.json" ]; then
  cp "$RECIPE/models.example.json" "$PI_DIR/.state/models.json"
  chmod 600 "$PI_DIR/.state/models.json"
fi
MODULES="$PROJECT_DIR/packages/pi-extension/node_modules"
if [ ! -e "$MODULES" ] && [ ! -L "$MODULES" ]; then
  ln -s ../../../Pi/node_modules "$MODULES"
fi
"$PROJECT_DIR/scripts/install-native-runtime.sh"
printf '%s\n' "Pi installed at $PI_DIR. Existing configuration and sessions preserved."
