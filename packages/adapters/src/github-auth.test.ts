import { describe, expect, it, vi } from "vitest";
import { resolveGitHubAuth, type SecretStore, validateGitHubToken } from "./github-auth";
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

const emptyStore = { getGitHubToken: () => Promise.resolve(null) };
const storeWith = (token: string) => ({ getGitHubToken: () => Promise.resolve(token) });

describe("resolveGitHubAuth — the distinct failure states", () => {
  it("not-connected: no stored token, and the network is never touched", async () => {
    const fetch = vi.fn();
    const octokit = createGitHubOctokit({ fetch: fetch as unknown as typeof globalThis.fetch });
    const state = await resolveGitHubAuth({ octokit, secretStore: emptyStore });
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
      secretStore: emptyStore,
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

  it("resolution never WRITES the secret store", async () => {
    const setToken = vi.fn();
    const store: SecretStore = {
      getGitHubToken: () => Promise.resolve("gho_valid"),
      setGitHubToken: setToken,
    };
    const octokit = octokitFor({ "/rate_limit": rateLimitOk, "/user": userOk });
    await resolveGitHubAuth({ octokit, secretStore: store });
    expect(setToken).not.toHaveBeenCalled();
  });
});

describe("validateGitHubToken — the pre-store paste check", () => {
  it("rejects a bad paste as token-invalid WITHOUT any store involvement", async () => {
    const octokit = octokitFor({ "/rate_limit": () => json(401, {}, {}) });
    const state = await validateGitHubToken("ghp_typo", {
      octokit,
      secretStore: emptyStore,
    });
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("token-invalid");
  });

  it("accepts a good paste, carrying its login for the settings row", async () => {
    const octokit = octokitFor({ "/rate_limit": rateLimitOk, "/user": userOk });
    const state = await validateGitHubToken("ghp_good", { octokit, secretStore: emptyStore });
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("unreachable");
    expect(state.login).toBe("rbutera");
  });
});
