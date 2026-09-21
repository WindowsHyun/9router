"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import Badge from "./Badge";

const STATUS_ENDPOINT = "/api/cli-tools/claude-cli-settings";

/**
 * Install status for the Claude Code CLI provider.
 *
 * There is nothing to sign in to from here: the provider spawns the local
 * `claude` binary, which uses whatever account that binary is already logged
 * into. This card reports the exact binary the runtime will spawn so the
 * dashboard and the executor can never disagree.
 */
export default function ClaudeCliStatusCard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  // Mount load runs as a promise chain (no setState in the effect body).
  useEffect(() => {
    let cancelled = false;
    fetch(STATUS_ENDPOINT, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setStatus(data); })
      .catch((e) => { if (!cancelled) setStatus({ installed: false, hint: e.message }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(STATUS_ENDPOINT, { cache: "no-store" });
      setStatus(await res.json());
    } catch (e) {
      setStatus({ installed: false, hint: e.message });
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Claude Code CLI</h2>
          <p className="text-sm text-text-muted">
            Runs `claude -p` locally instead of replaying an OAuth token from this server.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {loading ? (
            <Badge variant="default">Checking…</Badge>
          ) : status?.installed ? (
            <Badge variant="success">{status.version || "Installed"}</Badge>
          ) : (
            <Badge variant="danger">Not installed</Badge>
          )}
          <Button size="sm" variant="secondary" icon="refresh" onClick={refresh} disabled={loading}>
            Recheck
          </Button>
        </div>
      </div>

      {status?.bin && (
        <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-muted">
          <span className="font-medium text-text-main">Binary:</span> {status.bin}
          {status.source ? ` (${status.source})` : ""}
        </div>
      )}

      {(status?.hint || status?.authHint) && (
        <p className="mt-3 text-xs text-text-muted">{status.hint || status.authHint}</p>
      )}

      <p className="mt-3 text-xs text-text-muted">
        Sign in once with `claude` → /login on this machine. Tool calling is not supported on this provider.
      </p>
    </Card>
  );
}
