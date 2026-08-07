import { describe, expect, it, vi } from "vitest";
import { type GhRunner, type HttpFetch, resolveGitHubAuth, type SecretStore } from "./github-auth";

function response(status: number, headers: Record<string, string>, body = "{}") {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(body),
  };
}

const emptySecretStore: SecretStore = { getGitHubToken: () => Promise.resolve(null) };

const rateLimitOk: HttpFetch = () =>
  Promise.resolve(
    response(200, {
      "X-OAuth-Scopes": "repo, read:org, gist",
      "Github-Authentication-Token-Expiration": "2026-12-31 00:00:00 +0000",
      "X-RateLimit-Limit": "5000",
    }),
  );

describe("resolveGitHubAuth — the three distinct failure states", () => {
  it("gh-absent: gh is not installed and there is no pasted token", async () => {
    const gh: GhRunner = () =>
      Promise.reject(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
    const state = await resolveGitHubAuth({ gh, http: rateLimitOk, secretStore: emptySecretStore });
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("gh-absent");
    expect(state.copy.length).toBeGreaterThan(0);
  });

  it("gh-not-logged-in: gh is present but `gh auth token` exits non-zero", async () => {
    const gh: GhRunner = () =>
      Promise.resolve({ stdout: "", stderr: "not logged in", exitCode: 1 });
    const state = await resolveGitHubAuth({ gh, http: rateLimitOk, secretStore: emptySecretStore });
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error("unreachable");
    expect(state.reason).toBe("gh-not-logged-in");
    expect(state.copy.length).toBeGreaterThan(0);
  });

  it("insufficient-scope: a token is obtained but /rate_limit shows no `repo` scope", async () => {
    const gh: GhRunner = () => Promise.resolve({ stdout: "gho_token\n", stderr: "", exitCode: 0 });
    const http: HttpFetch = () =>
      Promise.resolve(
        response(200, { "X-OAuth-Scopes": "gist, read:user", "X-RateLimit-Limit": "5000" }),
      );
    const state = await resolveGitHubAuth({ gh, http, secretStore: emptySecretStore });
    expect(state.ok).toBe(false);
    if (state.ok || state.reason !== "insufficient-scope") throw new Error("unreachable");
    expect(state.reason).toBe("insufficient-scope");
    expect(state.scopes).toEqual(["gist", "read:user"]);
    expect(state.copy.length).toBeGreaterThan(0);
  });

  it("the three failure states are pairwise DISTINCT in both reason and copy", async () => {
    const absent = await resolveGitHubAuth({
      gh: () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
      http: rateLimitOk,
      secretStore: emptySecretStore,
    });
    const loggedOut = await resolveGitHubAuth({
      gh: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 1 }),
      http: rateLimitOk,
      secretStore: emptySecretStore,
    });
    const noScope = await resolveGitHubAuth({
      gh: () => Promise.resolve({ stdout: "t\n", stderr: "", exitCode: 0 }),
      http: () => Promise.resolve(response(200, { "X-OAuth-Scopes": "gist" })),
      secretStore: emptySecretStore,
    });
    const reasons = [absent, loggedOut, noScope].map((s) => (s.ok ? "ok" : s.reason));
    const copies = [absent, loggedOut, noScope].map((s) => (s.ok ? "" : s.copy));
    expect(new Set(reasons).size).toBe(3);
    expect(new Set(copies).size).toBe(3);
  });
});

describe("resolveGitHubAuth — success and rungs", () => {
  it("rung 0 (gh): valid token with repo scope succeeds and reads expiry + rate limit", async () => {
    const gh: GhRunner = () => Promise.resolve({ stdout: "gho_valid\n", stderr: "", exitCode: 0 });
    const state = await resolveGitHubAuth({ gh, http: rateLimitOk, secretStore: emptySecretStore });
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("unreachable");
    expect(state.rung).toBe("gh");
    expect(state.token).toBe("gho_valid");
    expect(state.scopes).toContain("repo");
    expect(state.expiresAt).toBe("2026-12-31 00:00:00 +0000");
    expect(state.rateLimit).toBe(5000);
  });

  it("the rung-0 token is NEVER persisted (no secret-store write on the gh path)", async () => {
    const setToken = vi.fn();
    // A secret store that also exposes a write; resolveGitHubAuth must never call it.
    const secretStore = { getGitHubToken: () => Promise.resolve(null), setGitHubToken: setToken };
    const gh: GhRunner = () => Promise.resolve({ stdout: "gho_valid\n", stderr: "", exitCode: 0 });
    await resolveGitHubAuth({ gh, http: rateLimitOk, secretStore });
    expect(setToken).not.toHaveBeenCalled();
  });

  it("rung 2 (pat): falls back to a pasted token when gh is absent", async () => {
    const gh: GhRunner = () =>
      Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const secretStore: SecretStore = { getGitHubToken: () => Promise.resolve("ghp_pasted") };
    let seenAuth: string | undefined;
    const http: HttpFetch = (_url, init) => {
      seenAuth = init?.headers?.Authorization;
      return rateLimitOk(_url, init);
    };
    const state = await resolveGitHubAuth({ gh, http, secretStore });
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("unreachable");
    expect(state.rung).toBe("pat");
    expect(state.token).toBe("ghp_pasted");
    expect(seenAuth).toBe("Bearer ghp_pasted");
  });
});
