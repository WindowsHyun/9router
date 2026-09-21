"use client";

import { useEffect, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import Badge from "./Badge";
import Input from "./Input";

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
  const [token, setToken] = useState("");

  // A failed request is not the same as "Claude Code is missing". Reporting
  // the HTTP failure separately is what distinguishes "the route refused us"
  // from "the binary is not there", which previously looked identical.
  const read = async () => {
    try {
      const res = await fetch(ENDPOINT, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { loadError: data.error || `Could not read accounts (HTTP ${res.status})` };
      return data;
    } catch (e) {
      return { loadError: e.message || "Could not reach 9Router" };
    }
  };

  useEffect(() => {
    let cancelled = false;
    read().then((d) => { if (!cancelled) setState(d); });
    return () => { cancelled = true; };
  }, []);

  const reload = async () => setState(await read());

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
            This provider runs the <code>claude</code> binary on the machine hosting 9Router —
            no API key, no OAuth token replay. Each account is its own Claude Code identity
            (a config directory on a desktop, a setup token in a container), so several
            subscriptions work side by side and 9Router falls back between them.
          </p>
        </div>
        <Badge variant={state?.connectedCount > 0 ? "success" : "default"} dot>
          {state?.connectedCount > 0 ? `${state.connectedCount} Connected` : "No connections"}
        </Badge>
      </div>

      {state?.loadError && (
        <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {state.loadError}
        </div>
      )}

      {state && !state.loadError && !installed && (
        <div className="mb-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
          Claude Code was not found on this machine. Install it from{" "}
          <a className="underline" href="https://claude.com/claude-code" target="_blank" rel="noreferrer">claude.com/claude-code</a>,
          or set <code>CLI_CLAUDE_BIN</code> to its path, then reload. A token
          account works regardless — it does not need a local binary.
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

      {/* A container has no terminal for the sign-in TUI, so a token is the
          only way to attach an account there. It also works on a desktop. */}
      <div className="mb-3 rounded-lg border border-border-subtle bg-surface-2 p-3">
        <div className="text-xs text-text-main mb-1.5">
          Add an account with a token
        </div>
        <p className="text-[11px] text-text-muted mb-2 leading-relaxed">
          Run <code>claude setup-token</code> on any machine that has Claude Code and paste
          the result. This is the way to add accounts when 9Router runs in Docker, where there
          is no terminal for the interactive login. One token per account.
        </p>
        <div className="flex gap-2 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste the token from `claude setup-token`"
              disabled={busy}
            />
          </div>
          <Button
            size="sm"
            onClick={async () => {
              if (await post({ oauthToken: token })) setToken("");
            }}
            disabled={busy || !token.trim()}
          >
            Add token account
          </Button>
        </div>
      </div>

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
              <div className="text-[11px] text-text-muted mt-1 break-all">
                {a.kind === "token" ? "Authenticated with a setup token" : a.configDir}
              </div>
            </div>
            <div className="flex gap-2 shrink-0 flex-wrap">
              {!a.signedIn && a.kind !== "token" && (
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
