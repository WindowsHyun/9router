# Docker

Run 9Router in a container. Published image: [`decolua/9router`](https://hub.docker.com/r/decolua/9router) — multi-platform `linux/amd64` + `linux/arm64`.

---

# 👤 For Users

## Quick start

`docker run` gives you the router on its own. **`docker compose up` gives you the
router plus the two providers that need something installed locally** — Claude
Code and the ChatGPT Web bridge — which is what most people want:

```bash
cp .env.example .env     # set JWT_SECRET; see the notes in that file
docker compose up -d
```

> First run builds two images and takes several minutes: the router (so Claude
> Code is inside it — the published image is upstream's and has no Claude Code)
> and the bridge (Chromium, Electron and a virtual display). Give Docker at
> least 4 GB of memory for the router's Next.js build.

Open http://localhost:20128.

Router only, no local providers:

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  --name 9router \
  decolua/9router:latest
```

App listens on port `20128`. Open: http://localhost:20128

---

## Reaching the provider cards remotely

The Claude Code and ChatGPT Web cards drive routes that are normally
restricted to loopback, because on a desktop they can spawn a process or open
a window. In a container that restriction only gets in the way — there is no
desktop behind them — so it is lifted automatically when 9Router detects
`/.dockerenv` or `KUBERNETES_SERVICE_HOST`. Dashboard authentication still
applies.

If you run 9Router outside a container but reach the dashboard from another
machine, set it explicitly:

```yaml
    environment:
      NINEROUTER_HOST_ROUTES_REMOTE: "1"
```

`0` forces the loopback rule back on.

---

## The two local providers

### Claude Code CLI — bundled in the image

`@anthropic-ai/claude-code` is installed in the image, so the **claude-cli**
provider works with nothing else to install. It runs `claude -p` instead of
replaying OAuth tokens, which is the point: traffic looks like an ordinary
Claude Code session.

The container has no terminal for the sign-in TUI, so an account is attached
with a token instead. On any machine that already has Claude Code:

```bash
claude setup-token          # prints a long-lived token
```

Then in the dashboard: **Providers → Claude Code CLI (-p) → Claude Code
accounts → paste the token**. Add several tokens for several accounts;
9Router falls back between them like any other provider.

> Each account is one token (in a container) or one Claude Code config
> directory (on a desktop). Both are per-connection, so accounts never share
> credentials.

### ChatGPT Web — a sidecar container

The bridge drives a real chatgpt.com session in a browser, but it runs that
browser **headless** — no desktop, no X server, no VNC while it is working.

```bash
docker compose up -d        # builds the bridge image on first run (a few minutes)
```

Then, **once**:

1. Open the dashboard → **ChatGPT Web bridge** → **Login**
2. Sign in to chatgpt.com in the window that appears
3. **Close that browser window.** Closing it is what stores the session — the
   bridge captures it when the browser exits. Closing the tab instead saves
   nothing.

The session is kept in the `9router-chatgpt-web-profile` volume and the card
flips to **Signed in** by itself. The temporary X server and console that
appeared for step 2 shut down on their own afterwards, so they cost nothing
while you are not signing in.

9Router reaches the bridge at `http://chatgpt-web:17851` over the compose
network — 17851, not 17841, because the bridge pins its own listen address to
`127.0.0.1` and a sibling container cannot reach that; `BRIDGE_PUBLISH_PORT`
forwards it. (In Kubernetes the bridge is a sidecar sharing the router's
network namespace, so there it is plain `http://127.0.0.1:17841` with no
forwarder.) The sign-in console is served through the router's own origin at
`/api/cli-tools/chatgpt-web-vnc`, behind your dashboard login.

Port `6080` is bound to `127.0.0.1` on purpose: the console has no
authentication of its own, so it must not be reachable from the rest of your
network. Opening it directly is a debugging fallback; the dashboard's Login
button is the normal path.

**Already running the desktop launcher on your host?** Skip the sidecar and
point the router at it instead:

```yaml
    environment:
      CHATGPT_WEB_BASE_URL: http://host.docker.internal:17841
```

9Router accepts any loopback, container or private-network address for the
bridge and refuses public ones, so the session cannot leave your network.


## Manage container

```bash
docker logs -f 9router        # view logs
docker stop 9router           # stop
docker start 9router          # start again
docker rm -f 9router          # remove
```

## Data persistence

```bash
-v "$HOME/.9router:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.9router/` (macOS/Linux) or `%APPDATA%\9router\` (Windows). In the container, `DATA_DIR=/app/data` makes the bind mount work.

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.9router/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

## Optional env vars

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name 9router \
  decolua/9router:latest
```

## Optional Headroom sidecar

The 9Router image does not bundle Python or Headroom. To use Headroom in Docker, run it as a separate service and point 9Router at that proxy:

```yaml
services:
  9router:
    image: decolua/9router:latest
    ports:
      - "20128:20128"
    volumes:
      - "$HOME/.9router:/app/data"
    environment:
      DATA_DIR: /app/data
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "8787:8787"
```

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the URL is `http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use `http://host.docker.internal:8787` on macOS/Windows. On Linux, add `--add-host=host.docker.internal:host-gateway` or the equivalent compose `extra_hosts` entry.

## Update to latest

```bash
docker pull decolua/9router:latest
docker rm -f 9router
# re-run the quick start command
```

---

# 🛠 For Developers

## Build image locally (test)

```bash
cd app && docker build -t 9router .

docker run --rm -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  9router
```

## Publish (automatic via CI)

Push a git tag `v*` → GitHub Actions builds multi-platform (amd64+arm64) and pushes to:
- `ghcr.io/decolua/9router:v{version}` + `:latest`
- `decolua/9router:v{version}` + `:latest`

```bash
# Use scripts/release.js (recommended)
node scripts/release.js "Release title" "Notes"

# Or manually
git tag v0.4.x && git push origin v0.4.x
```

Workflow: `app/.github/workflows/docker-publish.yml`
