# Handoff: the Docker/Kubernetes deployment of the Claude Code CLI provider

What this fork adds to a deployment, what has actually been verified, and what
has not. Written for whoever picks this up next, including me.

## What this deployment is

One provider that upstream does not have:

**Claude Code CLI (`claude-cli`)** routes through the `claude` binary running in
the router's own container — no API key, and no OAuth token replayed by this
server. One account is one Claude Code identity. On a desktop that is a config
directory; in a container it is a token from `claude setup-token`, which is the
only kind that works there because the interactive login needs a terminal.
Several accounts work side by side with per-account fallback, and each can carry
a cron keepalive that runs `claude -p` as that account.

The router image bundles Claude Code, so nothing extra has to be installed.

### There is no ChatGPT Web provider

There was one. It was removed after it turned out not to work as a routed
provider at all — see FORK-CHANGELOG.md for the full reasoning. The short
version: the codex-chatgpt-web bridge requires the Codex CLI's own turn metadata
on every request and deliberately refuses to accept environment context from a
raw Responses request, so a proxy in front of it cannot satisfy it. All 47
published bridge tags behave this way.

**Do not re-add it by pinning an older bridge.** That was checked; there is no
such version.

## Adding an account

Entirely in the dashboard — no kubectl, no console:

1. On a machine that has Claude Code, run `claude setup-token`.
2. Dashboard → Providers → Claude Code CLI → paste it under "Add an account with
   a token".
3. Press Check. It reports the account's email and plan when Claude accepted the
   token, and says the token was refused when it did not.

The card is reachable in a container because the loopback restriction on these
routes is lifted when 9Router detects `/.dockerenv` or
`KUBERNETES_SERVICE_HOST`. Dashboard authentication still applies — that is what
`scripts/fork/check-container-guard.mjs` covers.

## Verified, and how

Run these from the repo root. The ones that drive a server take a few minutes
each and need their port free.

| check | what it proves |
|---|---|
| `node scripts/fork/verify-fork.mjs` | every fork file is present, the registry loads, the fork's own tests pass |
| `node scripts/fork/check-claude-accounts.mjs` | the accounts route against a real Next server: add a token account, Check it, schedule a keepalive, and confirm it reaches the quota tracker (27/27) |
| `node scripts/fork/check-container-guard.mjs` | the container relaxation does not become an open door |
| `node scripts/fork/check-quota-view.mjs` | the quota tracker in real Chromium, both views (12/12) — needs a production build and `playwright-core` |
| `node scripts/fork/check-k8s-manifests.mjs <dir>` | the Kubernetes bundle parses and keeps its constraints (21/21) |

Against upstream v0.5.85 the full suite runs 2952 tests with the same failure
set as upstream itself — judge regressions that way, not by a raw count.

`check-quota-view.mjs` runs `next start`, not `next dev`, on purpose:
`custom-server.js` rejects the dev HMR upgrade, so under `next dev` the client
never hydrates and every control on the page is inert. A UI check written
against `next dev` measures nothing.

## Bringing it up after a code change

```bash
TAG=0.5.85-<sha>
H=harbor.thisisserver.com/library
docker build -t $H/9router:$TAG .
docker push $H/9router:$TAG
# then bump the router tag in deployment.yaml and let ArgoCD sync
```

If the build dies with `heap out of memory` or `Killed`, the builder's heap is
the problem, not the code: add `--build-arg NODE_BUILD_HEAP_MB=8192`, and make
sure the host actually has that much free.

## Kubernetes constraints that must not be undone

`strategy: Recreate` with `replicas: 1` is **required**, not a preference. Every
volume in the bundle is ReadWriteMany (NFS), so Kubernetes will mount the same
one into two pods at once — a RollingUpdate does not stall here, it overlaps.
Two processes writing `/app/data/db/data.sqlite` over NFS corrupts it: SQLite's
locking needs POSIX advisory locks that NFS does not reliably provide, and the
pure-JS `sql.js` fallback rewrites the whole file, so the second pod would
silently discard the first pod's writes.

The cost is a short gap on each deploy. The `startupProbe` keeps it as small as
it can be without giving up single-writer state; it replaced a fixed
`initialDelaySeconds` that was waited out even when the server was already
listening.

`check-k8s-manifests.mjs` fails if either is reverted.

## Not verified

- **No image has been built from this tree on the machine that wrote it.** The
  production `next build` completes, but `docker build` has not been run here.
- **No cluster has been reached.** The Kubernetes bundle is checked statically.
