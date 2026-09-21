"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import Badge from "./Badge";
import Input from "./Input";

const STATUS_ENDPOINT = "/api/cli-tools/chatgpt-web-settings";
const SIGN_IN_POLL_MS = 5000;
const SIGN_IN_POLL_LIMIT = 120; // ~10 minutes; a first-time setup plus login

/**
 * Status + sign-in launcher for the ChatGPT Web provider.
 *
 * The ChatGPT session lives in the codex-chatgpt-web bridge's own launcher
 * window, so "Login" opens that window rather than collecting credentials
 * here. When 9Router is running with a bridge configured it proxies that
 * window's console on this origin, so Login is a normal link in the
 * operator's browser; on a desktop install it asks the server to open a
 * window locally instead. Signed-in state is read back from the bridge: an
 * authenticated session is what makes it advertise chatgpt-web/* models.
 */
export default function ChatGptWebBridgeCard() {
  const [status, setStatus] = useState(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [message, setMessage] = useState(null);
  const pollRef = useRef(null);

  const applyStatus = useCallback((data) => {
    setStatus(data);
    setBaseUrl((current) => current || data.baseUrl || "");
  }, []);

  const load = useCallback(async (url) => {
    const query = url ? `?baseUrl=${encodeURIComponent(url)}` : "";
    try {
      const res = await fetch(`${STATUS_ENDPOINT}${query}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      // A refused request says nothing about the bridge; reporting it as
      // "offline" sent people looking for a bridge problem that was not there.
      if (!res.ok) {
        setStatus({ running: false, error: data.error || `Status unavailable (HTTP ${res.status})` });
        return null;
      }
      applyStatus(data);
      return data;
    } catch (e) {
      setStatus({ running: false, error: e.message });
      return null;
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  const refresh = useCallback(async (url) => {
    setLoading(true);
    await load(url);
  }, [load]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setWaiting(false);
  }, []);

  /**
   * Watch for the session appearing, so the badge flips on its own once the
   * operator finishes signing in in the other tab. Without this the card sat
   * on a stale "not signed in" until someone thought to press Recheck.
   */
  const waitForSignIn = useCallback((url) => {
    stopPolling();
    setWaiting(true);
    let ticks = 0;
    pollRef.current = setInterval(async () => {
      ticks += 1;
      const data = await load(url);
      if (data?.signedIn || ticks >= SIGN_IN_POLL_LIMIT) stopPolling();
    }, SIGN_IN_POLL_MS);
  }, [load, stopPolling]);

  // Mount load runs as a promise chain (no setState in the effect body).
  useEffect(() => {
    let cancelled = false;
    fetch(STATUS_ENDPOINT, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => { if (!cancelled) applyStatus(data); })
      .catch((e) => { if (!cancelled) setStatus({ running: false, error: e.message }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [applyStatus]);

  useEffect(() => stopPolling, [stopPolling]);

  /**
   * Not async, and window.open comes first: a popup opened after an `await`
   * has lost its user-gesture context and browsers block it.
   */
  const handleLogin = () => {
    setMessage(null);
    if (status?.vncUrl) {
      const opened = window.open(status.vncUrl, "_blank", "noopener,noreferrer");
      setMessage(opened
        ? "Opened the bridge console in a new tab. Finish the launcher setup, sign in to ChatGPT, and this card will update itself."
        : "Your browser blocked the popup — allow popups for this site, or open the console from the link below.");
      waitForSignIn(baseUrl);
      return;
    }
    // Desktop install: no proxy, so ask the server to open a window locally.
    setOpening(true);
    fetch(STATUS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: baseUrl || undefined }),
    })
      .then((res) => res.json())
      .then((data) => {
        setMessage(data.error || data.hint || "Opened the bridge window.");
        // A bridge appeared between mount and this click: surface its console
        // link rather than leaving the operator with a hint and no way in.
        if (data.vncUrl) setStatus((s) => ({ ...(s || {}), vncUrl: data.vncUrl }));
        if (!data.error) waitForSignIn(baseUrl);
        return load(baseUrl);
      })
      .catch((e) => setMessage(e.message))
      .finally(() => setOpening(false));
  };

  const running = status?.running === true;
  const signedIn = status?.signedIn === true;
  const vncUrl = status?.vncUrl || null;

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">ChatGPT Web bridge</h2>
          <p className="text-sm text-text-muted">
            Routes through codex-chatgpt-web, which drives your signed-in chatgpt.com session.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {loading ? (
            <Badge variant="default">Checking…</Badge>
          ) : signedIn ? (
            <Badge variant="success">Signed in</Badge>
          ) : waiting ? (
            <Badge variant="info">Waiting for sign-in…</Badge>
          ) : running ? (
            <Badge variant="warning">Running — not signed in</Badge>
          ) : (
            <Badge variant="error">Bridge offline</Badge>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input
            label="Bridge endpoint to check"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://127.0.0.1:17841"
            hint="Loopback, a container name (http://chatgpt-web:17841) or a private address. Public hosts are refused so the session cannot leave your network. Defaults to CHATGPT_WEB_BASE_URL; this field only changes what Recheck/Login probe."
          />
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" icon="refresh" onClick={() => refresh(baseUrl)} disabled={loading}>
            Recheck
          </Button>
          <Button size="sm" icon="login" onClick={handleLogin} loading={opening}>
            Login
          </Button>
        </div>
      </div>

      {status?.models?.length > 0 && (
        <div className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-muted">
          <span className="font-medium text-text-main">Models exposed by your session:</span>{" "}
          {status.models.join(", ")}
        </div>
      )}

      {status?.baseUrl && !loading && (
        <p className="mt-3 text-[11px] text-text-muted">
          Probed <code>{status.baseUrl}</code>
          {status.baseUrlSource ? ` (from ${status.baseUrlSource})` : ""}
        </p>
      )}

      {(status?.hint || status?.error || message) && (
        <p className="mt-2 text-xs text-text-muted whitespace-pre-wrap">
          {message || status.error || status.hint}
        </p>
      )}

      {/* Offline has several distinct causes and they are not guessable from
          the badge. Ordered so the first thing to check is first. */}
      {!loading && !running && (
        <div className="mt-3 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-[11px] text-text-muted">
          <div className="font-medium text-text-main mb-1">Nothing is answering. In order:</div>
          <ol className="list-decimal pl-4 space-y-0.5">
            <li>
              Signed in yet? chatgpt.com needs one real browser login.
              {vncUrl ? (
                <> Press <span className="font-medium text-text-main">Login</span> — it opens the
                  launcher window right here in your browser. Until that is done, offline is expected.</>
              ) : (
                <> The bridge publishes its window on port <code>6080</code>; open
                  <code> /vnc.html</code> there and finish setup.</>
              )}
            </li>
            <li>
              Is the bridge running at the address above? In Docker or Kubernetes it is a
              separate container — check that it started, not just 9Router.
            </li>
            <li>
              Is that the right address? A sidecar in the same pod is
              <code> http://127.0.0.1:17841</code>; a separate service is
              <code> http://chatgpt-web:17841</code>. Set
              <code> CHATGPT_WEB_BASE_URL</code> to whichever applies.
            </li>
          </ol>
        </div>
      )}

      {vncUrl && !signedIn && !loading && (
        <p className="mt-2 text-[11px] text-text-muted">
          Console:{" "}
          <a href={vncUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            open the launcher window
          </a>
        </p>
      )}

      {!running && status?.installUrl && !vncUrl && (
        <p className="mt-2 text-xs text-text-muted">
          Not installed yet?{" "}
          <a href={status.installUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            Get codex-chatgpt-web
          </a>
        </p>
      )}
    </Card>
  );
}
