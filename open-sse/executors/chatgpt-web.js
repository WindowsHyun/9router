/**
 * ChatGptWebExecutor — dispatches to the local codex-chatgpt-web daemon, which
 * relays the turn through a signed-in ChatGPT web session.
 *
 * The daemon speaks the OpenAI Responses API, so the translator already produces
 * the right body shape (`transport.format = "openai-responses"`). This executor
 * only has to:
 *   1. point at the operator's daemon (CHATGPT_WEB_BASE_URL, else the default),
 *   2. keep loopback traffic off any configured outbound proxy,
 *   3. narrow the body to fields the Responses route accepts, and
 *   4. map routed model ids onto the daemon's `chatgpt-web/*` namespace.
 */

import { DefaultExecutor } from "./default.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import {
  CHATGPT_WEB_ALIAS,
  CHATGPT_WEB_RESPONSES_ALLOWLIST,
  NOAUTH_TOKEN_SENTINEL,
  chatGptWebResponsesUrl,
  isLoopbackUrl,
} from "../config/chatgptWeb.js";

// Server-generated item ids cannot be resolved when store=false — the daemon
// forwards them to ChatGPT, which 404s on ids it never issued.
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

function stripStoredItemReferences(input) {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    if (typeof item.id === "string" && SERVER_ID_PATTERN.test(item.id)) {
      const { id, ...rest } = item;
      return rest;
    }
    return item;
  });
}

/**
 * Each routed model fixes its own browser effort, and the bridge honours a
 * requested `reasoning.effort` on top of that — a mismatch is a hard error
 * (`ChatGPT Luna mode is not supported: high`). The model id already carries the
 * effort, so only the summary control is forwarded.
 */
function stripReasoningEffort(reasoning) {
  if (!reasoning || typeof reasoning !== "object") return undefined;
  return reasoning.summary === undefined ? undefined : { summary: reasoning.summary };
}

export class ChatGptWebExecutor extends DefaultExecutor {
  constructor() {
    super("chatgpt-web");
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return chatGptWebResponsesUrl(credentials);
  }

  buildHeaders(credentials) {
    const headers = { "Content-Type": "application/json" };
    // The daemon leaves /v1/responses open on loopback, but a user fronting it
    // with their own reverse proxy can still require a bearer token. The noAuth
    // placeholder token is not a credential — sending it would overwrite a real
    // one on that reverse proxy and leak a meaningless header otherwise.
    const token = credentials?.apiKey || credentials?.accessToken;
    if (token && token !== NOAUTH_TOKEN_SENTINEL) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  transformRequest(model, body) {
    const source = body && typeof body === "object" ? body : {};
    const transformed = {};
    for (const [key, value] of Object.entries(source)) {
      if (CHATGPT_WEB_RESPONSES_ALLOWLIST.has(key) && value !== undefined) transformed[key] = value;
    }

    transformed.model = getModelUpstreamId(CHATGPT_WEB_ALIAS, model) || model;
    if (transformed.reasoning) transformed.reasoning = stripReasoningEffort(transformed.reasoning);
    if (Array.isArray(transformed.input)) transformed.input = stripStoredItemReferences(transformed.input);
    // Browser turns are inherently streamed, and the daemon never stores turns.
    transformed.stream = true;
    transformed.store = false;
    if (transformed.reasoning === undefined) delete transformed.reasoning;
    return transformed;
  }

  async execute(args) {
    // resolveChatGptWebBaseUrl rejects a non-loopback or malformed endpoint by
    // throwing; surface that as an error response rather than an exception from
    // inside the executor.
    let url;
    try {
      url = this.buildUrl(args?.model, args?.stream, 0, args?.credentials);
    } catch (e) {
      const body = sseChunk({
        error: { message: e.message, type: "chatgpt_web_error", code: "invalid_endpoint" },
      }) + SSE_DONE;
      return { response: new Response(body, { status: 400, headers: SSE_HEADERS }) };
    }

    // A proxy meant for real upstreams would black-hole a 127.0.0.1 request.
    const proxyOptions = isLoopbackUrl(url) ? null : args?.proxyOptions ?? null;
    return super.execute({ ...args, proxyOptions });
  }
}

export default ChatGptWebExecutor;
