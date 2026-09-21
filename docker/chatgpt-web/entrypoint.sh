#!/usr/bin/env bash
# Headless bridge: a config, an on-demand sign-in console, and `serve`.
#
# What is deliberately NOT here any more: Xvfb, x11vnc, websockify and an
# Electron launcher, all started unconditionally and resident for the life of
# the pod. The bridge runs headless (`headed: false`), and the X and VNC
# processes are started by login-agent.mjs only while someone is signing in,
# then stopped again.
#
# Steady-state process tree:
#   tini → bun (cli.ts serve) → chromium (headless, per session)
#        → bun (login-agent, idle)
set -euo pipefail

BRIDGE_PORT="${BRIDGE_PORT:-17841}"
PROFILE="${CODEX_CHATGPT_WEB_HOME:-/data/profile}"
BRIDGE_ROOT="${BRIDGE_ROOT:-/opt/codex-chatgpt-web}"

log() { printf '[chatgpt-web] %s\n' "$*"; }

mkdir -p "$PROFILE"
export CODEX_CHATGPT_WEB_HOME="$PROFILE"
export BRIDGE_ROOT

# Writes config.json with the bridge's own defaultConfig()/saveConfig(), and
# migrates a config left behind by the previous launcher-based image.
# Upstream's `setup` cannot be used: prepareSetup() throws off macOS for this
# browser host, and that gate is in the setup path only — `serve` is just
# loadConfig() + startServer().
log "preparing configuration"
bun /opt/bootstrap-config.ts

# The sign-in console. Binds immediately, starts nothing until it is opened.
log "starting the sign-in console agent on :${VNC_PORT:-6080}"
bun /opt/login-agent.mjs &
AGENT_PID=$!

# The bridge binds 127.0.0.1 — its own config type pins the host — which is
# right for a Kubernetes sidecar sharing 9Router's network namespace, but
# unreachable from a sibling container. Opt in when the two are separate, as
# they are under docker-compose.
FORWARD_PID=""
if [ -n "${BRIDGE_PUBLISH_PORT:-}" ]; then
  log "publishing 0.0.0.0:${BRIDGE_PUBLISH_PORT} → 127.0.0.1:${BRIDGE_PORT}"
  bun /opt/tcp-forward.mjs "${BRIDGE_PUBLISH_PORT}" "${BRIDGE_PORT}" &
  FORWARD_PID=$!
fi

cleanup() {
  log "stopping"
  kill "$AGENT_PID" 2>/dev/null || true
  [ -n "$FORWARD_PID" ] && kill "$FORWARD_PID" 2>/dev/null || true
}
trap cleanup TERM INT

if [ -f "$PROFILE/browser/storage-state.json" ]; then
  log "ChatGPT session present; routed requests will use it"
else
  log "not signed in yet — press Login in the 9Router dashboard"
fi

log "starting the bridge on 127.0.0.1:${BRIDGE_PORT}"
cd "$BRIDGE_ROOT"
exec bun run "$BRIDGE_ROOT/src/cli.ts" serve
