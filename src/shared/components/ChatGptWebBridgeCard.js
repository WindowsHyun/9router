"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import Badge from "./Badge";
import Input from "./Input";

const STATUS_ENDPOINT = "/api/cli-tools/chatgpt-web-settings";

/**
 * Status + sign-in launcher for the ChatGPT Web provider.
 *
 * The ChatGPT session itself lives in the codex-chatgpt-web bridge's Electron
 * window, so "Login" opens that window on the machine running 9Router rather
 * than collecting credentials here. Signed-in state is read back from the
 * bridge: an authenticated session is what makes it advertise chatgpt-web/*
 * models on its local Responses endpoint.
 */
export default function ChatGptWebBridgeCard() {
  const [status, setStatus] = useState(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [message, setMessage] = useState(null);

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
      } else {
        applyStatus(data);
      }
    } catch (e) {
      setStatus({ running: false, error: e.message });
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  const refresh = useCallback(async (url) => {
    setLoading(true);
    await load(url);
  }, [load]);

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

  const handleLogin = async () => {
    setOpening(true);
    setMessage(null);
    try {
      const res = await fetch(STATUS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: baseUrl || undefined }),
      });
      const data = await res.json();
      setMessage(data.error || data.hint || "Opened the bridge window.");
      await load(baseUrl);
    } catch (e) {
      setMessage(e.message);
    } finally {
      setOpening(false);
    }
  };

  const running = status?.running === true;
  const signedIn = status?.signedIn === true;

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
          ) : running ? (
            <Badge variant="warning">Running — not signed in</Badge>
          ) : (
            <Badge variant="danger">Bridge offline</Badge>
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

      {(status?.hint || status?.error || message) && (
        <p className="mt-3 text-xs text-text-muted">{message || status.error || status.hint}</p>
      )}

      {!running && status?.installUrl && (
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
