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
#
# The library list is not guesswork. It is every entry from
# `readelf -d electron | grep NEEDED` on the real 41.10.7 linux-x64 binary,
# mapped to its bookworm package, minus what glibc provides and libffmpeg.so
# (which ships inside the Electron zip). Nine of them were previously reachable
# only as transitive dependencies of the others — libatspi2.0-0, libdbus-1-3,
# libexpat1, libglib2.0-0, libnspr4, libudev1, libx11-6, libxcb1, libxext6 —
# and a transitive dependency is exactly what disappears under a base-image
# bump. Naming them is the difference between "works today" and "works".
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget unzip git \
      xvfb x11vnc novnc websockify x11-utils \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
      libcups2 libdrm2 libxkbcommon0 libglib2.0-0 libdbus-1-3 libexpat1 \
      libx11-6 libxcb1 libxext6 libx11-xcb1 libxss1 libudev1 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 libgtk-3-0 \
      fonts-liberation fonts-noto-cjk \
      dbus-x11 xauth tini \
    && rm -rf /var/lib/apt/lists/*

# Bun runs the bridge itself. Pinned to the version the repo declares as its
# packageManager — an unpinned installer pulled 1.4.2, whose stricter
# require()-of-ESM behaviour is what broke the Electron postinstall below.
ARG BUN_VERSION=1.4.0
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && bun --version

WORKDIR /opt/codex-chatgpt-web
# A pinned tag, not HEAD: an unpinned bridge would change how routed requests
# behave on every image rebuild.
# Electron's postinstall (electron/install.js) `require()`s @electron/get,
# which is ESM-only since v5. Under bun 1.4.2 that fails outright:
#
#   Error [ERR_REQUIRE_ESM]: require() of ES Module .../@electron/get/dist/index.js
#   from .../electron/install.js not supported
#
# Skipping that script and fetching the binary directly sidesteps the whole
# CJS/ESM question and makes the download deterministic. install.js honours
# this variable with an early return (install.js:14), and electron/index.js
# resolves the binary through ELECTRON_OVERRIDE_DIST_PATH (index.js:11) —
# which is what `electron .` ends up calling, via cli.js requiring './'.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# The renderer is built here, at image build time. The alternative,
# scripts/start-launcher.ts, runs the launcher in Vite dev mode and re-runs
# `bun install` on every container start — which needs network at boot and
# fails without it.
#
# --ignore-scripts on the launcher install belts the env var above: electron is
# the only launcher dependency with a postinstall, and its binary is fetched
# below, so skipping lifecycle scripts there removes the failure entirely
# rather than relying on one variable being honoured.
RUN git clone --depth 1 --branch "${BRIDGE_VERSION}" \
      https://github.com/miuuyy/codex-chatgpt-web . \
    && bun install --frozen-lockfile \
    && bun install --frozen-lockfile --cwd launcher --ignore-scripts \
    && bun run --cwd launcher build

# The browser helper, which `launcher build` does NOT produce — that script is
# only `typecheck && vite build`, i.e. the renderer. The helper is built by its
# own script, which upstream runs from `launcher dev` (scripts/dev.cjs) and
# bundles into resources when packaging.
#
# We run unpackaged, and unpackaged is the branch that looks for it on disk:
#
#   const BROWSER_HELPER_PATH = app.isPackaged
#     ? path.join(process.resourcesPath, "runtime", "app", "browser-helper.cjs")
#     : path.join(SOURCE_ROOT, ".launcher-runtime", "browser-helper.cjs");
#
# Without it the launcher spawns a file that does not exist, and setup step 2
# fails with "Browser helper verification exited with status 1" — which is
# exactly what happened, because the earlier version of this image built only
# the renderer.
#
# `test -f` rather than trusting the exit code: this must not be able to go
# missing quietly a second time.
RUN bun run scripts/build-browser-helper.ts \
    && test -f .launcher-runtime/browser-helper.cjs \
    && echo "browser helper: $(wc -c < .launcher-runtime/browser-helper.cjs) bytes"

# Fetch the Electron the launcher's lockfile actually resolved to, rather than
# a version pinned twice in two places that can drift apart.
RUN set -eu; \
    ELECTRON_VERSION="$(bun -e 'console.log(require("/opt/codex-chatgpt-web/launcher/node_modules/electron/package.json").version)')"; \
    echo "electron ${ELECTRON_VERSION}"; \
    curl -fsSL -o /tmp/electron.zip \
      "https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-x64.zip"; \
    mkdir -p /opt/electron; \
    unzip -q /tmp/electron.zip -d /opt/electron; \
    rm /tmp/electron.zip; \
    chmod +x /opt/electron/electron; \
    /opt/electron/electron --version --no-sandbox

ENV ELECTRON_OVERRIDE_DIST_PATH=/opt/electron

# Prove Electron can actually start here, at BUILD time.
#
# This is the one thing that cannot be settled by reading: whether this image's
# GTK/X/Chromium libraries are complete enough for Electron to come up under
# Xvfb. `electron --version` does not answer it — it never initialises GTK — so
# the smoke app opens a real hidden BrowserWindow instead. A missing library
# fails the build here, with a reason, rather than at 3am in a CrashLoopBackOff.
COPY smoke /opt/smoke
RUN set -eu; \
    Xvfb :98 -screen 0 1024x768x24 -nolisten tcp & \
    xvfb_pid=$!; \
    for _ in $(seq 1 60); do xdpyinfo -display :98 >/dev/null 2>&1 && break; sleep 0.25; done; \
    xdpyinfo -display :98 >/dev/null 2>&1 || { echo "Xvfb never came up"; exit 1; }; \
    DISPLAY=:98 ELECTRON_DISABLE_SANDBOX=1 \
      /opt/electron/electron /opt/smoke --no-sandbox; \
    kill "$xvfb_pid" 2>/dev/null || true

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
