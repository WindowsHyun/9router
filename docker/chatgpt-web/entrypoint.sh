#!/usr/bin/env bash
# The bridge: a config, a session endpoint, and `serve`.
#
# What is deliberately NOT here: an Electron launcher, a GUI, and any VNC at
# all. Signing in happens in 9Router, which posts a chatgpt.com session to
# session-agent.mjs; the bridge verifies it with the browser already here.
#
# A bare Xvfb stays because the bridge runs headful by default — headless
# is a mode upstream never runs (see bootstrap-config.ts). An X server with no
# window manager and no compositor is tens of megabytes; the launcher and the
# VNC stack it replaced were the actual weight.
#
# Steady-state process tree:
#   tini → Xvfb (always: session verification needs a display)
#        → bun (cli.ts serve) → chromium (per session)
#        → bun (session-agent, idle)
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

# The display starts unconditionally, including under BRIDGE_HEADLESS=1.
#
# Not a hedge: verifying a session needs one whatever the routed browser does.
# inspectStoredState() — which is what turns a pasted session into a verified
# one — hardcodes its own launch:
#
#   const verifierBrowser = await chromium.launch({
#     executablePath: config.chromeExecutablePath,
#     headless: false, ...
#
# so with no X server, Connect fails every time and the bridge can never be
# signed in at all. BRIDGE_HEADLESS therefore means "run the *routed* browser
# headless" and nothing more.
#
# An X server with no window manager, no compositor and no VNC costs tens of
# megabytes. The Electron launcher and permanent VNC stack this replaced cost
# orders of magnitude more, and that was the actual problem.
export DISPLAY="${LOGIN_DISPLAY:-:99}"
log "starting the display on $DISPLAY"
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp &
XVFB_PID=$!
for _ in $(seq 1 60); do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 0.25
done
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 || { log "Xvfb never came up"; exit 1; }

# Accepts a chatgpt.com session from 9Router and verifies it. No display of
# its own, no VNC, nothing to connect to.
log "starting the session agent on :${SESSION_PORT:-17842}"
bun /opt/session-agent.mjs &
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
  [ -n "${XVFB_PID:-}" ] && kill "$XVFB_PID" 2>/dev/null || true
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
