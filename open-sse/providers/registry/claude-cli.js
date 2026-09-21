/**
 * Claude Code CLI (`claude -p`)
 *
 * Runs the locally installed Claude Code binary instead of replaying OAuth
 * tokens against api.anthropic.com. Traffic is indistinguishable from an
 * ordinary Claude Code session, which is the point: the `claude` provider
 * carries a ban risk this one avoids.
 *
 * noAuth — credentials come from whatever `claude` is already logged into.
 * Text/reasoning only: the CLI's built-in tools are disabled and client tools
 * are not bridged (see executors/claude-cli.js).
 */
import { CLAUDE_CLI_BASE_URL } from "../../config/claudeCli.js";

export default {
  id: "claude-cli",
  priority: 12,
  alias: "ccli",
  aliases: ["claude-code-cli", "cc-cli"],
  uiAlias: "ccli",
  display: {
    name: "Claude Code CLI (-p)",
    icon: "terminal",
    color: "#D97757",
    textIcon: "CL",
    website: "https://claude.com/claude-code",
    notice: {
      signupUrl: "https://claude.com/claude-code",
      text: "Runs the local `claude` binary in print mode (`claude -p`) — no API key needed, and no OAuth token replay. Install Claude Code and sign in once (`claude` → /login). Set CLI_CLAUDE_BIN to pin a custom path. Tool calling is not supported on this provider.",
    },
  },
  category: "free",
  authType: "none",
  noAuth: true,
  authModes: ["none"],
  transport: {
    baseUrl: CLAUDE_CLI_BASE_URL,
    format: "openai",
    forceStream: true,
  },
  models: [
    { id: "claude-cli-default", name: "Claude Code (configured default)", contextLength: 200000 },
    { id: "claude-cli-opus", name: "Claude Opus (via Claude Code)", contextLength: 200000 },
    { id: "claude-cli-sonnet", name: "Claude Sonnet (via Claude Code)", contextLength: 200000 },
    { id: "claude-cli-fable", name: "Claude Fable (via Claude Code)", contextLength: 200000 },
    { id: "claude-cli-haiku", name: "Claude Haiku (via Claude Code)", contextLength: 200000 },
  ],
  passthroughModels: true,
};
