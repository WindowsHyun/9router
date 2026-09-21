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

## NOT VERIFIED — start here

### 1. Neither image has been built

```bash
docker compose build 2>&1 | tee build.log
docker compose up -d
docker compose logs -f chatgpt-web
```

### 2. Likely failure points, in the order they would bite

**Debian package names.** `docker/chatgpt-web/Dockerfile` installs
`libasound2`. Debian's t64 transition renamed several runtime libraries
(`libasound2t64`, `libcups2t64`). If `apt-get install` fails, read the error
and use the name it suggests. Bookworm should still be pre-t64; trixie is not.

**Electron sandbox.** The entrypoint sets `ELECTRON_DISABLE_SANDBOX=1`. If
Electron still refuses to start ("Running as root without --no-sandbox is not
supported"), either add `--no-sandbox` to the launcher's Electron args, run
the container as a non-root user, or give it `--cap-add=SYS_ADMIN`. Prefer a
non-root user.

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
