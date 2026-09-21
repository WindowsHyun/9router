# Fork changelog

Changes carried by this fork on top of upstream `decolua/9router`.

Kept out of the upstream `CHANGELOG.md` on purpose: upstream rewrites the top of
that file on every release, so an entry there would conflict on 100% of upgrades.
See [UPGRADE.md](UPGRADE.md) for how the fork is carried forward.

## Unreleased (on top of v0.5.81)

### Features

#### One install brings the local providers with it

Both providers that depend on something outside 9Router now ship with the
Docker deployment, so `docker compose up -d` is the whole setup.

**Claude Code CLI** — `@anthropic-ai/claude-code` is installed in the image
(pinned). A container has no terminal for the sign-in TUI, so accounts are
attached with a token from `claude setup-token`, pasted into the dashboard.
Several tokens means several accounts, and 9Router falls back between them.
On a desktop the interactive login still works and each account keeps its own
Claude Code config directory.

**ChatGPT Web** — a sidecar container runs the bridge **headless**: the worker
launches Chromium itself with `headed: false`, so there is no desktop, no X
server and no VNC in steady state. Press **Login** in the dashboard once and a
temporary sign-in console starts on demand (`login-agent.mjs`), served through
the router's own origin behind your dashboard session
(`bridge-vnc-proxy.cjs`); sign in, close the browser window, and the console
shuts itself down. The session persists in a volume.

Two things this replaced: a Login button that called `open` server-side —
which opens a browser on the machine running Node, and so did nothing in a
container — and an Electron launcher on a permanent Xvfb/x11vnc/noVNC stack,
which was a second Chromium and a GUI resident forever for a once-per-session
login. This is the launcher rather than
the bun CLI because upstream gates terminal-only setup on macOS
(`src/setup.ts`: *"Terminal-only managed Chrome setup currently requires
macOS"*) unless the browser is launcher-owned.

Also fixed along the way:

- A `noAuth` provider now uses its real connection rows when it has any.
  Upstream returned one synthetic "Public" connection and never looked, which
  is why multi-account never worked for either provider.
- The green **Ready** badge no longer appears for a provider that needs local
  setup — it shows "N Connected" or "No connections" like everything else.
- The bridge URL may be a container or private-network address, not only
  loopback. Public hosts and link-local (169.254, the cloud metadata service)
  are still refused.


#### Agent Skills (new)

A **Skills** menu entry now installs third-party `SKILL.md` documents from
GitHub and toggles each one on or off. An enabled skill is appended to the
system prompt of every routed request, translated into whatever wire format
the chosen provider speaks — so the same skill works on Claude, Gemini, Kiro
and any OpenAI-compatible provider.

- Paste a repo URL (`github.com/owner/repo`), a blob link, or a raw
  `SKILL.md` link. A repo publishing several skills asks which one.
- YAML frontmatter supplies the name, description and license; it is stripped
  from the injected text, since it is runtime metadata the provider cannot act on.
- The document body is stored in SQLite, so a routed request never depends on
  GitHub being reachable. "Re-fetch" pulls a newer version on demand.
- Each skill shows its size and estimated token cost, and the card totals what
  the enabled set adds to every request — a skill costs tokens rather than
  saving them, which is worth seeing next to Token Saver.
- Skills install **disabled**; enabling one is a separate, deliberate action.
- Only `github.com` and `raw.githubusercontent.com` are accepted, and every
  fetch goes through the SSRF guard.

Verified against `ayghri/i-have-adhd` (~1,697 tok) and `epoko77-ai/im-not-ai`
(multi-skill repo, prompts for a choice).

- **ChatGPT Web** (`chatgpt-web` / `cgw`): new provider that routes through the
  [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) bridge, turning a signed-in
  chatgpt.com session into an OpenAI Responses endpoint. Sign-in happens inside the bridge's own
  window; the provider page shows daemon health, the models that session exposes, and a Login
  button. Endpoint comes from `CHATGPT_WEB_BASE_URL` (loopback only); loopback traffic bypasses
  the outbound proxy.
- **Claude Code CLI** (`claude-cli` / `ccli`): new provider that spawns the local `claude -p`
  binary instead of replaying an OAuth token from the server, which is what makes the plain
  `claude` provider a ban risk. Runs with `--tools ""`, `--setting-sources ""` and
  `--strict-mcp-config`, so host hooks, CLAUDE.md and MCP servers never reach a routed request;
  streams `stream-json` back as OpenAI chunks. Text/reasoning only — tool calling is not bridged.
- **Auto-ping cron**: quota auto-ping gains cron schedules — several expressions per connection,
  an IANA timezone (validated on save), a custom message (default "Only Hi"), and an optional
  `via: "cli"` mode that sends the keepalive through the Claude Code CLI. Schedules fire
  independently of the reset-based ping, skip an exhausted window, and dedupe per minute across
  restarts. The CLI keepalive is bounded by its own timeout so a hung child cannot stall the tick.

### Hardening

Found by review before this ever ran in anger; all covered by regression tests.

- **Claude Code CLI**: `max_turns` from the request body is clamped to a bounded integer before it
  can reach argv, and `--model` is regex-validated and may not begin with `-`. Nothing is spawned
  through a shell any more: a Windows `.cmd`/`.bat` shim is resolved to its package entry point and
  run with the server's own Node, or the request is refused — cmd.exe has no usable argument
  escaping, so routing argv through it was an injection surface.
- **Claude Code CLI**: the child receives an allowlisted environment instead of a copy of
  `process.env`, so a routed request's subprocess no longer sees `JWT_SECRET`, `API_KEY_SECRET` or
  any stored provider key. Host paths and child stderr stay in the server log, not in the response.
- **Claude Code CLI**: concurrency is capped (default 4, `CLI_CLAUDE_MAX_CONCURRENCY`) behind a
  FIFO queue — each request spawns a ~230 MB interpreter. Deterministic failures return a real HTTP
  status instead of a 200 carrying an error frame, so account/combo fallback engages and
  Claude-format clients are not left with a silent empty stream.
- **Claude Code CLI**: cancelling the response body kills the child instead of leaking it and
  throwing from a stdout listener; usage rides the finish chunk so the estimator no longer wins and
  over-reports every request.
- **ChatGPT Web**: the bridge endpoint is validated as a loopback http(s) origin everywhere it is
  used, and `/api/cli-tools/chatgpt-web-settings` no longer fetches or opens a caller-supplied URL
  (SSRF). Both new `cli-tools` routes are registered localhost-only, next to the other routes that
  spawn processes or read host state, and the version probe uses `execFile` rather than a shell.

### Fixes

- **Non-streaming clients of forced-stream providers** (shared, affects upstream providers too):
  `handleForcedSSEToJson` converted the folded body to the caller's shape only for the Responses
  API, so a Claude-format caller (`/v1/messages`, `stream:false`) received an OpenAI
  `chat.completion` object it cannot parse. It now reuses the shared non-streaming translator.
  Applies to every `forceStream` provider (opencode, zed, codebuddy, …); OpenAI and Responses
  callers are byte-identical to before. **Candidate to upstream.**
- **Claude Code CLI**: a request with no system message inherited Claude Code's own agent prompt —
  measured 8,385 prompt tokens against 429 for the same one-line request, plus a coding-agent
  persona. An explicit system prompt is now always sent.
- **ChatGPT Web**: the routed endpoint comes from `CHATGPT_WEB_BASE_URL`. A noAuth provider gets a
  synthetic connection, so the per-connection override could never reach routing; the card now says
  its field only drives the status probe. An unusable endpoint returns an error response instead of
  throwing out of the executor.
