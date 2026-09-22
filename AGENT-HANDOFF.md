# Handoff: the Docker deployment of the two local providers

Written for whoever picks this up next — a person or an agent. It says what is
verified, what is not, what will most likely break on the first
`docker compose up`, and what Kubernetes would need.

The short version: **the code paths are verified, the container images have
never been built.** There was no Docker daemon on the machine this was written
on. Everything below marked NOT VERIFIED is a real gap, not a formality.

---

## What this deployment is

`docker compose up -d` brings up three services:

| Service | What it is | Ports |
|---|---|---|
| `9router` | the router, **built from this repo** | 20128 |
| `chatgpt-web` | the ChatGPT Web bridge, **headless**, built from `docker/chatgpt-web/` | 17841 (internal), 6080 (sign-in console — idle until used, reached through the router's proxy) |
| `headroom` | optional context compressor, unchanged from upstream | 8787 |

Two providers need something that is not the router itself, and both now ship
with it:

- **claude-cli** runs `claude -p`. `@anthropic-ai/claude-code` is installed
  into the router image at a pinned version.
- **chatgpt-web** talks to a bridge that drives a signed-in chatgpt.com
  session in a real browser — headless, with no desktop resident. See below.

---

## Signing the bridge in — no desktop anywhere

The bridge drives a real chatgpt.com session in a browser: its browser-worker
is ~4,500 lines of Playwright page automation, not an HTTP client. A browser
is not optional. Everything that used to sit around it was.

Earlier versions of this image ran the project's Electron launcher on a
permanent Xvfb, with x11vnc and noVNC beside it, so that a human could log in
once through a remote desktop. That is a second full Chromium and a GUI
resident for the life of the pod, to serve a once-per-account task.

It is unnecessary, because the bridge does not authenticate from a live
browser session — it authenticates from a **stored** one:

```
<CODEX_CHATGPT_WEB_HOME>/browser/storage-state.json          ← Playwright cookies
<CODEX_CHATGPT_WEB_HOME>/browser/storage-state.json.verified.json
```

and a stored session is just cookies. So the dashboard collects them:

1. **Dashboard → ChatGPT Web → paste your session → Connect.**
2. The router normalizes the paste (`parseChatGptWebSession`) and posts it to
   the bridge's session endpoint on 17842.
3. `session-agent.mjs` writes the storage state and then **verifies it** with
   the bridge's own `inspectBrowserLoginCapabilities` — which opens the
   account in a real browser and reads back which models it has. Only then is
   the marker written; on failure both files are deleted.

The verification is the part that matters. Writing cookies to disk and
reporting success would produce a green badge that means nothing.

**What to paste.** The required cookie is `__Secure-next-auth.session-token`,
and it is httpOnly — so `document.cookie` cannot see it. It comes from
devtools (Application → Cookies → https://chatgpt.com) or a cookie extension.
Four shapes are accepted: the bare token value, a `name=value; …` string, a
cookie-extension export, or a full Playwright storage state.

**What is still running.** `bun` for the bridge, one Chromium per session, and
a bare Xvfb. No Electron, no launcher, no x11vnc, no noVNC, no websockify, and
nothing listening for a viewer.

**Why headful.** `headed: true` is hardcoded in the bridge's own
`defaultConfig()`, with no flag to change it and no mention anywhere upstream,
so headless is a path they have never run — both chatgpt.com's bot detection
and the DOM automation are untested there. An X server with no window manager
and no compositor costs tens of megabytes. `BRIDGE_HEADLESS=1` drops it for
anyone who will take that risk.

**Why not upstream's `setup`.** `prepareSetup()` throws off macOS for this
browser host, and that gate is in the setup path only — `serve` is
`loadConfig()` + `startServer()`. So `bootstrap-config.ts` writes config.json
using the bridge's own `defaultConfig()` and `saveConfig()`, keeping the
schema and its validation theirs.

Anyone upgrading from the launcher image gets their config migrated
automatically but **must sign in again**: the launcher kept its session in its
own profile, not as the storage state this reads.


## Verified, and how

| Claim | How it was checked |
|---|---|
| `CLAUDE_CONFIG_DIR` isolates Claude Code accounts | Ran `claude -p` against the default dir (answered) and an empty dir ("Not logged in") |
| A connection's account really is used at request time | Pointed a connection's `configDir` at an empty dir → request failed "Not logged in"; restored it → 200 "PONG" |
| A token account authenticates **as itself** | Live, and the earlier evidence for this was circular — the dashboard called a token account "connected" because a token was present, which says nothing about whether Claude Code uses it. Settled with a deliberately invalid token: `CLAUDE_CODE_OAUTH_TOKEN=<bogus>` returns `401 OAuth access token is invalid` **even with a signed-in config directory present**, so the token wins and each account is its own. An empty config dir with no token says `Not logged in` instead, so the two failures are distinguishable. Both in `tests/real/claude-cli.real.test.js` |
| The executor hands each account the right credential | `buildChildEnv`: a token account gets `CLAUDE_CODE_OAUTH_TOKEN` (and keeps the image's `CLAUDE_CONFIG_DIR`, which the token overrides); a directory account gets its own `CLAUDE_CONFIG_DIR` and no token; no account inherits the image default |
| Two token accounts can coexist | Live API: both reported connected, a duplicate token refused with 409 |
| `CLAUDE_CODE_OAUTH_TOKEN` is a real Claude Code input | Found in the shipped binary |
| The bridge's terminal-only setup is macOS-only | Reproduced: `Terminal-only managed Chrome setup currently requires macOS`, with and without `--chrome` |
| The launcher owns the bridge runtime | `launcher/electron/runtime-supervisor.cjs` spawns it; running `cli.ts serve` too would fight for the port |
| `--home` isolates the bridge profile | `doctor --json` against a fresh `--home` reported "Configuration is missing" for that dir only |
| The launcher renderer builds | `bun install --cwd launcher && bun run --cwd launcher build` → `launcher/dist/index.html` |
| `/healthz` is the bridge's health path | `src/server.ts:832`; `/v1/models` exists but may need a session |
| The sign-in console works on a real Next server | `scripts/fork/check-bridge-console.mjs` — 12/12: boots Next, logs in through the real dashboard endpoint, serves the console, reaches **101 past Next's own live HMR upgrade listener**, round-trips bytes, holds the socket 10 s, and follows the exact URL the card is given |
| The console is shut to anyone without a dashboard session | Same run: anonymous HTTP and anonymous WebSocket both refused. Unit tests add wrong-signature, expired, `alg:none`, not-`authenticated` and not-yet-valid — all 403 |
| The dashboard session never reaches the bridge | Same run: no `Cookie` observed at the bridge on either the HTTP or the WebSocket half |
| The proxy finds the JWT secret the app generated | Same run with no `JWT_SECRET` in the environment — it read `DATA_DIR/jwt-secret`, which is the production path |
| The session agent's assumptions about the bridge hold | Executed against the real v5.0.8 source, 12/12: bun dynamic-imports their TypeScript from a `.mjs` by extensionless path; `loadConfig`, `atomicWriteFile`, `sanitizeBrowserLoginStorageState`, `loginVerificationMarkerPath`, `browserLoginStateExists`, `inspectBrowserLoginCapabilities` and `storedBrowserLoginCapabilities` are all exported; the router's normalized cookies survive their sanitizer; the marker path matches |
| Session verification needs a display even when headless | `inspectStoredState` hardcodes `headless: false`. Found by reading it, not by a failed deploy — so the X server now starts unconditionally, and `BRIDGE_HEADLESS=1` only affects the routed browser |
| "Local only: CLI token required" is fixed for both cards | `scripts/fork/check-container-guard.mjs` — 6/6. **Reproduces it first**: a forwarded request (`X-Forwarded-For`, as an Ingress sends) is refused 403 "Local only" on both card routes. With `KUBERNETES_SERVICE_HOST` set, as every pod has, the same request returns 200 |
| The container path did not simply open the gate | Same run: unauthenticated request still 403 inside a container; a genuinely local request on a plain host still 200, so desktop behaviour is unchanged |

---

## Bringing it up after a code change

Both images must be rebuilt — the fixes are in the image, not in the
manifests. A stale router image is why the provider cards showed
"Local only: CLI token required" even after the guard was fixed.

```bash
# 1. both images
docker compose build 2>&1 | tee build.log

# 2. or, for the Harbor/ArgoCD flow
docker build -t harbor.example.com/library/9router:<tag> .
docker build -t harbor.example.com/library/9router-chatgpt-web:v5.0.8 docker/chatgpt-web
docker push harbor.example.com/library/9router:<tag>
docker push harbor.example.com/library/9router-chatgpt-web:v5.0.8
# then bump the router tag in deployment.yaml and let ArgoCD sync

# 3. sign in to chatgpt.com, once — entirely in the dashboard:
#      ChatGPT Web → paste your session → Connect.
#      The session cookie is __Secure-next-auth.session-token, from devtools
#      (Application → Cookies) or a cookie extension. No kubectl, no console.

# 4. confirm
kubectl -n <ns> exec deploy/nine-router -c chatgpt-web -- \
  curl -fsS http://127.0.0.1:17841/healthz
kubectl -n <ns> exec deploy/nine-router -c nine-router -- claude --version
```

Until step 3 is done, "Bridge offline" is the correct reading, not a bug.

### Running the bridge as a sidecar

Putting it in the router's pod (rather than its own Deployment) is the better
layout and worth keeping: the two containers share a network namespace, so
`CHATGPT_WEB_BASE_URL=http://127.0.0.1:17841` is literally true and no Service
is needed for port 17841 at all.

One thing to fix if you do this: **give the bridge profile its own PVC.** The
router's entrypoint runs `chown -R node:node /app/data` at every start. Share
one PVC between the two and that recursive chown walks a whole browser profile
on every restart — thousands of files — and leaves it owned by `node` while
the bridge runs as root. It still works, but it is slow and surprising.

## NOT VERIFIED — start here

### 1. Neither image has been built

The build chain has been verified piece by piece under the pinned bun, but no
image has been assembled:

| Step | Checked |
|---|---|
| every apt package exists in bookworm | yes, including `libasound2` (bookworm is pre-t64) |
| `bun install --frozen-lockfile --cwd launcher` with the skip flag, under bun 1.4.0 | yes — 334 packages, no `dist/` |
| the Dockerfile's version read (`bun -e require(...).version`) | yes — returns 41.10.7 |
| `bun run --cwd launcher build` | yes — writes `launcher/dist/index.html` |
| the Electron release zip has `electron` at its root | yes |
| `electron/index.js` resolves through `ELECTRON_OVERRIDE_DIST_PATH` | yes |
| the renderer builds with `--ignore-scripts` too | yes |
| every library Electron links against is named in the apt list | yes — from `readelf` on the real binary, run on Linux |
| Electron 41.10.7 linux-x64 starts and creates a window on Linux | **yes — the image's own smoke app, run on Linux, exit 0** |
| the image as a whole | **no** |

**The runtime half is no longer a guess.** There is no Docker on the authoring
machine, but there is a WSL Ubuntu with WSLg, which is enough to download the
exact `electron-v41.10.7-linux-x64` release the image fetches and run the exact
smoke app the build stage runs:

```
unresolved libraries: none
[smoke] Electron started and created a window
exit code: 0
```

So Electron does initialise Chromium and GTK and create a window on Linux
x86-64 — the question that `electron --version` cannot answer. What that run
does not cover is bookworm's library set specifically (WSL is Ubuntu noble)
and Xvfb rather than WSLg as the display. Both are narrow: the package list is
derived from `readelf` and every name was confirmed present in bookworm, and
Xvfb is an ordinary X server.

**The build proves the rest.** A missing GTK/X
library would previously have shown up as a CrashLoopBackOff after deploy.
The image build starts Xvfb and runs a tiny Electron app that opens a real
hidden `BrowserWindow`, so an incomplete runtime fails the build, on your
machine, with a reason. `electron --version` does not test this — it never
initialises GTK. If that layer fails, the missing library is named in the
error and belongs in the `apt-get install` list.

### Already hit and fixed: both provider cards showed only "Local only"

In Kubernetes the Claude Code and ChatGPT Web cards both rendered
`Local only: CLI token required`, the Login button did nothing, and the bridge
read as offline. Three separate causes, all now fixed:

1. **The routes were unreachable.** `/api/cli-tools/claude-cli-settings`,
   `claude-cli-accounts` and `chatgpt-web-settings` are in `LOCAL_ONLY_PATHS`,
   which requires the request to come from loopback. Behind an Ingress it
   never does, so every call was a 403 — the cards could not even read status.

   That gate exists to stop a remote caller making the *operator's desktop*
   spawn processes. In a container there is no desktop behind the routes and
   the dashboard is necessarily remote, so the rule rejected all legitimate
   use and protected nothing that `/api/*` authentication does not already
   cover. It is now container-aware: authentication alone is the gate when
   containerised, and the desktop rule is unchanged everywhere else.

   Detection is `/.dockerenv`, `KUBERNETES_SERVICE_HOST`, or an explicit
   `NINEROUTER_HOST_ROUTES_REMOTE` (`1` forces on, `0` forces off). Set it to
   `1` if you run outside a container but still reach the dashboard remotely
   — bare-metal behind nginx, say.

2. **The bridge card probed the wrong address.** It fell back to the
   `127.0.0.1:17841` default and ignored `CHATGPT_WEB_BASE_URL`, so with the
   bridge as a sibling container it probed the router's own loopback, found
   nothing, and said "Bridge offline" while routing worked. It now defaults to
   the same value routed traffic uses.

3. **Both cards called a failed request "not installed" / "offline".** A 403
   and a genuinely missing binary looked identical, which sent debugging in
   the wrong direction. The HTTP failure is now reported as itself.

### Caught before shipping: Chromium will not run as root

The bridge passes no `--no-sandbox` anywhere on the Linux path — the login
spawns Chrome with `--user-data-dir/--new-window` and nothing else, and the
worker calls `chromium.launch()` with only `executablePath` and
`headless`. The single occurrence in their tree is in the macOS passkey path.
This image runs as root, and Chromium refuses that combination outright.

Neither the login nor a routed request would have worked, and the build would
have been green: the first version of the build check passed `--no-sandbox`
itself, so it tested a configuration that never runs.

Fixed by attaching the flag to the executable rather than to any call site —
`/usr/local/bin/chromium-container` execs Chromium with it, and
`CHROME_EXECUTABLE` points there — which covers both paths without patching
upstream code that an upgrade would overwrite. The build check now passes no
arguments of its own, so it fails unless that wrapper works, and it exercises
headful on a real Xvfb as well as headless.

Running as a non-root user would be better still, and is the obvious next
hardening step; Chromium's own sandbox then needs unprivileged user
namespaces, which plenty of clusters restrict.

### Already hit and fixed: setup step 2, "Browser helper verification exited with status 1"

Reported from a real deployment, after signing in to chatgpt.com succeeded.
Setup step 1 went green and step 2 failed with:

```
Error invoking remote method 'launcher:browser-smoke':
Error: Browser helper verification exited with status 1
```

Nothing to do with the sandbox or a missing library — the file the launcher
spawns was not in the image. `bun run --cwd launcher build` is
`typecheck && vite build`; it builds the **renderer** and nothing else. The
browser helper has its own build script, which upstream runs from
`launcher dev` (`launcher/scripts/dev.cjs`) and bundles into resources when
packaging. This image does neither: it runs unpackaged, and that is the branch
which reads the helper off disk —

```js
const BROWSER_HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "runtime", "app", "browser-helper.cjs")
  : path.join(SOURCE_ROOT, ".launcher-runtime", "browser-helper.cjs");
```

— so it spawned a path that did not exist and the child exited 1 immediately.

The Dockerfile now runs `bun run scripts/build-browser-helper.ts` and asserts
the output exists, so it cannot go missing quietly again. Verified before
committing, against the real v5.0.8 source: the build emits a 163 KB
`.launcher-runtime/browser-helper.cjs` that parses as CJS and leaves
`playwright-core` external — which resolves, because it is a declared root
dependency (1.62.0) with no install scripts, so `bun install --frozen-lockfile`
provides it and nothing downloads a browser.

The bridge runtime itself needs no equivalent fix: unpackaged,
`runtime-command.cjs` resolves it to `bun run src/cli.ts`, and bun is on PATH.

### Already hit and fixed: Electron's postinstall

The first real build failed here, so it is written down rather than left to be
rediscovered:

```
Error [ERR_REQUIRE_ESM]: require() of ES Module
  .../@electron/get/dist/index.js from .../electron/install.js not supported
```

`electron/install.js` is CommonJS and `@electron/get` has been ESM-only since
v5. Bun 1.3.x tolerated the mixed require; 1.4.2 does not, and the unpinned
installer had pulled 1.4.2. (Bun 1.4.0 does not reproduce it, so the version
pin alone would probably have been enough — the skip below makes it moot
either way, which is why both are in place.)

The fix does not try to reconcile the two. It sets
`ELECTRON_SKIP_BINARY_DOWNLOAD=1` so that script returns early
(`install.js:14`), downloads the matching `electron-v<version>-linux-x64.zip`
straight from the GitHub release, and points `ELECTRON_OVERRIDE_DIST_PATH` at
it — which is what `electron/index.js:11` resolves through, and therefore what
`electron .` ends up executing. Bun is pinned to 1.4.0, the version the repo
declares as its packageManager.

Each link was checked: the skip flag leaves a working install with no `dist`
directory, the zip has `electron` at its root, and `cli.js` resolves the
binary via `require('./')` → `index.js`.

### 2. Remaining failure points, in the order they would bite

**Debian package names.** Lower risk than it was. The library list is now
derived from `readelf -d electron | grep NEEDED` on the real 41.10.7 linux-x64
binary rather than guessed, every mapped package was confirmed to exist in
bookworm, and the nine that were previously only transitive are named
explicitly. The remaining exposure is a base-image bump: Debian's t64
transition renames runtime libraries (`libasound2t64`, `libcups2t64`), so
moving off bookworm means re-checking. If `apt-get install` fails, the error
names the package.

**Electron sandbox.** Handled: the entrypoint runs the binary directly with
`--no-sandbox` and sets `ELECTRON_DISABLE_SANDBOX=1`, because the release zip
ships `chrome-sandbox` without the setuid bit and Electron refuses to run as
root otherwise. Running as a non-root user would be better still and is the
obvious next hardening step.

**Xvfb timing.** The entrypoint waits for the display with `xdpyinfo` before
starting Electron. If Electron exits instantly, the display was not up — raise
the retry count in `entrypoint.sh`.

**The session paste.** The one human step is Dashboard → ChatGPT Web → paste
→ Connect. It fails in exactly one interesting way: a session ChatGPT does not
accept, which `session-agent.mjs` reports as such after trying it in a real
browser, having deleted the half-written state. The usual cause is copying
`document.cookie`, which cannot contain the httpOnly session cookie.

**Router build memory.** The Next.js production build is the memory high-water
mark of this image. If `docker build .` dies partway through compiling with:

```
FATAL ERROR: Ineffective mark-compacts near heap limit
Allocation failed - JavaScript heap out of memory
```

that is the builder's heap, not the code. Raise it:
`docker build --build-arg NODE_BUILD_HEAP_MB=8192 .` With too little RAM
actually free the kernel kills the process instead, and you get `Killed`
rather than the message above.

The Dockerfile deliberately sets **no** heap by default, so the image builds
exactly as it did before this knob existed.

*One environment where it cannot build at all, and it is not the fork's
doing.* On a Windows checkout under a OneDrive-synced path, on Node 24
(the image uses `node:22-alpine`), `npm run build` dies at Node's own default
heap (4288 MB there, on a 64 GB machine) **and again at `--max-old-space-size=8192`**,
having climbed to 8170 MB. That is a runaway, not a large build, so raising
the heap does not fix it.

It was isolated properly rather than guessed at: with everything else held
constant — same machine, same Node, same `node_modules`, same cleared
`.next`, same 8 GB heap — **upstream `v0.5.81` with zero fork code OOMs the
same way** (exit 134 after 23 minutes). So the cause is that environment, and
the fork's code is not implicated. Untested there: a non-OneDrive path, and
Node 22.

The practical consequence for anyone working on this repo from such a machine:
a production build cannot be produced locally. That does **not** block
verifying the server, though — `next dev` needs no build, and the wrapper
loads into it through `NODE_OPTIONS=--require`, which the server process Next
forks inherits. That is what `scripts/fork/check-bridge-console.mjs` does.

(Two traps if you write something similar: `NODE_OPTIONS` is parsed
shell-style, so a path containing a space needs quoting and backslashes are
read as escapes — pass forward slashes. And on Windows, spawning `npx.cmd`
without a shell is `EINVAL`; invoke `node node_modules/next/dist/bin/next`
instead.)

### 3. How to tell it worked

```bash
# bridge alive
docker compose exec chatgpt-web curl -fsS http://127.0.0.1:17841/healthz

# router sees it — expect installed/running true once signed in
curl -s http://localhost:20128/api/cli-tools/chatgpt-web-settings \
  -H "x-9r-cli-token: $(…)"    # or just open the dashboard

# claude-cli inside the router image
docker compose exec 9router claude --version
```

In the dashboard, **Providers → ChatGPT Web** and **Claude Code CLI** should
read `N Connected`, never a bare green "Ready" — that badge was removed for
these two precisely because it lied.

---

## Attaching accounts

### Claude Code (in a container)

No terminal, so no interactive login. On any machine that has Claude Code:

```bash
claude setup-token
```

Paste the result into **Providers → Claude Code CLI → Add an account with a
token**. One token per account; 9Router falls back between them.

On a desktop install the interactive path still works: "Add another account"
opens a terminal against a fresh config directory.

### ChatGPT Web

Dashboard → **ChatGPT Web** → paste your chatgpt.com session → **Connect**,
once. The stored session lives in the bridge's profile volume and survives
restarts.

Copy `__Secure-next-auth.session-token` from devtools (Application → Cookies →
https://chatgpt.com) or export cookies with an extension. It is httpOnly, so
`document.cookie` will not show it.

**Neither bridge port may be published.** 17841 carries routed traffic; 17842
accepts a session and is gated by 9Router's own dashboard route in front of
it. Nothing in the bridge container is meant to be reached directly.

**With `requireLogin` off, the console returns 403 — by design.** In that mode
no session cookie is ever minted, and the proxy accepts nothing else. This is
the one route that does not follow the setting, because it is a desktop signed
into a real ChatGPT account. To sign in, enable login, do it once, and turn the
setting back if you want. The 403 body says so.

---

## Kubernetes

Compose maps over, with four things that need attention.

**1. The bridge is stateful and single-writer.** The profile is a signed-in
browser session; two replicas would fight over it and get logged out. Run it
as a `StatefulSet` with `replicas: 1` and a PVC at `/data/profile`, or a
`Deployment` with `strategy.type: Recreate`. Never `RollingUpdate` — two pods
would briefly share nothing and you would be signing in again.

**2. Shared memory, and the trap in it.** Chromium needs more than the default
64 MB:

```yaml
volumes:
  - name: dshm
    emptyDir: { medium: Memory, sizeLimit: 512Mi }
volumeMounts:
  - { name: dshm, mountPath: /dev/shm }
```

**`medium: Memory` is tmpfs, and tmpfs counts against the container's memory
limit.** So a 1Gi `/dev/shm` silently spends 1Gi of the bridge's limit, and
when Chromium fills it the container is OOMKilled with nothing in the logs
explaining why. 512Mi is ample for a single ChatGPT tab and is eight times the
default; raise it only if you see shared-memory errors, and raise the memory
limit with it.

**2b. Sizing the bridge.** The resident set is bun, one Chromium and a bare
Xvfb — rather than Electron plus a launcher GUI plus x11vnc plus websockify
plus a Chromium. A reasonable starting point:

```yaml
resources:
  requests: { cpu: "200m", memory: "512Mi" }
  limits:   { cpu: "2",    memory: "2Gi" }
```

Then measure rather than trust that, because nobody has: **these numbers are
reasoned from the process tree, not observed.**

```bash
kubectl -n <ns> top pod --containers
```

Watch it while a request is in flight, and again during a Connect — verifying
a session opens a second browser briefly, which is the peak.

**3. Neither bridge port may be a Service.** 17842 accepts a chatgpt.com
session and 17841 answers routed requests; both are internal, and 9Router
gates the dashboard route in front of the first. There is no console to
expose any more, and no reason to reach either port from outside the pod.

With the bridge as a **sidecar** (same pod), the proxy reaches it over
loopback with `CHATGPT_WEB_BASE_URL=http://127.0.0.1:17841` and nothing else
to configure. As a **separate Deployment**, point that variable at its
Service; the console port is derived from the same host, so override
`CHATGPT_WEB_VNC_PORT` only if you moved it off 6080.

**3b. WebSocket timeouts on the Ingress.** The console is a long-lived
WebSocket, and ingress-nginx defaults `proxy-read-timeout` to 60 s — an idle
noVNC session dies at exactly one minute, which reads like a broken bridge.
On the router's Ingress:

```yaml
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

Other controllers have an equivalent; Traefik and HAProxy need the same thing
said differently. Untested here — there is no cluster on this machine.

**4. The bridge URL.** Set `CHATGPT_WEB_BASE_URL` to the in-cluster service,
e.g. `http://chatgpt-web.default.svc.cluster.local:17841`. 9Router accepts
loopback, single-label names, `.local`/`.internal`, and RFC1918/CGNAT
addresses, and refuses public hosts and link-local `169.254` (the metadata
service) — see `isPrivateNetworkHost` in `open-sse/config/chatgptWeb.js`. A
`*.svc.cluster.local` name is accepted by the `.local` rule.

Probes:

```yaml
readinessProbe:
  httpGet: { path: /healthz, port: 17841 }
  initialDelaySeconds: 60
  failureThreshold: 30     # the first boot waits for a human to sign in
```

Do not make the router's readiness depend on the bridge — a bridge waiting for
sign-in would take the whole router down with it.

**Router state.** `/app/data` is SQLite. One replica, or move to a shared
database first; several replicas on one RWO PVC will corrupt it.

---

## Things deliberately not done

- **The bridge is not on Docker Hub.** It is built from source against a
  pinned tag (`BRIDGE_VERSION=v5.0.8`) because upstream publishes desktop
  installers, not a container. Bumping the tag needs a rebuild and a re-test.
- **The launcher's browser-host protocol was not re-implemented.** A
  lighter, Electron-free image was possible only by emulating an internal
  protocol that would break on their next release.
- **`DEVIN_PERMISSION_MODE` stays `bypass`** for the Devin provider; the code
  comment explains that the stream hangs on the first tool call otherwise.

---

## Where the pieces live

| Concern | File |
|---|---|
| Bridge image | `docker/chatgpt-web/Dockerfile`, `entrypoint.sh` |
| Router image, Claude Code bundling | `Dockerfile` |
| Service wiring | `docker-compose.yml` |
| User-facing setup | `DOCKER.md` |
| Bridge URL validation | `open-sse/config/chatgptWeb.js` |
| Per-account env for `claude -p` | `open-sse/executors/claude-cli.js`, `open-sse/config/claudeCli.js` |
| Accounts API | `src/app/api/cli-tools/claude-cli-accounts/route.js` |
| Accounts UI | `src/shared/components/ClaudeCliAccountsCard.js` |
| Why noAuth providers can have connections | `src/sse/services/auth.js` (`noAuthRows`) |
| Keeping all of this across an upstream upgrade | `UPGRADE.md`, `scripts/fork/fork-manifest.mjs` |

Run `node scripts/fork/verify-fork.mjs` after any upstream merge. It checks
every integration point listed above and prints the reason each one exists.
