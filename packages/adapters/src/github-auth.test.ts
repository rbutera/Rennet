import { describe, expect, it, vi } from "vitest";
import {
  type RefreshLogRecord,
  resolveGitHubAuth,
  type SecretStore,
  tokenKind,
  validateGitHubToken,
} from "./github-auth";
import type { GitHubCredential } from "./github-device-flow";
import { GitHubOAuthDeclined } from "./github-device-flow";
import { createGitHubOctokit } from "./github-octokit";

/** A fake GitHub: routes by path, returns real `Response`s (octokit's transport). */
function fakeGitHub(routes: Record<string, () => Response>): typeof globalThis.fetch {
  return (input) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return Promise.resolve(json(404, {}, { message: "not found" }));
    return Promise.resolve(route());
  };
}

function json(status: number, headers: Record<string, string>, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const rateLimitOk = () =>
  json(
    200,
    {
      "X-OAuth-Scopes": "repo, workflow, read:org",
      "Github-Authentication-Token-Expiration": "2026-12-31 00:00:00 +0000",
      "X-RateLimit-Limit": "5000",
    },
    { resources: {} },
  );

const userOk = () => json(200, {}, { login: "rbutera" });

function octokitFor(routes: Record<string, () => Response>) {
  return createGitHubOctokit({ fetch: fakeGitHub(routes) });
}

/** An in-memory credential store with a recording write. */
function memoryStore(initial: GitHubCredential | null): SecretStore & {
  current: () => GitHubCredential | null;
  writes: GitHubCredential[];
  setGitHubCredentialSync?: (next: GitHubCredential) => void;
} {
  let credential = initial;
  const writes: GitHubCredential[] = [];
  return {
    getGitHubCredential: () => Promise.resolve(credential),
    setGitHubCredential: (next) => {
      credential = next;
      if (next) writes.push(next);
      return Promise.resolve();
    },
    current: () => credential,
    writes,
    setGitHubCredentialSync: (next: GitHubCredential) => {
      credential = next;
    },
  };
}

const storeWith = (token: string) => memoryStore({ token });
const emptyStore = () => memoryStore(null);

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const SOON = new Date(NOW + 60 * 1000).toISOString(); // inside the 5-min skew
const LATER = new Date(NOW + 6 * 60 * 60 * 1000).toISOString(); // hours away

describe("resolveGitHubAuth — the distinct failure states", () => {
  it("not-connected: no stored credential, and the network is never touched", async () => {
    const fetch = vi.fn();
    const octokit = createGitHubOctokit({ fetch: fetch as unknown as typeof globalThis.fetch });
    const state = await resolveGitHubAuth({ octokit, secretStore: emptyStore() });
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("not-connected");
    expect(state.copy.length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("token-invalid: a stored token that /rate_limit rejects with 401", async () => {
    const octokit = octokitFor({
      "/rate_limit": () => json(401, {}, { message: "Bad credentials" }),
    });
    const state = await resolveGitHubAuth({ octokit, secretStore: storeWith("gho_revoked") });
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("token-invalid");
    expect(state.copy.length).toBeGreaterThan(0);
  });

  it("insufficient-scope: a valid token whose scopes lack `repo`", async () => {
    const octokit = octokitFor({
      "/rate_limit": () => json(200, { "X-OAuth-Scopes": "gist, read:user" }, { resources: {} }),
    });
    const state = await resolveGitHubAuth({ octokit, secretStore: storeWith("gho_narrow") });
    expect(state.ok).toBe(false);
    if (state.ok || state.reason !== "insufficient-scope") throw new Error("unreachable");
    expect(state.scopes).toEqual(["gist", "read:user"]);
    expect(state.copy.length).toBeGreaterThan(0);
  });

  it("the three failure states are pairwise DISTINCT in both reason and copy", async () => {
    const notConnected = await resolveGitHubAuth({
      octokit: octokitFor({}),
      secretStore: emptyStore(),
    });
    const invalid = await resolveGitHubAuth({
      octokit: octokitFor({ "/rate_limit": () => json(401, {}, {}) }),
      secretStore: storeWith("t"),
    });
    const noScope = await resolveGitHubAuth({
      octokit: octokitFor({
        "/rate_limit": () => json(200, { "X-OAuth-Scopes": "gist" }, { resources: {} }),
      }),
      secretStore: storeWith("t"),
    });
    const states = [notConnected, invalid, noScope];
    const reasons = states.map((s) => (s.ok ? "ok" : s.reason));
    const copies = states.map((s) => (s.ok ? "" : s.copy));
    expect(new Set(reasons).size).toBe(3);
    expect(new Set(copies).size).toBe(3);
  });
});

describe("resolveGitHubAuth — success", () => {
  it("a stored token with repo scope succeeds: scopes, expiry, rate limit, login", async () => {
    const octokit = octokitFor({ "/rate_limit": rateLimitOk, "/user": userOk });
    const state = await resolveGitHubAuth({ octokit, secretStore: storeWith("gho_valid") });
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("unreachable");
    expect(state.token).toBe("gho_valid");
    expect(state.login).toBe("rbutera");
    expect(state.scopes).toContain("repo");
    expect(state.scopes).toContain("workflow");
    expect(state.expiresAt).toBe("2026-12-31 00:00:00 +0000");
    expect(state.rateLimit).toBe(5000);
  });

  it("the candidate token rides as the Authorization header on validation", async () => {
    let seenAuth: string | null = null;
    const fetch: typeof globalThis.fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      if (new URL(String(input)).pathname === "/rate_limit") {
        seenAuth = headers.get("authorization");
        return Promise.resolve(rateLimitOk());
      }
      return Promise.resolve(userOk());
    };
    const octokit = createGitHubOctokit({ fetch });
    await resolveGitHubAuth({ octokit, secretStore: storeWith("ghp_pasted") });
    expect(seenAuth).toBe("Bearer ghp_pasted");
  });

  it("a /user failure never fails auth — login degrades to null", async () => {
    const octokit = octokitFor({
      "/rate_limit": rateLimitOk,
      "/user": () => json(500, {}, { message: "boom" }),
    });
    const state = await resolveGitHubAuth({ octokit, secretStore: storeWith("gho_valid") });
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("unreachable");
    expect(state.login).toBeNull();
  });

  it("resolution never WRITES the store when nothing needed refreshing", async () => {
    const store = storeWith("gho_valid");
    const octokit = octokitFor({ "/rate_limit": rateLimitOk, "/user": userOk });
    await resolveGitHubAuth({ octokit, secretStore: store });
    expect(store.writes).toEqual([]);
  });
});

describe("resolveGitHubAuth — the refresh half (expiring-token apps)", () => {
  const ROTATED: GitHubCredential = {
    token: "gho_rotated",
    expiresAt: new Date(NOW + 8 * 60 * 60 * 1000).toISOString(),
    refreshToken: "ghr_next",
    refreshTokenExpiresAt: new Date(NOW + 180 * 24 * 60 * 60 * 1000).toISOString(),
  };

  it("refreshes PROACTIVELY near expiry, persists the rotated pair, uses the new token", async () => {
    const store = memoryStore({ token: "gho_dying", expiresAt: SOON, refreshToken: "ghr_1" });
    let validated: string | null = null;
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (new URL(String(input)).pathname === "/rate_limit") {
        validated = new Headers(init?.headers).get("authorization");
        return Promise.resolve(rateLimitOk());
      }
      return Promise.resolve(userOk());
    };
    const refresh = vi.fn(() => Promise.resolve(ROTATED));
    const state = await resolveGitHubAuth({
      octokit: createGitHubOctokit({ fetch }),
      secretStore: store,
      refresh,
      now: () => NOW,
    });
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("unreachable");
    expect(refresh).toHaveBeenCalledWith("ghr_1");
    expect(state.token).toBe("gho_rotated");
    expect(validated).toBe("Bearer gho_rotated"); // the dying token never hit GitHub
    // The rotated pair is PERSISTED — GitHub killed the old one on exchange.
    expect(store.current()).toEqual(ROTATED);
  });

  it("does NOT refresh a credential whose expiry is comfortably away", async () => {
    const store = memoryStore({ token: "gho_fresh", expiresAt: LATER, refreshToken: "ghr_1" });
    const refresh = vi.fn(() => Promise.resolve(ROTATED));
    const octokit = octokitFor({ "/rate_limit": rateLimitOk, "/user": userOk });
    const state = await resolveGitHubAuth({
      octokit,
      secretStore: store,
      refresh,
      now: () => NOW,
    });
    expect(state.ok).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes REACTIVELY on an unexpected 401, once, then re-validates", async () => {
    const store = memoryStore({ token: "gho_revoked", expiresAt: LATER, refreshToken: "ghr_1" });
    const fetch: typeof globalThis.fetch = (input, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (new URL(String(input)).pathname === "/rate_limit") {
        return Promise.resolve(auth === "Bearer gho_rotated" ? rateLimitOk() : json(401, {}, {}));
      }
      return Promise.resolve(userOk());
    };
    const refresh = vi.fn(() => Promise.resolve(ROTATED));
    const state = await resolveGitHubAuth({
      octokit: createGitHubOctokit({ fetch }),
      secretStore: store,
      refresh,
      now: () => NOW,
    });
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("unreachable");
    expect(state.token).toBe("gho_rotated");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.current()).toEqual(ROTATED);
  });

  it("a DECLINED refresh is token-invalid with the renewal copy — reconnect is the fix", async () => {
    const store = memoryStore({ token: "gho_dying", expiresAt: SOON, refreshToken: "ghr_dead" });
    const refresh = vi.fn(() => Promise.reject(new GitHubOAuthDeclined("bad_refresh_token")));
    const state = await resolveGitHubAuth({
      octokit: octokitFor({}),
      secretStore: store,
      refresh,
      now: () => NOW,
    });
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("token-invalid");
    expect(state.copy).toContain("could not be renewed");
    // Nothing was persisted; the store still holds the old credential.
    expect(store.writes).toEqual([]);
  });

  it("a transport failure during refresh PROPAGATES (never a lying dead-session)", async () => {
    const store = memoryStore({ token: "gho_dying", expiresAt: SOON, refreshToken: "ghr_1" });
    const refresh = vi.fn(() => Promise.reject(new Error("ECONNRESET")));
    await expect(
      resolveGitHubAuth({ octokit: octokitFor({}), secretStore: store, refresh, now: () => NOW }),
    ).rejects.toThrow("ECONNRESET");
  });

  it("a MALFORMED expiresAt refreshes immediately (self-heals, never silently disables)", async () => {
    const store = memoryStore({ token: "gho_odd", expiresAt: "not-a-date", refreshToken: "ghr_1" });
    const refresh = vi.fn(() => Promise.resolve(ROTATED));
    const fetch: typeof globalThis.fetch = (input) =>
      Promise.resolve(new URL(String(input)).pathname === "/rate_limit" ? rateLimitOk() : userOk());
    const state = await resolveGitHubAuth({
      octokit: createGitHubOctokit({ fetch }),
      secretStore: store,
      refresh,
      now: () => NOW,
    });
    expect(state.ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.current()).toEqual(ROTATED);
  });

  it("a resolution that LOST the rotation race adopts the winner's pair, never re-refreshes", async () => {
    // The exclusive section re-reads the credential: by the time this caller gets
    // the lock, another resolution already rotated. Burning the old refresh token
    // again would kill the session — the loser must adopt, not exchange.
    const store = memoryStore({ token: "gho_dying", expiresAt: SOON, refreshToken: "ghr_old" });
    const refresh = vi.fn(() => Promise.resolve(ROTATED));
    const withLock = async <T>(section: () => Promise<T>): Promise<T> => {
      // Simulate the winner completing while this caller waited for the lock.
      store.setGitHubCredentialSync?.(ROTATED);
      return section();
    };
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (new URL(String(input)).pathname === "/rate_limit") {
        const auth = new Headers(init?.headers).get("authorization");
        return Promise.resolve(auth === "Bearer gho_rotated" ? rateLimitOk() : json(401, {}, {}));
      }
      return Promise.resolve(userOk());
    };
    const state = await resolveGitHubAuth({
      octokit: createGitHubOctokit({ fetch }),
      secretStore: store,
      refresh,
      withLock,
      now: () => NOW,
    });
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("unreachable");
    expect(state.token).toBe("gho_rotated");
    expect(refresh).not.toHaveBeenCalled(); // the loser adopted; no second exchange
  });

  it("a credential with NO refresh token (pasted PAT) never attempts a refresh", async () => {
    const store = memoryStore({ token: "ghp_pat", expiresAt: SOON });
    const refresh = vi.fn(() => Promise.resolve(ROTATED));
    const octokit = octokitFor({ "/rate_limit": rateLimitOk, "/user": userOk });
    const state = await resolveGitHubAuth({
      octokit,
      secretStore: store,
      refresh,
      now: () => NOW,
    });
    expect(state.ok).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("resolveGitHubAuth — fine-grained tokens", () => {
  it("accepts a token with NO X-OAuth-Scopes header (fine-grained PAT / App token)", async () => {
    // FG-PATs and GitHub App tokens send no scopes header at all. Absent header =
    // scopes unknowable, never "no scopes" — the side door must accept them.
    const octokit = octokitFor({
      "/rate_limit": () => json(200, { "X-RateLimit-Limit": "5000" }, { resources: {} }),
      "/user": userOk,
    });
    const state = await resolveGitHubAuth({ octokit, secretStore: storeWith("github_pat_fg") });
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("unreachable");
    expect(state.scopes).toEqual([]);
    expect(state.login).toBe("rbutera");
  });

  it("still rejects a PRESENT scopes header that lacks repo", async () => {
    const octokit = octokitFor({
      "/rate_limit": () => json(200, { "X-OAuth-Scopes": "gist" }, { resources: {} }),
    });
    const state = await resolveGitHubAuth({ octokit, secretStore: storeWith("gho_narrow") });
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("insufficient-scope");
  });
});

describe("validateGitHubToken — the pre-store paste check", () => {
  it("rejects a bad paste as token-invalid WITHOUT any store involvement", async () => {
    const octokit = octokitFor({ "/rate_limit": () => json(401, {}, {}) });
    const state = await validateGitHubToken("ghp_typo", { octokit });
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("token-invalid");
  });

  it("accepts a good paste, carrying its login for the settings row", async () => {
    const octokit = octokitFor({ "/rate_limit": rateLimitOk, "/user": userOk });
    const state = await validateGitHubToken("ghp_good", { octokit });
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("unreachable");
    expect(state.login).toBe("rbutera");
  });
});

describe("resolveGitHubAuth — network failure (the lancelot field bug)", () => {
  /** What undici throws through octokit when GitHub is unreachable. */
  const unreachable = () => {
    const undici = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    return Object.assign(new TypeError("fetch failed"), { cause: undici });
  };
  const unreachableFetch: typeof globalThis.fetch = () => Promise.reject(unreachable());

  it("an unreachable GitHub is reason network — NEVER token-invalid", async () => {
    const octokit = createGitHubOctokit({ fetch: unreachableFetch });
    const state = await resolveGitHubAuth({ octokit, secretStore: storeWith("gho_fine") });
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("network");
    expect(state.copy).toContain("unreachable");
  });

  it("a deadline abort (TimeoutError) is reason network too", async () => {
    const timedOut: typeof globalThis.fetch = () =>
      Promise.reject(
        Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        }),
      );
    const octokit = createGitHubOctokit({ fetch: timedOut });
    const state = await resolveGitHubAuth({ octokit, secretStore: storeWith("gho_fine") });
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("network");
  });

  it("a transport failure during the PROACTIVE refresh degrades to network — session untouched", async () => {
    const store = memoryStore({ token: "gho_dying", expiresAt: SOON, refreshToken: "ghr_1" });
    const octokit = octokitFor({ "/rate_limit": rateLimitOk, "/user": userOk });
    const state = await resolveGitHubAuth({
      octokit,
      secretStore: store,
      refresh: () => Promise.reject(unreachable()),
      now: () => NOW,
    });
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("network");
    // The stored pair survives: GitHub only rotates on success, so nothing is lost.
    expect(store.writes).toEqual([]);
    expect(store.current()?.refreshToken).toBe("ghr_1");
  });

  it("a transport failure during the REACTIVE refresh is network, not a dead session", async () => {
    const store = memoryStore({ token: "gho_revoked", expiresAt: LATER, refreshToken: "ghr_1" });
    const octokit = octokitFor({
      "/rate_limit": () => json(401, {}, { message: "Bad credentials" }),
    });
    const state = await resolveGitHubAuth({
      octokit,
      secretStore: store,
      refresh: () => Promise.reject(unreachable()),
      now: () => NOW,
    });
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("network");
    expect(store.writes).toEqual([]);
  });
});

describe("tokenKind — the closed prefix allowlist", () => {
  it("maps known GitHub prefixes to their own prefix", () => {
    expect(tokenKind("ghu_ABC")).toBe("ghu_");
    expect(tokenKind("gho_ABC")).toBe("gho_");
    expect(tokenKind("github_pat_ABC")).toBe("github_pat_");
  });

  it("maps an unrecognized value to the fixed 'token' label, never a slice of it", () => {
    // Must NEVER return "customerSecret_" — that would leak a slice of an
    // unexpected credential body into a log record.
    expect(tokenKind("customerSecret_body")).toBe("token");
    expect(tokenKind("customerSecret_body")).not.toBe("customerSecret_");
  });

  it("maps a value with no underscore to 'token'", () => {
    expect(tokenKind("plainvalue")).toBe("token");
  });
});

describe("resolveGitHubAuth — refresh log records (RefreshLogRecord)", () => {
  const ROTATED_GHU: GitHubCredential = {
    token: "ghu_rotated_kind",
    expiresAt: new Date(NOW + 8 * 60 * 60 * 1000).toISOString(),
    refreshToken: "ghr_next_kind",
    refreshTokenExpiresAt: new Date(NOW + 180 * 24 * 60 * 60 * 1000).toISOString(),
  };

  it("a DECLINED refresh emits a `declined` record carrying the verbatim githubError", async () => {
    const store = memoryStore({ token: "gho_dying", expiresAt: SOON, refreshToken: "ghr_dead" });
    const records: RefreshLogRecord[] = [];
    const refresh = vi.fn(() => Promise.reject(new GitHubOAuthDeclined("bad_refresh_token")));
    const state = await resolveGitHubAuth({
      octokit: octokitFor({}),
      secretStore: store,
      refresh,
      now: () => NOW,
      log: (record) => records.push(record),
    });
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("token-invalid");
    const declined = records.find((r) => r.phase === "declined");
    expect(declined).toBeDefined();
    expect(declined?.githubError).toBe("bad_refresh_token");
  });

  it("a NETWORK-failing refresh emits exactly [attempt, network], resolves network, leaves the credential untouched, and calls refresh() exactly once", async () => {
    const original: GitHubCredential = {
      token: "gho_dying",
      expiresAt: SOON,
      refreshToken: "ghr_1",
    };
    const store = memoryStore({ ...original });
    const records: RefreshLogRecord[] = [];
    const networkError = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const refresh = vi.fn(() => Promise.reject(networkError));
    const state = await resolveGitHubAuth({
      octokit: octokitFor({}),
      secretStore: store,
      refresh,
      now: () => NOW,
      log: (record) => records.push(record),
    });
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("network");
    // Exactly attempt then network — no retry phase, no extra records.
    expect(records).toEqual([{ phase: "attempt" }, { phase: "network" }]);
    // The stored credential is byte-unchanged: no write happened at all.
    expect(store.writes).toEqual([]);
    expect(store.current()).toEqual(original);
    // The no-adapter-retry guarantee: the transport (not github-auth) owns retry.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a SUCCESSFUL refresh emits a `persisted` record with an allowlisted tokenKind, and persists the rotated pair", async () => {
    const store = memoryStore({ token: "gho_dying", expiresAt: SOON, refreshToken: "ghr_1" });
    const records: RefreshLogRecord[] = [];
    const refresh = vi.fn(() => Promise.resolve(ROTATED_GHU));
    const fetch: typeof globalThis.fetch = (input) =>
      Promise.resolve(new URL(String(input)).pathname === "/rate_limit" ? rateLimitOk() : userOk());
    const state = await resolveGitHubAuth({
      octokit: createGitHubOctokit({ fetch }),
      secretStore: store,
      refresh,
      now: () => NOW,
      log: (record) => records.push(record),
    });
    expect(state.ok).toBe(true);
    const persisted = records.find((r) => r.phase === "persisted");
    expect(persisted).toBeDefined();
    expect(persisted?.tokenKind).toBe("ghu_");
    expect(store.current()).toEqual(ROTATED_GHU);
  });
});

describe("resolveGitHubAuth — refresh log records never carry a secret", () => {
  const SENTINEL_OLD_ACCESS = "gho_SENTINEL_OLD_ACCESS_1a2b3c4d";
  const SENTINEL_OLD_REFRESH = "ghr_SENTINEL_OLD_REFRESH_5e6f7a8b";
  const SENTINEL_NEW_ACCESS = "ghu_SENTINEL_NEW_ACCESS_9c0d1e2f";
  const SENTINEL_NEW_REFRESH = "ghr_SENTINEL_NEW_REFRESH_3a4b5c6d";

  it("a full successful refresh (attempt -> persisted) never leaks either token into a record", async () => {
    const store = memoryStore({
      token: SENTINEL_OLD_ACCESS,
      expiresAt: SOON,
      refreshToken: SENTINEL_OLD_REFRESH,
    });
    const records: RefreshLogRecord[] = [];
    const rotated: GitHubCredential = {
      token: SENTINEL_NEW_ACCESS,
      expiresAt: new Date(NOW + 8 * 60 * 60 * 1000).toISOString(),
      refreshToken: SENTINEL_NEW_REFRESH,
      refreshTokenExpiresAt: new Date(NOW + 180 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const refresh = vi.fn(() => Promise.resolve(rotated));
    const fetch: typeof globalThis.fetch = (input) =>
      Promise.resolve(new URL(String(input)).pathname === "/rate_limit" ? rateLimitOk() : userOk());
    const state = await resolveGitHubAuth({
      octokit: createGitHubOctokit({ fetch }),
      secretStore: store,
      refresh,
      now: () => NOW,
      log: (record) => records.push(record),
    });
    expect(state.ok).toBe(true);
    expect(records.map((r) => r.phase)).toEqual(["attempt", "persisted"]);
    for (const record of records) {
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain(SENTINEL_OLD_ACCESS);
      expect(serialized).not.toContain(SENTINEL_OLD_REFRESH);
      expect(serialized).not.toContain(SENTINEL_NEW_ACCESS);
      expect(serialized).not.toContain(SENTINEL_NEW_REFRESH);
    }
  });

  it("a network-failing refresh never leaks the stored tokens into a record", async () => {
    const store = memoryStore({
      token: SENTINEL_OLD_ACCESS,
      expiresAt: SOON,
      refreshToken: SENTINEL_OLD_REFRESH,
    });
    const records: RefreshLogRecord[] = [];
    const networkError = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const refresh = vi.fn(() => Promise.reject(networkError));
    const state = await resolveGitHubAuth({
      octokit: octokitFor({}),
      secretStore: store,
      refresh,
      now: () => NOW,
      log: (record) => records.push(record),
    });
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("network");
    for (const record of records) {
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain(SENTINEL_OLD_ACCESS);
      expect(serialized).not.toContain(SENTINEL_OLD_REFRESH);
    }
  });
});
