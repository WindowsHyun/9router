# ChatGPT Web bridge — no Electron, no launcher, no resident VNC.
#
# The bridge drives a real chatgpt.com session in a browser (its browser-worker
# is ~4,500 lines of Playwright page automation, not an HTTP client), so a
# browser is not optional. An Electron launcher, a desktop GUI and a permanent
# VNC stack were.
#
# This image runs the bridge's `managed-chrome` host, where the worker launches
# Chromium itself:
#
#   src/adapters/chatgpt-web/browser-worker.ts
#     this.browser = await chromium.launch({
#       executablePath: this.config.chromeExecutablePath,
#       headless: !this.config.headed, ...
#
# It runs headful on a bare Xvfb. Headless would save a little more, but
# `headed: true` is hardcoded in the bridge's own defaultConfig() with no flag
# to change it and no mention anywhere upstream — so headless is a path they
# have never run, and both chatgpt.com's bot detection and the DOM automation
# itself are untested on it. BRIDGE_HEADLESS=1 takes that risk; the default
# does not. An X server with no window manager and no compositor is tens of
# megabytes.
#
# The earlier version of this image ran the Electron launcher — a second full
# Chromium plus a GUI — on that same Xvfb, with x11vnc and noVNC resident
# beside it, purely so a human could sign in once. That is what made the pod
# heavy. Signing in still needs a visible browser, so the VNC tools remain
# installed, but login-agent.mjs starts them only when the console is opened
# and stops them afterwards.
#
# Why not upstream's terminal setup: `prepareSetup()` throws off macOS for this
# host ("Terminal-only managed Chrome setup currently requires macOS"). That
# gate is in the setup path only — `serve` is just loadConfig() + startServer()
# — so this image writes config.json with the bridge's own defaultConfig()
# instead of running setup. See bootstrap-config.ts.

FROM debian:bookworm-slim

ARG BRIDGE_VERSION=v5.0.8
ARG APT_MIRROR_HOST=deb.debian.org
ARG DEBIAN_FRONTEND=noninteractive
# Debian's chromium (150.x in bookworm). Overridable if you would rather point
# at Google Chrome from its own repository.
ARG CHROME_EXECUTABLE=/usr/bin/chromium

RUN if [ "$APT_MIRROR_HOST" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR_HOST}|g" /etc/apt/sources.list.d/debian.sources; \
    fi

# chromium's .deb declares its own library dependencies, so unlike the Electron
# zip there is no hand-maintained list here to drift.
#
# xvfb/x11vnc/novnc/websockify are for the one-time sign-in only. They are
# installed, not started: login-agent.mjs brings them up on demand and stops
# them when the login finishes or the console goes idle.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip git tini \
      chromium \
      fonts-liberation fonts-noto-cjk \
      xvfb x11vnc novnc websockify x11-utils xauth dbus-x11 \
    && rm -rf /var/lib/apt/lists/* \
    && ${CHROME_EXECUTABLE} --version

ARG BUN_VERSION=1.4.0
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && bun --version

WORKDIR /opt/codex-chatgpt-web

# A pinned tag: an unpinned bridge would change how routed requests behave on
# every rebuild.
#
# Only the root install — no `launcher` install, no launcher build, no Electron
# download and no browser-helper bundle. All of those existed to run the
# launcher, and nothing here runs the launcher. (That also removes the
# ERR_REQUIRE_ESM failure in Electron's postinstall under bun, since the
# postinstall no longer happens at all.)
RUN git clone --depth 1 --branch "${BRIDGE_VERSION}" \
      https://github.com/miuuyy/codex-chatgpt-web . \
    && bun install --frozen-lockfile

ENV CHROME_EXECUTABLE=${CHROME_EXECUTABLE}

# Prove, at build time, that Playwright can actually drive the Chromium in this
# image — headless, which is how it runs in steady state. `chromium --version`
# does not answer that: it never starts the browser process tree. A missing
# library or a seccomp problem fails the build here, with a reason, instead of
# at 3am in a CrashLoopBackOff.
COPY smoke/headless-check.mjs /opt/smoke/headless-check.mjs
RUN bun /opt/smoke/headless-check.mjs

# NOT /tmp: the bridge refuses to set up when its own runtime path looks
# ephemeral ("Runtime command must not reference an ephemeral path").
ENV CODEX_CHATGPT_WEB_HOME=/data/profile
ENV BRIDGE_PORT=17841
ENV VNC_PORT=6080
# Console teardown after this many seconds with nobody connected.
ENV LOGIN_IDLE_TIMEOUT_SEC=900
# Headful on a bare Xvfb by default. Headless is a mode the bridge upstream
# never runs, never exposes and never documents, so both chatgpt.com's bot
# detection and the bridge's own DOM automation are untested there. Set
# BRIDGE_HEADLESS=1 to drop the X server entirely and take that risk; the
# sign-in console works either way.
ENV BRIDGE_HEADLESS=

RUN mkdir -p /data/profile

# Run by bun, not node: bun is already here for the bridge, and adding the
# nodejs package purely to run two small scripts would put a second JavaScript
# runtime in an image whose whole point is being smaller.
COPY bootstrap-config.ts /opt/bootstrap-config.ts
COPY login-agent.mjs /opt/login-agent.mjs
COPY tcp-forward.mjs /opt/tcp-forward.mjs
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 17841 = the Responses endpoint 9Router talks to.
# 6080  = the sign-in console, served by login-agent and idle until used.
EXPOSE 17841 6080

# Short start period: `serve` comes up immediately now — it no longer waits for
# a launcher to boot a desktop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/healthz" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
