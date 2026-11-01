#!/bin/sh
# Runs the app as PUID:PGID (Unraid uses 99:100) and makes sure the data
# folder is writable by that user. If the container was started with
# --user already, it just runs the command.
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  # Only touch ownership when it is wrong, so big folders start fast.
  if [ "$(stat -c '%u:%g' "$DATA_DIR")" != "$PUID:$PGID" ]; then
    chown -R "$PUID:$PGID" "$DATA_DIR"
  fi
  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
