import { NextResponse } from "next/server";
import {
  CHATGPT_WEB_REQUIRED_COOKIE,
  chatGptWebSessionUrl,
  parseChatGptWebSession,
} from "open-sse/config/chatgptWeb.js";
// Routing reaches the bridge through the environment and never needed a
// connection row, so none was created — which is why a signed-in bridge still
// read "No connections" everywhere that counts accounts.
import {
  syncChatGptWebConnection,
  removeChatGptWebConnection,
} from "@/shared/services/chatGptWebConnection";

/**
 * Sign the ChatGPT Web bridge in, from the dashboard.
 *
 * The bridge drives a real chatgpt.com session in a browser, and it
 * authenticates from a stored Playwright session. Getting one used to mean
 * logging in *inside the bridge container*, which is why that container once
 * ran an Electron launcher and then a VNC desktop.
 *
 * A stored session is cookies, though, and cookies can be handed over. So the
 * operator pastes their chatgpt.com session here, this normalizes it, and the
 * bridge writes it and verifies it with the browser it already has. Nothing
 * remote to connect to, and nothing to keep running between logins.
 *
 * The paste never reaches the database or a log: it goes to the bridge and is
 * dropped.
 */

// Verification opens chatgpt.com in a real browser; that is slower than a
// normal API call and the point of the whole endpoint.
const CONNECT_TIMEOUT_MS = 120_000;
const STATUS_TIMEOUT_MS = 10_000;

async function bridge(method, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Inside the try on purpose: this throws for a misconfigured bridge URL —
    // a public host, or something that is not a URL at all — and that is a
    // configuration mistake the operator should be told about, not a stack
    // trace. It used to sit outside, so GET explained it and POST and DELETE
    // answered 500.
    const url = chatGptWebSessionUrl();
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      cache: "no-store",
      redirect: "manual",
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep the raw text for the message */ }
    return { ok: response.ok, status: response.status, json, text: text.slice(0, 400) };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e.name === "AbortError"
        ? `The bridge did not answer within ${Math.round(timeoutMs / 1000)}s`
        : e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

const unreachable = (result) => NextResponse.json({
  signedIn: false,
  reachable: false,
  error: result.error || `The bridge session endpoint answered ${result.status}`,
  hint: "The bridge container is not answering. Check that it started, and that "
    + "CHATGPT_WEB_BASE_URL points at it.",
}, { status: 200 });

/** Current sign-in state, as the bridge sees it. */
export async function GET() {
  let result;
  try {
    result = await bridge("GET", null, STATUS_TIMEOUT_MS);
  } catch (e) {
    return NextResponse.json({ signedIn: false, reachable: false, error: e.message }, { status: 200 });
  }
  if (!result.ok || !result.json) return unreachable(result);
  // Reading status is also when a session signed in before this mirror existed
  // gets its row, so an account that already worked stops reading as none.
  await syncChatGptWebConnection(result.json);
  return NextResponse.json({ ...result.json, reachable: true });
}

/**
 * POST { session } — whatever was pasted. Accepts a bare session-token value,
 * a `name=value` cookie string, a cookie-extension export, or a Playwright
 * storage state; parseChatGptWebSession sorts out which.
 */
export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch { /* handled below */ }

  let session;
  try {
    session = parseChatGptWebSession(body?.session ?? body?.cookies ?? "");
  } catch (e) {
    return NextResponse.json({
      signedIn: false,
      error: e.message,
      requiredCookie: CHATGPT_WEB_REQUIRED_COOKIE,
    }, { status: 400 });
  }

  const result = await bridge("POST", session, CONNECT_TIMEOUT_MS);
  if (!result.ok) {
    // A refusal from the bridge is the useful case: it tried the session in a
    // browser and ChatGPT did not accept it. Pass that reason through rather
    // than flattening it into "failed".
    if (result.json?.error) {
      return NextResponse.json({ signedIn: false, error: result.json.error }, { status: 400 });
    }
    return unreachable(result);
  }
  await syncChatGptWebConnection(result.json);
  return NextResponse.json({ ...result.json, reachable: true });
}

/** Forget the stored session. */
export async function DELETE() {
  const result = await bridge("DELETE", null, STATUS_TIMEOUT_MS);
  if (!result.ok || !result.json) return unreachable(result);
  // Forgetting the session is deliberate, so the row goes too — unlike a
  // bridge that is merely unreachable, which only marks the row expired.
  await removeChatGptWebConnection();
  return NextResponse.json({ ...result.json, reachable: true });
}
