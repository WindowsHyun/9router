/**
 * Keeps a provider connection row in step with the ChatGPT Web bridge session.
 *
 * The bridge holds the signed-in chatgpt.com session itself, and the executor
 * reaches it through CHATGPT_WEB_BASE_URL — so routing has never needed a row
 * in this database, and none was ever created. Everything that *counts*
 * accounts does need one, though: the Providers grid, the connection list and
 * the quota tracker all read providerConnections, so a working bridge showed
 * up as "No connections" no matter how many times it was signed in.
 *
 * The row is a mirror of the bridge's state, not a credential store, and the
 * pasted session never reaches here — it stays in the bridge.
 *
 * It is not inert, though: auth.js injects its synthetic "Public" connection
 * only while a no-auth provider has *no* rows, so creating this one moves
 * routing onto it. That is deliberate upstream (it is what makes several local
 * accounts possible), which means this row has to reproduce what the synthetic
 * connection provided — the noAuth token sentinel, and the configured proxy
 * pool — or signing in would quietly change how traffic reaches the bridge.
 * It carries no `baseUrl`, so resolveChatGptWebBaseUrl() still falls back to
 * the environment.
 */
import {
  getProviderConnections,
  createProviderConnection,
  updateProviderConnection,
  deleteProviderConnection,
} from "@/models";
import { NOAUTH_TOKEN_SENTINEL } from "open-sse/config/chatgptWeb.js";

export const CHATGPT_WEB_PROVIDER = "chatgpt-web";
const CONNECTION_NAME = "ChatGPT Web session";
// Status only — no browser work behind it, unlike signing in.
const BRIDGE_STATUS_TIMEOUT_MS = 10_000;

// One startup mirror per server process, kept on a global so Next's module
// re-evaluation does not repeat it.
const g = (global.__chatGptWebMirror ??= { once: null });

/** The proxy pool auth.js would have used for the synthetic connection. */
async function configuredProxyPoolId() {
  const { getSettings } = await import("@/lib/localDb");
  const settings = await getSettings();
  const override = (settings?.providerStrategies || {})[CHATGPT_WEB_PROVIDER] || {};
  return override.proxyPoolId || undefined;
}

function planLabel(capabilities) {
  const plan = capabilities?.plan || capabilities?.planType || capabilities?.accountPlan;
  return typeof plan === "string" && plan.trim() ? plan.trim() : "";
}

/**
 * Mirror the bridge's session state into a connection row.
 *
 * @param {{ signedIn?: boolean, capabilities?: object, verifiedAt?: string }} state
 *   as reported by the bridge's /session endpoint
 * @returns {Promise<object|null>} the row, or null when there is none to show
 */
export async function syncChatGptWebConnection(state) {
  try {
    const existing = (await getProviderConnections({ provider: CHATGPT_WEB_PROVIDER }))[0] || null;

    // Not signed in: keep the row but mark it so, rather than deleting it —
    // a bridge that is merely restarting should not make the account vanish
    // from the dashboard, and the operator may have set a priority on it.
    if (!state?.signedIn) {
      if (!existing) return null;
      await updateProviderConnection(existing.id, {
        testStatus: "expired",
        lastError: "The bridge has no signed-in session",
        existingProviderSpecificData: existing.providerSpecificData,
      });
      return { ...existing, testStatus: "expired" };
    }

    const plan = planLabel(state.capabilities);
    // Carry over the proxy pool the synthetic "Public" connection was using.
    // auth.js applies providerStrategies[chatgpt-web].proxyPoolId only on that
    // synthetic path; the moment this row exists, routing reads the row's own
    // providerSpecificData instead — so without this, creating the row would
    // quietly drop a configured proxy. (The bridge binds to loopback by design,
    // so this is usually unset; it is carried anyway rather than silently lost.)
    const inheritedProxyPoolId = existing
      ? undefined
      : await configuredProxyPoolId().catch(() => undefined);

    const providerSpecificData = {
      ...(existing?.providerSpecificData || {}),
      ...(inheritedProxyPoolId ? { proxyPoolId: inheritedProxyPoolId } : {}),
      // What the account can actually reach, as the bridge detected it. Used to
      // tell "this model is not on your plan" apart from "this model failed".
      capabilities: state.capabilities || {},
      verifiedAt: state.verifiedAt || new Date().toISOString(),
      ...(plan ? { plan } : {}),
    };

    if (existing) {
      await updateProviderConnection(existing.id, {
        isActive: existing.isActive === false ? false : true,
        testStatus: "active",
        lastError: null,
        existingProviderSpecificData: providerSpecificData,
      });
      return { ...existing, testStatus: "active", providerSpecificData };
    }

    // authType "none" matches the registry's authModes: the bridge holds the
    // credential, this server holds none.
    //
    // accessToken is the noAuth sentinel, not a made-up string. Once a row
    // exists, auth.js stops injecting its synthetic "Public" connection and
    // routes through this one instead — deliberately, so several local
    // accounts can work — so this row's token is what the executor sees.
    // buildHeaders() sends any other value as `Authorization: Bearer …`, which
    // would overwrite a real token on a reverse proxy someone put in front of
    // the bridge. The sentinel is the one value it knows to suppress.
    return await createProviderConnection({
      provider: CHATGPT_WEB_PROVIDER,
      authType: "none",
      accessToken: NOAUTH_TOKEN_SENTINEL,
      name: plan ? `${CONNECTION_NAME} (${plan})` : CONNECTION_NAME,
      displayName: plan ? `${CONNECTION_NAME} (${plan})` : CONNECTION_NAME,
      providerSpecificData,
      testStatus: "active",
      isActive: true,
    });
  } catch (e) {
    // Mirroring must never break signing in, or reading status.
    console.log(`[chatgpt-web] connection sync skipped: ${e.message}`);
    return null;
  }
}

/**
 * Ask the bridge for its state and mirror it, once per server process.
 *
 * Without this, a session signed in before the mirror existed only gets a row
 * when somebody opens the ChatGPT Web card — so the Providers list would keep
 * reading "No connections" for an account that already works. Runs from the
 * deferred startup path, so the bridge's own timeout never delays a request.
 */
export async function syncChatGptWebConnectionFromBridge() {
  g.once ??= (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BRIDGE_STATUS_TIMEOUT_MS);
    try {
      const { chatGptWebSessionUrl } = await import("open-sse/config/chatgptWeb.js");
      const response = await fetch(chatGptWebSessionUrl(), {
        signal: controller.signal,
        cache: "no-store",
        redirect: "manual",
      });
      if (!response.ok) throw new Error(`the bridge answered ${response.status}`);
      return await syncChatGptWebConnection(await response.json());
    } catch (e) {
      // A bridge that is not running is the normal case for most installs;
      // nothing to mirror and nothing to complain about loudly.
      console.log(`[chatgpt-web] bridge not mirrored at startup: ${e.message}`);
      g.once = null;
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  return g.once;
}

/** Drop the mirror row when the operator forgets the session on purpose. */
export async function removeChatGptWebConnection() {
  try {
    const rows = await getProviderConnections({ provider: CHATGPT_WEB_PROVIDER });
    for (const row of rows) await deleteProviderConnection(row.id);
    return rows.length;
  } catch (e) {
    console.log(`[chatgpt-web] connection removal skipped: ${e.message}`);
    return 0;
  }
}
