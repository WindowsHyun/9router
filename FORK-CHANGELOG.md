# Fork changelog

Changes carried by this fork on top of upstream `decolua/9router`.

Kept out of the upstream `CHANGELOG.md` on purpose: upstream rewrites the top of
that file on every release, so an entry there would conflict on 100% of upgrades.
See [UPGRADE.md](UPGRADE.md) for how the fork is carried forward.

## Unreleased (on top of v0.5.85)

### Features

#### Claude Code CLI: the prompt cache survives across turns (`CLI_CLAUDE_SESSION_CACHE=1`, off by default)

Every turn of a conversation through `claude-cli` used to reprocess the whole
history: only the system prompt was ever read back from cache. The cause,
measured on 2.1.281 with the real binary against a local stand-in for the API:
replaying a conversation through `--input-format stream-json` folds the
`shouldQuery: false` history into the newest user turn — the assistant turn
goes first, every earlier question arrives inside the newest turn behind the
CLI's reminders — so the prefix differs from the previous request's at the
first message.

With the flag on, each conversation continues its own Claude Code session:
the first turn runs as today under `--session-id`, and a turn whose history is
exactly what this server answered last time runs `--resume <id>` with the
newest turn alone. The CLI rebuilds the conversation from its own session file
and the request repeats the previous one through the CLI's own breakpoint.
Still `claude -p`, still the CLI's own auth and request — no relay, no
base-URL override, nothing rewritten.

Measured live on haiku through the whole server, three turns each:

| path | turn 2 read back | turn 3 read back |
|---|---|---|
| today (flag off) | 6,424 of 8,120 (the system prompt) | 6,424 of 9,484 |
| session cache | 8,138 of 8,148 | 9,577 of 9,587 |

- A conversation this server has not answered before — a history that
  arrived from elsewhere, or the first turn after a restart — is written as a
  transcript and resumed, so the model sees the history in order. Without
  this (and on today's path with the flag off) the CLI folds every earlier
  question into the newest turn, assistant turns first, and the model
  re-answers them; measured live, "And of Korea?" after Paris/Tokyo now
  answers "Seoul." alone.
- A turn that ended by proposing a tool call is never continued: under
  `--permission-mode dontAsk` the CLI closes that call in its own transcript
  with a denial, and a resumed turn carrying the client's real result for the
  same id is dropped (measured). The tool-result turn runs the fresh replay,
  which pairs it correctly. So this helps chat-style conversations — a text
  answer followed by the next question — and does little for tool loops.
- A resume whose session is gone is answered in full by a fresh run within the
  same request, as long as nothing has reached the client yet.
- Sessions are kept in the account's `<config>/projects/` and deleted when
  their entry expires (15 minutes; the cache itself lasts five). A previous
  process's leftovers are cleared on first use, only in this provider's own
  marked directories.
- `usage.prompt_tokens_details.cached_tokens` / `cache_creation_tokens` are now
  reported, and the quota card says what share of each account's prompt came
  from cache — a cache that stops hitting fails silently otherwise.
- `CLI_CLAUDE_UPSTREAM_OVERRIDE` (loopback only, test harnesses only) points the
  child at `scripts/fork/lib/fake-anthropic.mjs`, so all of this can be checked
  without spending subscription usage: `scripts/fork/check-claude-cli-cache-offline.mjs`,
  `scripts/fork/check-claude-cli-resume-cache.mjs --offline`.
- The cache relay (`CLI_CLAUDE_CACHE_RELAY`) is superseded and stays off: it
  answers, but cannot make a folded replay's prefix recur.

Known and not changed here: with the flag off, and on the first turn of a
session, the replayed history still reaches the model folded as above. See
docs/fable/2026-09-24-claude-cli-prompt-cache-design.md.

### Removed

#### The ChatGPT Web provider, and its bridge container

Removed after it was found not to work at all as a routed provider, and it had
been shipped in a state where connecting succeeded and every request then
failed.

The codex-chatgpt-web bridge is built for the Codex CLI specifically, not for a
proxy in front of it. Every request must carry Codex's own turn metadata —
`client_metadata["x-codex-turn-metadata"]` with `turn_id`/`thread_id`, a
current-turn user message owning that `turn_id`, and a trusted
`<environment_context>` naming cwd, absolute roots and a sandbox mode. Without
it the bridge throws before doing anything:

    ChatGPT web requires native Codex turn_id metadata for browser-turn retry budgeting

This is not a missing field that could be filled in. `trustedEnvironmentText()`
deliberately refuses to read environment context out of a raw Responses request
at all — its own comment says parsed system text "has already lost the wire
provenance needed to distinguish Codex context from user-authored XML, so it
must never become filesystem authority". Supplying it from a proxy is the exact
thing that check exists to prevent.

All 47 published bridge tags were checked, down to the first release: every one
of them requires `turn_id`. There is no version to pin to.

What went with it: the provider registry entry and executor, the session and
settings routes, the bridge card, the connection mirror, the Docker image under
`docker/chatgpt-web/`, the compose service, the Kubernetes sidecar and its PVC,
and the checks that covered them. `docker/router-entrypoint.sh` went too — it
existed only to keep the router's recursive chown off the browser profile — so
the runtime entrypoint is upstream's again and that Dockerfile hunk stops being
a merge conflict.

The Claude Code CLI provider is unaffected.

## Earlier, on top of v0.5.81

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

**ChatGPT Web** — a sidecar container runs the bridge with **no Electron and
no VNC at all**: the worker launches Chromium itself on a bare Xvfb, with no
launcher GUI, window manager or compositor.

You sign it in from the dashboard by pasting your chatgpt.com session, which
the bridge stores and then verifies by opening the account in its own browser.
The bridge authenticates from a stored Playwright session rather than a live
one, so a remote desktop was never actually required — earlier versions of
this image shipped an Electron launcher, and then Xvfb + x11vnc + noVNC,
resident permanently for a once-per-account login. (`BRIDGE_HEADLESS=1`
removes the X server too, but is not the default — upstream never runs
headless, so bot detection and the DOM automation are untested there.)

The session persists in a volume, so this is a once-per-account step. What it
replaced, in order: a Login button that called `open` server-side — which
opens a browser on the machine running Node, and so did nothing at all in a
container — then an Electron launcher on a permanent Xvfb with x11vnc and
noVNC, and finally an on-demand version of that same console.

Upstream's terminal setup is not used because `prepareSetup()` gates it on
macOS (*"Terminal-only managed Chrome setup currently requires macOS"*). That
gate is in the setup path only, so the image writes config.json with the
bridge's own `defaultConfig()` and `saveConfig()` instead.

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
