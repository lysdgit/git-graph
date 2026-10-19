#!/bin/sh
# Launcher for the standalone Git Graph app.
set -e
APP_DIR=$(cd "$(dirname "$0")" && pwd)
exec node "$APP_DIR/standalone/out/standalone/src/main.js" "$@"
