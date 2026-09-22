import { describe, it, expect, vi, beforeEach } from "vitest";

const store = { rows: [] };
const created = vi.fn(async (data) => { store.rows.push({ id: "cgw-1", ...data }); return store.rows.at(-1); });
const updated = vi.fn(async () => {});
const deleted = vi.fn(async () => {});

vi.mock("@/models", () => ({
  getProviderConnections: async () => store.rows,
  createProviderConnection: (...a) => created(...a),
  updateProviderConnection: (...a) => updated(...a),
  deleteProviderConnection: (...a) => deleted(...a),
}));

const { syncChatGptWebConnection, removeChatGptWebConnection } =
  await import("@/shared/services/chatGptWebConnection");

beforeEach(() => {
  store.rows = [];
  created.mockClear(); updated.mockClear(); deleted.mockClear();
});

/**
 * Routing reaches the bridge through CHATGPT_WEB_BASE_URL and never needed a
 * connection row, so none was ever created — and everything that counts
 * accounts (the Providers grid, the quota tracker) reads providerConnections.
 * A signed-in bridge therefore read "No connections" no matter what.
 */
describe("chatgpt-web connection mirror", () => {
  it("creates a row once the bridge reports a session", async () => {
    await syncChatGptWebConnection({ signedIn: true, capabilities: { plan: "Plus" } });
    expect(created).toHaveBeenCalledTimes(1);
    const row = created.mock.calls[0][0];
    expect(row.provider).toBe("chatgpt-web");
    expect(row.testStatus).toBe("active");
    expect(row.isActive).toBe(true);
  });

  // authType "none" is what the registry declares (authModes: ["none"]) and is
  // what providerAuthTypes counts on the grid.
  it("stores it with authType none, matching the registry", async () => {
    await syncChatGptWebConnection({ signedIn: true, capabilities: {} });
    expect(created.mock.calls[0][0].authType).toBe("none");
  });

  it("sets no baseUrl, so the bridge URL still comes from the environment", async () => {
    await syncChatGptWebConnection({ signedIn: true, capabilities: {} });
    expect(created.mock.calls[0][0].providerSpecificData.baseUrl).toBeUndefined();
  });

  // auth.js injects its synthetic "Public" connection only while a no-auth
  // provider has no rows, so creating this row moves routing onto it. The token
  // it carries is what the executor sees — and buildHeaders sends anything that
  // is not the sentinel as `Authorization: Bearer …`, which would overwrite a
  // real token on a reverse proxy in front of the bridge.
  it("carries the noAuth sentinel, so no bogus Authorization header is sent", async () => {
    await syncChatGptWebConnection({ signedIn: true, capabilities: {} });
    expect(created.mock.calls[0][0].accessToken).toBe("public");
  });

  it("keeps the account's detected capabilities for the model list", async () => {
    const capabilities = { plan: "Pro", models: ["pro", "high"] };
    await syncChatGptWebConnection({ signedIn: true, capabilities });
    expect(created.mock.calls[0][0].providerSpecificData.capabilities).toEqual(capabilities);
  });

  it("does not create a second row for the same bridge", async () => {
    store.rows = [{ id: "cgw-1", provider: "chatgpt-web", isActive: true, providerSpecificData: {} }];
    await syncChatGptWebConnection({ signedIn: true, capabilities: {} });
    expect(created).not.toHaveBeenCalled();
    expect(updated).toHaveBeenCalledWith("cgw-1", expect.objectContaining({ testStatus: "active" }));
  });

  // A bridge that is restarting should not make the account disappear from the
  // dashboard, and must not silently discard an operator's priority.
  it("marks an existing row expired rather than deleting it when signed out", async () => {
    store.rows = [{ id: "cgw-1", provider: "chatgpt-web", isActive: true, providerSpecificData: {} }];
    await syncChatGptWebConnection({ signedIn: false });
    expect(deleted).not.toHaveBeenCalled();
    expect(updated).toHaveBeenCalledWith("cgw-1", expect.objectContaining({ testStatus: "expired" }));
  });

  it("creates nothing when there is no session and no row", async () => {
    expect(await syncChatGptWebConnection({ signedIn: false })).toBeNull();
    expect(created).not.toHaveBeenCalled();
  });

  it("does not switch a row back on that was disabled on purpose", async () => {
    store.rows = [{ id: "cgw-1", provider: "chatgpt-web", isActive: false, providerSpecificData: {} }];
    await syncChatGptWebConnection({ signedIn: true, capabilities: {} });
    expect(updated.mock.calls[0][1].isActive).toBe(false);
  });

  // Forgetting the session is deliberate, unlike a bridge being unreachable.
  it("removes the row when the session is forgotten", async () => {
    store.rows = [{ id: "cgw-1", provider: "chatgpt-web" }];
    expect(await removeChatGptWebConnection()).toBe(1);
    expect(deleted).toHaveBeenCalledWith("cgw-1");
  });

  it("never lets a mirror failure break signing in", async () => {
    created.mockRejectedValueOnce(new Error("db exploded"));
    await expect(syncChatGptWebConnection({ signedIn: true, capabilities: {} })).resolves.toBeNull();
  });
});
