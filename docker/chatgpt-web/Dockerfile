# ChatGPT Web bridge, packaged so `docker compose up` brings it along with
# 9Router instead of asking the user to install a desktop app separately.
#
# Why the Electron launcher and not the bun CLI:
#   codex-chatgpt-web has a terminal-only setup path, but src/setup.ts gates it
#   on `process.platform === "darwin"` unless the browser is launcher-owned:
#
#     if (!launcherOwned && process.platform !== "darwin") throw
#       "Terminal-only managed Chrome setup currently requires macOS."
#
#   So on Linux the launcher must own the browser. Re-implementing its
#   browser-host protocol would be unsupported and would break on their next
#   release, so this image runs the real launcher on a virtual display.
#
# Signing in: the launcher's window is served over noVNC on :6080. Open it,
# finish setup and sign in to chatgpt.com once; the session persists in the
# mounted profile volume. The launcher supervises the bridge runtime itself
# (launcher/electron/runtime-supervisor.cjs), which then answers on :17841 —
# so the entrypoint runs the launcher and never `cli.ts serve`, or the two
# would fight for the port.

FROM debian:bookworm-slim

ARG BRIDGE_VERSION=v5.0.8
ARG APT_MIRROR_HOST=deb.debian.org
ARG DEBIAN_FRONTEND=noninteractive

# Regional mirror is opt-in, same convention as the main Dockerfile.
RUN if [ "$APT_MIRROR_HOST" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR_HOST}|g" /etc/apt/sources.list.d/debian.sources; \
    fi

# Electron needs a real GTK/X stack even headless; Xvfb provides the display and
# x11vnc + noVNC make that display reachable from a browser for the one-time
# sign-in. fonts-liberation and the CJK fonts keep chatgpt.com legible.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget unzip git \
      xvfb x11vnc novnc websockify x11-utils \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 libgtk-3-0 libx11-xcb1 libxss1 \
      fonts-liberation fonts-noto-cjk \
      dbus-x11 xauth tini \
    && rm -rf /var/lib/apt/lists/*

# Bun runs the bridge itself (the repo declares packageManager bun@1.4.0).
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash

WORKDIR /opt/codex-chatgpt-web
# A pinned tag, not HEAD: an unpinned bridge would change how routed requests
# behave on every image rebuild.
# The renderer is built here, at image build time. The alternative,
# scripts/start-launcher.ts, runs the launcher in Vite dev mode and re-runs
# `bun install` on every container start — which needs network at boot and
# fails without it. Verified locally: with launcher deps installed, the build
# completes and writes launcher/dist/index.html, and `start` is `electron .`
# against electron/main.cjs.
RUN git clone --depth 1 --branch "${BRIDGE_VERSION}" \
      https://github.com/miuuyy/codex-chatgpt-web . \
    && bun install --frozen-lockfile \
    && bun install --frozen-lockfile --cwd launcher \
    && bun run --cwd launcher build

# NOT /tmp: the bridge refuses to set up when its own runtime path looks
# ephemeral ("Runtime command must not reference an ephemeral path").
ENV CODEX_CHATGPT_WEB_HOME=/data/profile
ENV BRIDGE_PORT=17841
ENV DISPLAY=:99
ENV VNC_PORT=6080

RUN mkdir -p /data/profile

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 17841 = the Responses endpoint 9Router talks to.
# 6080  = noVNC, only needed while signing in.
EXPOSE 17841 6080

# Long start period: the first boot waits for a human to finish sign-in in the
# launcher, and that wait must not be read as a broken deployment.
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/healthz" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
