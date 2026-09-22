/**
 * Signing the ChatGPT Web bridge in from 9Router.
 *
 * The bridge authenticates from a stored Playwright session, and producing one
 * used to mean logging in inside its container — an Electron launcher, then a
 * VNC desktop, resident permanently for a once-per-account task. A stored
 * session is cookies, so the operator pastes theirs instead.
 *
 * That paste is the whole attack surface and the whole usability surface at
 * once: four plausible shapes come out of a browser, and a wrong guess about
 * which is a miserable way to fail. These cover all four, and the refusals.
 */
import { describe, it, expect } from "vitest";
import {
  CHATGPT_WEB_REQUIRED_COOKIE,
  CHATGPT_WEB_SESSION_PORT,
  chatGptWebSessionUrl,
  parseChatGptWebSession,
} from "open-sse/config/chatgptWeb.js";

const TOKEN = "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..test";

describe("parsing a pasted ChatGPT session", () => {
  it("accepts the bare session-token value", () => {
    const { cookies } = parseChatGptWebSession(TOKEN);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({
      name: CHATGPT_WEB_REQUIRED_COOKIE,
      value: TOKEN,
      domain: ".chatgpt.com",
      secure: true,
    });
  });

  it("accepts a document.cookie-style string", () => {
    const { cookies } = parseChatGptWebSession(
      `${CHATGPT_WEB_REQUIRED_COOKIE}=${TOKEN}; _puid=abc; oai-did=xyz`,
    );
    expect(cookies.map((c) => c.name)).toEqual([CHATGPT_WEB_REQUIRED_COOKIE, "_puid", "oai-did"]);
  });

  it("accepts a cookie-extension export, including its sameSite spellings", () => {
    const { cookies } = parseChatGptWebSession(JSON.stringify([
      {
        name: CHATGPT_WEB_REQUIRED_COOKIE,
        value: TOKEN,
        domain: ".chatgpt.com",
        sameSite: "no_restriction",
        expirationDate: 1799999999.123,
        httpOnly: true,
      },
    ]));
    // Playwright only accepts Strict/Lax/None, and extensions use other words.
    expect(cookies[0].sameSite).toBe("None");
    // ...and an integer expiry, not a float.
    expect(cookies[0].expires).toBe(1799999999);
  });

  it("accepts a Playwright storage state and keeps only chatgpt.com origins", () => {
    const { cookies, origins } = parseChatGptWebSession(JSON.stringify({
      cookies: [{ name: CHATGPT_WEB_REQUIRED_COOKIE, value: TOKEN, domain: "chatgpt.com" }],
      origins: [
        { origin: "https://chatgpt.com", localStorage: [{ name: "a", value: "b" }] },
        { origin: "https://example.com", localStorage: [{ name: "leak", value: "no" }] },
      ],
    }));
    expect(cookies).toHaveLength(1);
    expect(origins).toHaveLength(1);
    expect(origins[0].origin).toBe("https://chatgpt.com");
  });

  it("drops cookies for domains the bridge would discard anyway", () => {
    // LOGIN_STORAGE_ROOT_DOMAINS in the bridge is chatgpt.com + openai.com.
    const { cookies } = parseChatGptWebSession(JSON.stringify([
      { name: CHATGPT_WEB_REQUIRED_COOKIE, value: TOKEN, domain: ".chatgpt.com" },
      { name: "keep", value: "1", domain: "auth.openai.com" },
      { name: "drop", value: "1", domain: ".evil.example.com" },
    ]));
    expect(cookies.map((c) => c.name).sort()).toEqual([CHATGPT_WEB_REQUIRED_COOKIE, "keep"].sort());
  });

  it.each([
    ["nothing", "   "],
    ["cookies without the session token", "_puid=abc; oai-did=xyz"],
    ["only foreign-domain cookies", JSON.stringify([{ name: "x", value: "1", domain: "evil.example.com" }])],
  ])("refuses %s", (_label, input) => {
    expect(() => parseChatGptWebSession(input)).toThrow();
  });

  it("says the session cookie is httpOnly when it is missing", () => {
    // The single most common failure: copying document.cookie, which cannot
    // contain it. The message has to point somewhere useful.
    expect(() => parseChatGptWebSession("_puid=abc"))
      .toThrow(/httpOnly|devtools/i);
  });

  it("explains malformed JSON rather than treating it as a token", () => {
    expect(() => parseChatGptWebSession('{"cookies": [')).toThrow(/does not parse/i);
  });
});

describe("locating the bridge's session endpoint", () => {
  it("derives it from the bridge address, so there is one thing to configure", () => {
    expect(chatGptWebSessionUrl({ CHATGPT_WEB_BASE_URL: "http://127.0.0.1:17841" }))
      .toBe(`http://127.0.0.1:${CHATGPT_WEB_SESSION_PORT}/session`);
    expect(chatGptWebSessionUrl({ CHATGPT_WEB_BASE_URL: "http://chatgpt-web:17851" }))
      .toBe(`http://chatgpt-web:${CHATGPT_WEB_SESSION_PORT}/session`);
  });

  it("refuses a public host, so a session cannot be posted off the network", () => {
    expect(() => chatGptWebSessionUrl({ CHATGPT_WEB_BASE_URL: "http://evil.example.com:17841" }))
      .toThrow(/private network|loopback/i);
  });

  it("refuses a nonsense port", () => {
    expect(() => chatGptWebSessionUrl({
      CHATGPT_WEB_BASE_URL: "http://127.0.0.1:17841",
      CHATGPT_WEB_SESSION_PORT: "not-a-port",
    })).toThrow(/CHATGPT_WEB_SESSION_PORT/);
  });
});
