/**
 * ChatGPT Web (via codex-chatgpt-web bridge)
 *
 * Uses a signed-in chatgpt.com web session as an API. The session lives in the
 * bridge's own Electron window — sign-in happens there, not here — and the
 * bridge exposes it on loopback as an OpenAI Responses endpoint.
 *
 * noAuth: the daemon holds the session. Point a connection at a different host
 * with providerSpecificData.baseUrl when the bridge runs elsewhere.
 */
import { CHATGPT_WEB_ALIAS, CHATGPT_WEB_DEFAULT_BASE_URL, CHATGPT_WEB_INSTALL_URL, CHATGPT_WEB_RESPONSES_PATH } from "../../config/chatgptWeb.js";

export default {
  id: "chatgpt-web",
  priority: 160,
  alias: CHATGPT_WEB_ALIAS,
  aliases: ["chatgpt", "codex-chatgpt-web"],
  uiAlias: "cgw",
  display: {
    name: "ChatGPT Web (Subscription)",
    icon: "public",
    color: "#10A37F",
    textIcon: "CW",
    website: "https://chatgpt.com",
    notice: {
      signupUrl: CHATGPT_WEB_INSTALL_URL,
      text: "Routes through the codex-chatgpt-web bridge, which drives your signed-in chatgpt.com session. Install and launch the bridge, sign in inside its window, then click Login here to verify the daemon. Default endpoint: http://127.0.0.1:17841, overridable with CHATGPT_WEB_BASE_URL — the bridge binds to loopback by design, so a bridge on another machine must be forwarded to 127.0.0.1.",
    },
  },
  category: "free",
  authType: "none",
  noAuth: true,
  // noAuth means "no API key", not "ready to use": this provider still needs
  // something set up on the host (a signed-in CLI, a running bridge). The
  // dashboard shows real connection counts instead of a blanket Ready badge,
  // and each connection is one account.
  localSetup: true,
  supportsAccounts: true,
  authModes: ["none"],
  // usageRouted, not usage: the bridge exposes no quota endpoint and its
  // responses carry no rate-limit headers, so the figures in the quota tracker
  // are what 9Router itself routed, labelled as such.
  features: { usage: true, usageRouted: true },
  transport: {
    baseUrl: `${CHATGPT_WEB_DEFAULT_BASE_URL}${CHATGPT_WEB_RESPONSES_PATH}`,
    format: "openai-responses",
    forceStream: true,
  },
  models: [
    { id: "chatgpt-web-light", name: "ChatGPT Web — Instant", upstreamModelId: "chatgpt-web/light" },
    { id: "chatgpt-web-medium", name: "ChatGPT Web — Medium", upstreamModelId: "chatgpt-web/medium" },
    { id: "chatgpt-web-high", name: "ChatGPT Web — High", upstreamModelId: "chatgpt-web/high" },
    { id: "chatgpt-web-extra-high", name: "ChatGPT Web — Extra High", upstreamModelId: "chatgpt-web/extra-high" },
    { id: "chatgpt-web-pro", name: "ChatGPT Web — Pro (Pro plan only)", upstreamModelId: "chatgpt-web/pro" },
    { id: "chatgpt-web-luna", name: "ChatGPT Web — Luna", upstreamModelId: "chatgpt-web/luna" },
    { id: "chatgpt-web-think", name: "ChatGPT Web — Think", upstreamModelId: "chatgpt-web/think" },
    // No zero-risk entries. Upstream's README lists Zero Risk as one of three
    // *modes*, not a model: "Zero Risk does not read or operate the ChatGPT
    // page. Choose the model and `Codex Zero Risk` connector yourself, paste
    // and send the prepared prompt, then confirm Sent in the launcher."
    // A human pastes each prompt by hand, so it cannot serve a routed API call
    // at all — and least of all in a headless container. They were listed here
    // as selectable models and could only ever fail.
  ],
  // The bridge's catalog depends on its mode and the account's plan; unknown ids
  // are forwarded so a newly exposed row works without a 9Router release.
  passthroughModels: true,
};
