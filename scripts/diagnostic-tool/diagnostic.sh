#!/usr/bin/env sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/diagnostic.mjs" "$@"