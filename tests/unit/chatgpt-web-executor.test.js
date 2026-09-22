import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { getExecutor } from "open-sse/executors/index.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { PROVIDER_MODELS } from "open-sse/providers/index.js";
import {
  chatGptWebResponsesUrl,
  isLoopbackUrl,
  resolveChatGptWebBaseUrl,
  assertBridgeBaseUrl,
  CHATGPT_WEB_DEFAULT_BASE_URL,
} from "open-sse/config/chatgptWeb.js";

// Stand-in for the codex-chatgpt-web daemon: same routes, same shapes.
let server;
let baseUrl;
let lastRequest = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "5.0.8" }));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-5.5" }, { id: "chatgpt-web/high" }, { id: "chatgpt-web/pro" }] }));
      return;
    }
    if (req.url === "/v1/responses" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        lastRequest = { headers: req.headers, body: JSON.parse(body) };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const credsFor = (url) => ({ providerSpecificData: { baseUrl: url } });

describe("chatgpt-web configuration", () => {
  it("defaults to the bridge's documented loopback endpoint", () => {
    expect(resolveChatGptWebBaseUrl(null)).toBe(CHATGPT_WEB_DEFAULT_BASE_URL);
    expect(chatGptWebResponsesUrl(null)).toBe(`${CHATGPT_WEB_DEFAULT_BASE_URL}/v1/responses`);
  });

  it("honours a per-connection loopback endpoint and normalizes it", () => {
    expect(chatGptWebResponsesUrl(credsFor("http://127.0.0.1:9000/"))).toBe("http://127.0.0.1:9000/v1/responses");
    expect(chatGptWebResponsesUrl(credsFor("http://localhost:9000/some/path"))).toBe("http://localhost:9000/v1/responses");
  });

  // This value decides where the request — and any bearer token on it — is sent,
  // and the same helper guards the dashboard route against SSRF.
  it("refuses a bridge URL that could send the session off the private network", () => {
    for (const bad of [
      // Link-local: 169.254.169.254 is the cloud metadata service, never a bridge.
      "http://169.254.169.254", "http://169.254.1.1",
      "https://evil.tld", "http://8.8.8.8:17841",
      "file:///etc/passwd", "ftp://127.0.0.1", "not a url",
      // A public name that merely looks loopback.
      "http://127.0.0.1.evil.tld",
    ]) {
      expect(() => assertBridgeBaseUrl(bad), `should reject ${bad}`).toThrow();
    }
  });

  // The supported Docker layout runs the bridge as a sibling container, so a
  // loopback-only rule would make it unreachable.
  it("accepts a bridge on a container or private network", () => {
    expect(assertBridgeBaseUrl("http://chatgpt-web:17841")).toBe("http://chatgpt-web:17841");
    expect(assertBridgeBaseUrl("http://10.0.0.5:9000")).toBe("http://10.0.0.5:9000");
    expect(assertBridgeBaseUrl("http://192.168.1.50:17841")).toBe("http://192.168.1.50:17841");
    expect(assertBridgeBaseUrl("http://bridge.internal:17841")).toBe("http://bridge.internal:17841");
  });

  // The provider is noAuth, so auth.js supplies a synthetic connection with no
  // providerSpecificData — the env var is the override that actually applies.
  it("routes to CHATGPT_WEB_BASE_URL when no connection carries one", () => {
    const previous = process.env.CHATGPT_WEB_BASE_URL;
    process.env.CHATGPT_WEB_BASE_URL = "http://127.0.0.1:19999";
    try {
      expect(resolveChatGptWebBaseUrl({ accessToken: "public" })).toBe("http://127.0.0.1:19999");
      expect(chatGptWebResponsesUrl(null)).toBe("http://127.0.0.1:19999/v1/responses");
    } finally {
      if (previous === undefined) delete process.env.CHATGPT_WEB_BASE_URL;
      else process.env.CHATGPT_WEB_BASE_URL = previous;
    }
  });

  it("reports a bad endpoint as an error response instead of throwing out of execute", async () => {
    const { response } = await getExecutor("chatgpt-web").execute({
      model: "chatgpt-web-high",
      stream: true,
      credentials: credsFor("http://169.254.169.254"),
      body: { input: [] },
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("invalid_endpoint");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("accepts the loopback forms a bridge can actually bind to", () => {
    expect(assertBridgeBaseUrl("http://127.0.0.1:17841")).toBe("http://127.0.0.1:17841");
    expect(assertBridgeBaseUrl("http://localhost:17841/")).toBe("http://localhost:17841");
    expect(assertBridgeBaseUrl("")).toBe(CHATGPT_WEB_DEFAULT_BASE_URL);
  });

  it("recognises loopback hosts so the outbound proxy is skipped", () => {
    for (const url of ["http://127.0.0.1:17841/v1/responses", "http://localhost:1/x", "http://[::1]:2/x"]) {
      expect(isLoopbackUrl(url)).toBe(true);
    }
    expect(isLoopbackUrl("https://chatgpt.com/backend-api/codex/responses")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });

  it("is registered as an openai-responses provider", () => {
    expect(PROVIDERS["chatgpt-web"].format).toBe("openai-responses");
    expect(PROVIDERS["chatgpt-web"].forceStream).toBe(true);
    expect(getExecutor("chatgpt-web").getProvider()).toBe("chatgpt-web");
    expect(PROVIDER_MODELS["cgw"].map((m) => m.id)).toContain("chatgpt-web-high");
  });
});

describe("chatgpt-web request shaping", () => {
  it("maps the routed model id onto the bridge's namespace and forces stream/store", async () => {
    const executor = getExecutor("chatgpt-web");
    const { response } = await executor.execute({
      model: "chatgpt-web-high",
      stream: true,
      credentials: credsFor(baseUrl),
      body: {
        model: "chatgpt-web-high",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        stream: false,
        store: true,
        // Not part of the Responses contract — must be dropped before dispatch.
        messages: [{ role: "user", content: "hi" }],
        frequency_penalty: 1,
      },
    });

    expect(response.status).toBe(200);
    await response.text();

    expect(lastRequest.body.model).toBe("chatgpt-web/high");
    expect(lastRequest.body.stream).toBe(true);
    expect(lastRequest.body.store).toBe(false);
    expect(lastRequest.body.messages).toBeUndefined();
    expect(lastRequest.body.frequency_penalty).toBeUndefined();
    expect(lastRequest.body.input).toHaveLength(1);
  });

  it("strips server-generated item ids that store=false cannot resolve", async () => {
    await getExecutor("chatgpt-web").execute({
      model: "chatgpt-web-medium",
      stream: true,
      credentials: credsFor(baseUrl),
      body: {
        input: [
          { id: "rs_abc", type: "reasoning", summary: [] },
          { id: "msg_123", type: "message", role: "user", content: [] },
          { id: "keep-me", type: "message", role: "user", content: [] },
        ],
      },
    }).then(({ response }) => response.text());

    expect(lastRequest.body.input.map((item) => item.id)).toEqual([undefined, undefined, "keep-me"]);
    expect(lastRequest.body.model).toBe("chatgpt-web/medium");
  });

  it("sends no Authorization header when the bridge needs none", async () => {
    await getExecutor("chatgpt-web").execute({
      model: "chatgpt-web-light",
      stream: true,
      credentials: credsFor(baseUrl),
      body: { input: [] },
    }).then(({ response }) => response.text());

    expect(lastRequest.headers.authorization).toBeUndefined();
  });

  // src/sse/services/auth.js hands every noAuth provider a synthetic connection
  // whose accessToken is the literal "public" — that is a placeholder, not a key.
  it("does not turn the noAuth placeholder token into an Authorization header", async () => {
    await getExecutor("chatgpt-web").execute({
      model: "chatgpt-web-high",
      stream: true,
      credentials: { id: "noauth", connectionName: "Public", accessToken: "public", providerSpecificData: { baseUrl: baseUrl } },
      body: { input: [] },
    }).then(({ response }) => response.text());

    expect(lastRequest.headers.authorization).toBeUndefined();
  });

  it("forwards a bearer token when the operator fronts the bridge with auth", async () => {
    await getExecutor("chatgpt-web").execute({
      model: "chatgpt-web-light",
      stream: true,
      credentials: { ...credsFor(baseUrl), apiKey: "secret-token" },
      body: { input: [] },
    }).then(({ response }) => response.text());

    expect(lastRequest.headers.authorization).toBe("Bearer secret-token");
  });

  it("passes an unknown model id through untouched", async () => {
    await getExecutor("chatgpt-web").execute({
      model: "chatgpt-web/experimental",
      stream: true,
      credentials: credsFor(baseUrl),
      body: { input: [] },
    }).then(({ response }) => response.text());

    expect(lastRequest.body.model).toBe("chatgpt-web/experimental");
  });

  it("drops reasoning.effort (the model id fixes it) but keeps the summary control", async () => {
    await getExecutor("chatgpt-web").execute({
      model: "chatgpt-web-luna",
      stream: true,
      credentials: credsFor(baseUrl),
      body: { input: [], reasoning: { effort: "high", summary: "auto" } },
    }).then(({ response }) => response.text());

    expect(lastRequest.body.reasoning).toEqual({ summary: "auto" });
  });

  it("removes reasoning entirely when it carried only an effort", async () => {
    await getExecutor("chatgpt-web").execute({
      model: "chatgpt-web-luna",
      stream: true,
      credentials: credsFor(baseUrl),
      body: { input: [], reasoning: { effort: "high" } },
    }).then(({ response }) => response.text());

    expect("reasoning" in lastRequest.body).toBe(false);
  });
});
