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
| `chatgpt-web` | the ChatGPT Web bridge, built from `docker/chatgpt-web/` | 17841 (internal), 6080 (noVNC, loopback only) |
| `headroom` | optional context compressor, unchanged from upstream | 8787 |

Two providers need something that is not the router itself, and both now ship
with it:

- **claude-cli** runs `claude -p`. `@anthropic-ai/claude-code` is installed
  into the router image at a pinned version.
- **chatgpt-web** talks to a bridge that drives a signed-in chatgpt.com
  session in a real browser.

---

## Verified, and how

| Claim | How it was checked |
|---|---|
| `CLAUDE_CONFIG_DIR` isolates Claude Code accounts | Ran `claude -p` against the default dir (answered) and an empty dir ("Not logged in") |
| A connection's account really is used at request time | Pointed a connection's `configDir` at an empty dir → request failed "Not logged in"; restored it → 200 "PONG" |
| Token accounts work and support multiple accounts | Live API: two token accounts, both reported connected, duplicate token refused with 409 |
| `CLAUDE_CODE_OAUTH_TOKEN` is a real Claude Code input | Found in the shipped binary |
| The bridge's terminal-only setup is macOS-only | Reproduced: `Terminal-only managed Chrome setup currently requires macOS`, with and without `--chrome` |
| The launcher owns the bridge runtime | `launcher/electron/runtime-supervisor.cjs` spawns it; running `cli.ts serve` too would fight for the port |
| `--home` isolates the bridge profile | `doctor --json` against a fresh `--home` reported "Configuration is missing" for that dir only |
| The launcher renderer builds | `bun install --cwd launcher && bun run --cwd launcher build` → `launcher/dist/index.html` |
| `/healthz` is the bridge's health path | `src/server.ts:832`; `/v1/models` exists but may need a session |

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

# 3. sign in to chatgpt.com, once. noVNC is not a Service by design.
kubectl -n <ns> port-forward deploy/nine-router 6080:6080
#   → http://localhost:6080/vnc.html → finish setup → sign in

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

**Finishing setup in the launcher UI.** The one human step is
`http://localhost:6080/vnc.html` → complete setup → sign in to chatgpt.com.
Nobody has driven that UI over noVNC yet. If the launcher expects a native
file dialog or a system keyring, that is where it will show.

**Router build memory.** The router image runs a Next.js production build.
Give Docker at least 4 GB. (A 4 GB heap was enough on a normal filesystem;
it OOM'd only on a OneDrive-synced path, which does not apply inside a
container.)

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

Open `http://localhost:6080/vnc.html` once and sign in. The profile lives in
the `9router-chatgpt-web-profile` volume and survives restarts.

**Port 6080 must stay bound to `127.0.0.1`.** It exposes a signed-in ChatGPT
session with no authentication of its own. If you need it remotely, tunnel it
(`ssh -L 6080:localhost:6080`), do not publish it.

---

## Kubernetes

Compose maps over, with four things that need attention.

**1. The bridge is stateful and single-writer.** The profile is a signed-in
browser session; two replicas would fight over it and get logged out. Run it
as a `StatefulSet` with `replicas: 1` and a PVC at `/data/profile`, or a
`Deployment` with `strategy.type: Recreate`. Never `RollingUpdate` — two pods
would briefly share nothing and you would be signing in again.

**2. Shared memory.** Chromium needs more than the default 64 MB:

```yaml
volumes:
  - name: dshm
    emptyDir: { medium: Memory, sizeLimit: 1Gi }
volumeMounts:
  - { name: dshm, mountPath: /dev/shm }
```

**3. noVNC must not be a Service.** It is an unauthenticated signed-in
session. Do not expose it through an Ingress. Reach it with
`kubectl port-forward` when signing in, and leave it on the pod otherwise.

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
