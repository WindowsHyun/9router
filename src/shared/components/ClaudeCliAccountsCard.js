"use client";

import { useEffect, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import Badge from "./Badge";

const ENDPOINT = "/api/cli-tools/claude-cli-accounts";

/**
 * Accounts for the Claude Code CLI provider.
 *
 * One account is one Claude Code config directory, because that is how Claude
 * Code scopes its credentials. Signing in is an interactive TUI flow, so
 * "Add account" opens a terminal pointed at a fresh directory rather than
 * collecting anything here; once /login writes its credentials the account
 * turns active and routed requests start using it.
 */
export default function ClaudeCliAccountsCard() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pendingId, setPendingId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(ENDPOINT, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setState(d); })
      .catch((e) => { if (!cancelled) setState({ error: e.message }); });
    return () => { cancelled = true; };
  }, []);

  const reload = async () => {
    try {
      setState(await (await fetch(ENDPOINT, { cache: "no-store" })).json());
    } catch (e) {
      setState({ error: e.message });
    }
  };

  const post = async (body) => {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setMessage(data.error || `HTTP ${res.status}`); return null; }
      if (data.how) setMessage(data.how);
      await reload();
      return data;
    } catch (e) {
      setMessage(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  // After a login window opens, the credentials file is the only signal we get.
  const check = async (id) => {
    setBusy(true);
    setPendingId(id);
    try {
      const res = await fetch(ENDPOINT, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      setMessage(data.signedIn ? "Signed in — this account is now active." : "Not signed in yet. Finish /login in the terminal, then press Check again.");
      await reload();
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
      setPendingId(null);
    }
  };

  const remove = async (id) => {
    setBusy(true);
    try {
      await fetch(`/api/providers/${id}`, { method: "DELETE" });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const accounts = state?.accounts || [];
  const installed = state?.installed === true;
  const hostSignedIn = state?.host?.signedIn === true;
  const hostAdopted = accounts.some((a) => a.configDir === state?.host?.configDir);

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">Claude Code accounts</h2>
          <p className="text-xs text-text-muted mt-1 max-w-2xl leading-relaxed">
            This provider runs the <code>claude</code> binary already installed on this machine —
            no API key, no OAuth token replay. Each account is a separate Claude Code
            config directory, so several subscriptions can be used side by side and
            9Router will fall back between them.
          </p>
        </div>
        <Badge variant={state?.connectedCount > 0 ? "success" : "default"} dot>
          {state?.connectedCount > 0 ? `${state.connectedCount} Connected` : "No connections"}
        </Badge>
      </div>

      {state && !installed && (
        <div className="mb-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
          Claude Code was not found on this machine. Install it from{" "}
          <a className="underline" href="https://claude.com/claude-code" target="_blank" rel="noreferrer">claude.com/claude-code</a>,
          or set <code>CLI_CLAUDE_BIN</code> to its path, then reload.
        </div>
      )}

      {installed && (
        <div className="mb-3 text-[11px] text-text-muted break-all">
          Binary: <code>{state.bin}</code>
        </div>
      )}

      {installed && accounts.length === 0 && (
        <div className="mb-3 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-600 dark:text-blue-400">
          {hostSignedIn
            ? "This machine is already signed in to Claude Code. Add it as an account to start routing, or add a separate account to keep this one untouched."
            : "Nothing is signed in yet. Add an account — a terminal window opens, and you run /login there."}
        </div>
      )}

      <div className="flex gap-2 flex-wrap mb-4">
        {installed && hostSignedIn && !hostAdopted && (
          <Button size="sm" icon="person_add" onClick={() => post({ adoptHost: true })} disabled={busy}>
            Use this machine&apos;s account
          </Button>
        )}
        <Button size="sm" variant="secondary" icon="add" onClick={() => post({})} disabled={busy || !installed}>
          Add another account
        </Button>
        <Button size="sm" variant="secondary" icon="refresh" onClick={reload} disabled={busy}>
          Refresh
        </Button>
      </div>

      {message && (
        <div className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-main whitespace-pre-wrap">{message}</div>
      )}

      <div className="space-y-2">
        {accounts.map((a) => (
          <div key={a.id} className="flex items-start gap-3 p-3 rounded-[14px] border border-border-subtle bg-surface">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-text-main">{a.name}</span>
                {a.signedIn ? (
                  <Badge variant="success" size="sm" dot>Signed in</Badge>
                ) : (
                  <Badge variant="warning" size="sm" dot>Awaiting /login</Badge>
                )}
                {!a.isActive && <Badge variant="default" size="sm">Inactive</Badge>}
              </div>
              <div className="text-[11px] text-text-muted mt-1 break-all">{a.configDir}</div>
            </div>
            <div className="flex gap-2 shrink-0 flex-wrap">
              {!a.signedIn && (
                <Button size="sm" variant="secondary" onClick={() => post({ id: a.id })} disabled={busy}>
                  Open login
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => check(a.id)} disabled={busy}>
                {busy && pendingId === a.id ? "Checking…" : "Check"}
              </Button>
              <Button size="sm" variant="danger" onClick={() => remove(a.id)} disabled={busy}>
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
