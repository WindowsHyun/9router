#!/usr/bin/env bash
# Brings up a virtual display, publishes it over noVNC, and runs the
# codex-chatgpt-web launcher on it.
#
# The launcher — not this script — owns both halves of the bridge:
#   - launcher/electron/runtime-supervisor.cjs spawns the Responses runtime, so
#     running `cli.ts serve` here as well would fight it for the port.
#   - src/setup.ts refuses a terminal-only setup off macOS
#     ("Terminal-only managed Chrome setup currently requires macOS") unless
#     the browser is launcher-owned, so setup has to happen inside the launcher
#     too.
#
# That leaves exactly one human step: open noVNC, finish setup and sign in to
# chatgpt.com. The profile volume keeps it signed in across restarts.
set -euo pipefail

BRIDGE_PORT="${BRIDGE_PORT:-17841}"
VNC_PORT="${VNC_PORT:-6080}"
PROFILE="${CODEX_CHATGPT_WEB_HOME:-/data/profile}"
DISPLAY_NUM="${DISPLAY:-:99}"

log() { printf '[chatgpt-web] %s\n' "$*"; }

mkdir -p "$PROFILE"

log "starting virtual display on $DISPLAY_NUM"
Xvfb "$DISPLAY_NUM" -screen 0 1440x900x24 -nolisten tcp &
XVFB_PID=$!

# Wait for the display to accept connections; Electron exits immediately if it
# starts first.
for _ in $(seq 1 50); do
  xdpyinfo -display "$DISPLAY_NUM" >/dev/null 2>&1 && break
  sleep 0.2
done

log "publishing the display on noVNC :$VNC_PORT"
x11vnc -display "$DISPLAY_NUM" -forever -shared -nopw -quiet -localhost -rfbport 5900 &
websockify --web /usr/share/novnc "0.0.0.0:${VNC_PORT}" "127.0.0.1:5900" >/dev/null 2>&1 &

cleanup() {
  log "stopping"
  kill "$XVFB_PID" 2>/dev/null || true
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup TERM INT

if [ ! -f "$PROFILE/config.json" ]; then
  log "no config yet — open http://<host>:${VNC_PORT}/vnc.html and complete setup in the launcher"
else
  log "config found; the launcher will start the bridge on :${BRIDGE_PORT}"
fi

# Electron cannot use its sandbox as PID 1 in a container without extra
# capabilities, and this container is already isolated.
export ELECTRON_DISABLE_SANDBOX=1
export CODEX_CHATGPT_WEB_HOME="$PROFILE"

cd /opt/codex-chatgpt-web
exec bun run scripts/start-launcher.ts
