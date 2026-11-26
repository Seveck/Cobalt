#!/usr/bin/env bash
# Dev launcher: a background daemon started by an MCP bridge (`cobalt --headless`) would
# swallow `tauri dev` through the single-instance guard and show a window pointing to a
# Vite server that no longer exists. Stop debug daemons first, then start the app.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
for pid in $(pgrep -x cobalt || true); do
  if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "target/debug/cobalt --headless"; then
    echo "Stopping background dev daemon (pid $pid)"
    kill "$pid"
  fi
done
exec pnpm tauri dev
