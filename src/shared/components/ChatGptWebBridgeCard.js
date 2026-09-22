"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import Badge from "./Badge";

const STATUS_ENDPOINT = "/api/cli-tools/chatgpt-web-settings";
const SESSION_ENDPOINT = "/api/cli-tools/chatgpt-web-session";
const REQUIRED_COOKIE = "__Secure-next-auth.session-token";

/**
 * Sign-in and status for the ChatGPT Web provider.
 *
 * The bridge drives a real chatgpt.com session in a browser and authenticates
 * from a stored session. Getting one used to mean logging in inside the bridge
 * container — an Electron launcher, then a VNC desktop, running permanently
 * for a once-per-account task. A stored session is cookies, so instead the
 * operator pastes theirs here and the bridge verifies it by opening the
 * account with the browser it already has.
 *
 * Two different facts are shown, because they fail separately: whether the
 * session is stored and verified, and whether the bridge is up and routing.
 */
export default function ChatGptWebBridgeCard() {
  const [status, setStatus] = useState(null);
  const [session, setSession] = useState(null);
  const [paste, setPaste] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const [bridgeRes, sessionRes] = await Promise.allSettled([
      fetch(STATUS_ENDPOINT, { cache: "no-store" }).then((r) => r.json()),
      fetch(SESSION_ENDPOINT, { cache: "no-store" }).then((r) => r.json()),
    ]);
    if (!alive.current) return;
    setStatus(bridgeRes.status === "fulfilled" ? bridgeRes.value : { running: false, error: bridgeRes.reason?.message });
    setSession(sessionRes.status === "fulfilled" ? sessionRes.value : { signedIn: false, error: sessionRes.reason?.message });
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const connect = async () => {
    setBusy(true);
    setMessage("Opening ChatGPT with that session to check it — this takes a moment.");
    try {
      const res = await fetch(SESSION_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: paste }),
      });
      const data = await res.json();
      if (data.signedIn) {
        // Only cleared on success: a rejected paste is usually one character
        // short, and making the operator fetch it again would be unkind.
        setPaste("");
        setMessage("Signed in. The session is stored in the bridge's profile volume.");
      } else {
        setMessage(data.error || data.hint || "That session was not accepted.");
      }
      await load();
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await fetch(SESSION_ENDPOINT, { method: "DELETE" });
      setMessage("Signed out. The stored session has been deleted.");
      await load();
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  };

  const signedIn = session?.signedIn === true;
  const running = status?.running === true;
  const models = status?.models || [];

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">ChatGPT Web</h2>
          <p className="text-sm text-text-muted">
            Routes through codex-chatgpt-web, which drives your signed-in chatgpt.com session.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {loading ? (
            <Badge variant="default">Checking…</Badge>
          ) : signedIn && running ? (
            <Badge variant="success">Signed in</Badge>
          ) : signedIn ? (
            <Badge variant="warning">Signed in — bridge not answering</Badge>
          ) : session?.reachable === false ? (
            <Badge variant="error">Bridge offline</Badge>
          ) : (
            <Badge variant="warning">Not signed in</Badge>
          )}
        </div>
      </div>

      {!signedIn && (
        <div className="flex flex-col gap-2">
          <label htmlFor="cgw-session" className="text-sm font-medium">
            Paste your chatgpt.com session
          </label>
          <textarea
            id="cgw-session"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder={`${REQUIRED_COOKIE} value, or a cookie export for chatgpt.com`}
            className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 font-mono text-xs"
          />
          {/* The required cookie is httpOnly, so the browser console cannot
              read it. Saying where it actually is saves a frustrating loop. */}
          <p className="text-[11px] text-text-muted">
            In a browser where you are signed in to chatgpt.com, open devtools →
            Application → Cookies → <code>https://chatgpt.com</code>, and copy the value of{" "}
            <code>{REQUIRED_COOKIE}</code>. A whole-cookie export from an extension works too.
            It is <span className="font-medium text-text-main">httpOnly</span>, so
            <code> document.cookie</code> will not show it.
          </p>
          <div>
            <Button size="sm" icon="login" onClick={connect} loading={busy} disabled={!paste.trim()}>
              Connect
            </Button>
          </div>
        </div>
      )}

      {signedIn && (
        <div className="flex flex-col gap-2">
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-muted">
            {session.verifiedAt && (
              <div>Verified {new Date(session.verifiedAt).toLocaleString()}</div>
            )}
            {models.length > 0 && (
              <div className="mt-1">
                <span className="font-medium text-text-main">Models:</span> {models.join(", ")}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" icon="refresh" onClick={load} disabled={busy}>
              Recheck
            </Button>
            <Button size="sm" variant="danger" onClick={signOut} loading={busy}>
              Sign out
            </Button>
          </div>
        </div>
      )}

      {message && (
        <p className="mt-3 text-xs text-text-muted whitespace-pre-wrap">{message}</p>
      )}

      {!loading && signedIn && !running && (
        <p className="mt-3 text-[11px] text-text-muted">
          The session is stored, but the bridge is not answering on{" "}
          <code>{status?.baseUrl}</code>. That is a separate problem — check the bridge
          container is running and that <code>CHATGPT_WEB_BASE_URL</code> points at it.
        </p>
      )}
    </Card>
  );
}
