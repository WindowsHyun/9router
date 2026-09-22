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
# itself are untested on it. BRIDGE_HEADLESS=1 takes that risk for routed
# traffic; the default does not. The X server stays either way — verifying a
# session launches its own browser with headless:false hardcoded upstream —
# and with no window manager or compositor it is tens of megabytes.
#
# Signing in does not happen in here at all. Earlier versions of this image
# carried an Electron launcher — a second full Chromium plus a GUI — and then
# x11vnc and noVNC, entirely so that a human could log in once through a remote
# desktop. But the bridge authenticates from a stored Playwright session, and a
# session is cookies: 9Router collects them and posts them to
# session-agent.mjs, which writes the state and verifies it with the browser
# that is already here. Nothing to connect to, nothing to watch.
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
# xvfb only. No x11vnc, no noVNC, no websockify: signing in does not happen
# inside this container any more, so there is nothing here to look at. 9Router
# posts a chatgpt.com session to session-agent.mjs, which verifies it using the
# bridge's own browser. The display exists solely because the bridge runs
# headful.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip git tini \
      chromium \
      fonts-liberation fonts-noto-cjk \
      xvfb x11-utils xauth dbus-x11 \
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

# Chromium refuses to start as root unless --no-sandbox is passed, and this
# image runs as root. The bridge never passes it: the Linux login spawns
# Chrome with --user-data-dir/--new-window and nothing else
# (src/browser-login.ts), and the worker calls chromium.launch() with only
# executablePath and headless. The single --no-sandbox in their tree is in the
# macOS passkey path, which is not this one.
#
# So the flag is attached to the executable instead of to any call site, which
# covers both paths — they both spawn config.chromeExecutablePath — without
# patching upstream code that an upgrade would overwrite. `exec` so Playwright's
# CDP pipe survives, "$@" so --user-data-dir and the rest pass through.
#
# The sandbox is dropped rather than worked around because the container is
# already the isolation boundary. Running as a non-root user would be better
# and is the obvious next hardening step, but Chromium's own sandbox then needs
# unprivileged user namespaces, which plenty of clusters restrict.
RUN printf '#!/bin/sh\nexec %s --no-sandbox "$@"\n' "${CHROME_EXECUTABLE}" \
      > /usr/local/bin/chromium-container \
    && chmod +x /usr/local/bin/chromium-container \
    && /usr/local/bin/chromium-container --version

ENV CHROME_EXECUTABLE=/usr/local/bin/chromium-container

# Prove, at build time, that Playwright can actually drive this image's browser
# — in both modes, on a real display for the headful one, which is the default.
# `chromium --version` does not answer that: it never starts the browser
# process tree, so a missing library, a blocked syscall or a refusal to run as
# root all still pass it.
#
# The check deliberately passes no --no-sandbox of its own, so it only succeeds
# if the chromium-container wrapper supplies it — which is exactly the thing
# that would otherwise fail at runtime and nowhere else.
COPY smoke/browser-check.mjs /opt/smoke/browser-check.mjs
RUN set -eu; \
    Xvfb :98 -screen 0 1280x800x24 -nolisten tcp & \
    xvfb_pid=$!; \
    for _ in $(seq 1 60); do xdpyinfo -display :98 >/dev/null 2>&1 && break; sleep 0.25; done; \
    xdpyinfo -display :98 >/dev/null 2>&1 || { echo "Xvfb never came up"; exit 1; }; \
    DISPLAY=:98 bun /opt/smoke/browser-check.mjs; \
    kill "$xvfb_pid" 2>/dev/null || true

# NOT /tmp: the bridge refuses to set up when its own runtime path looks
# ephemeral ("Runtime command must not reference an ephemeral path").
ENV CODEX_CHATGPT_WEB_HOME=/data/profile
ENV BRIDGE_PORT=17841
ENV SESSION_PORT=17842
# Headful on a bare Xvfb by default. Headless is a mode the bridge upstream
# never runs, never exposes and never documents, so both chatgpt.com's bot
# detection and the bridge's own DOM automation are untested there. Set
# BRIDGE_HEADLESS=1 runs the *routed* browser headless and takes that risk. It
# does not drop the X server: session verification launches a browser with
# headless:false hardcoded upstream, so without a display the bridge could
# never be signed in at all.
ENV BRIDGE_HEADLESS=

RUN mkdir -p /data/profile

# Run by bun, not node: bun is already here for the bridge, and adding the
# nodejs package purely to run two small scripts would put a second JavaScript
# runtime in an image whose whole point is being smaller.
COPY bootstrap-config.ts /opt/bootstrap-config.ts
COPY session-agent.mjs /opt/session-agent.mjs
COPY tcp-forward.mjs /opt/tcp-forward.mjs
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 17841 = the Responses endpoint 9Router talks to.
# 17842 = the session endpoint 9Router signs in through.
# Neither is published outside the deployment.
EXPOSE 17841 17842

# Short start period: `serve` comes up immediately now — it no longer waits for
# a launcher to boot a desktop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/healthz" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
