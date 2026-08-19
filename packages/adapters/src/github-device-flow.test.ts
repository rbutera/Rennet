import { describe, expect, it, vi } from "vitest";
import {
  GitHubOAuthDeclined,
  RENNET_GITHUB_CLIENT_ID,
  RENNET_GITHUB_SCOPES,
  refreshGitHubCredential,
  runGitHubDeviceFlow,
  type Verification,
} from "./github-device-flow";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const VERIFICATION = {
  device_code: "dev-code-1",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 0.005, // 5ms so the poll loop is fast in tests
};

const NOW = Date.parse("2026-08-19T12:00:00.000Z");

describe("runGitHubDeviceFlow", () => {
  it("mints the code, surfaces verification, polls to a NON-EXPIRING credential", async () => {
    const sent: { url: string; params: Record<string, unknown> }[] = [];
    let polls = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      const params = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      sent.push({ url, params });
      if (url.includes("/login/device/code")) return json(VERIFICATION);
      polls += 1;
      // First poll: still pending; second poll: authorized (expiration OFF).
      if (polls === 1) return json({ error: "authorization_pending" });
      return json({ access_token: "gho_minted", token_type: "bearer", scope: "repo,workflow" });
    };

    const onVerification = vi.fn<(verification: Verification) => void>();
    const credential = await runGitHubDeviceFlow({ fetch, onVerification });

    expect(credential).toEqual({
      token: "gho_minted",
      expiresAt: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
    });
    expect(onVerification).toHaveBeenCalledOnce();
    expect(onVerification.mock.calls[0]?.[0]?.user_code).toBe("ABCD-1234");
    // The device-code mint carries Rennet's public client id and both scopes —
    // and NEVER a client secret (there is none; no Rennet backend).
    const mint = sent.find((s) => s.url.includes("/login/device/code"));
    expect(mint?.params.client_id).toBe(RENNET_GITHUB_CLIENT_ID);
    expect(String(mint?.params.scope)).toContain("repo");
    expect(String(mint?.params.scope)).toContain("workflow");
    expect(JSON.stringify(sent)).not.toMatch(/client_secret/);
    // The flow hits ONLY github.com login endpoints — no Rennet backend, ever.
    expect(sent.every((s) => s.url.includes("github.com/login/"))).toBe(true);
  });

  it("captures the EXPIRING credential half: expiresAt + rotating refresh token", async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      if (String(input).includes("/login/device/code")) return json(VERIFICATION);
      return json({
        access_token: "gho_expiring",
        expires_in: 28800, // GitHub's 8 hours
        refresh_token: "ghr_refresh1",
        refresh_token_expires_in: 15811200, // ~6 months
      });
    };
    const credential = await runGitHubDeviceFlow({
      fetch,
      onVerification: () => undefined,
      now: () => NOW,
    });
    expect(credential.token).toBe("gho_expiring");
    expect(credential.refreshToken).toBe("ghr_refresh1");
    expect(credential.expiresAt).toBe(new Date(NOW + 28800 * 1000).toISOString());
    expect(credential.refreshTokenExpiresAt).toBe(new Date(NOW + 15811200 * 1000).toISOString());
  });

  it("honours slow_down back-pressure with GitHub's named interval", async () => {
    let polls = 0;
    const pollTimes: number[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      if (String(input).includes("/login/device/code")) return json(VERIFICATION);
      polls += 1;
      pollTimes.push(Date.now());
      if (polls === 1) return json({ error: "slow_down", interval: 0.02 });
      return json({ access_token: "gho_minted" });
    };
    await runGitHubDeviceFlow({ fetch, onVerification: () => undefined });
    expect(polls).toBe(2);
    // The second poll waited the SLOWER interval (20ms), not the original 5ms.
    const gap = (pollTimes[1] ?? 0) - (pollTimes[0] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(15);
  });

  it("throws GitHubOAuthDeclined when the user denies (never polls forever)", async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      if (String(input).includes("/login/device/code")) return json(VERIFICATION);
      return json({ error: "access_denied" });
    };
    await expect(runGitHubDeviceFlow({ fetch, onVerification: () => undefined })).rejects.toThrow(
      GitHubOAuthDeclined,
    );
  });

  it("rejects when the signal aborts instead of polling forever", async () => {
    const controller = new AbortController();
    const fetch: typeof globalThis.fetch = async (input) => {
      if (String(input).includes("/login/device/code")) return json(VERIFICATION);
      // The first poll aborts the flow (as if the user dismissed the card).
      controller.abort();
      return json({ error: "authorization_pending" });
    };
    await expect(
      runGitHubDeviceFlow({
        fetch,
        onVerification: (verification) => void verification,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("enforces the device code's OWN deadline even if GitHub never says expired", async () => {
    // A spec-violating upstream (or a proxy mangling the error) keeps answering
    // authorization_pending forever; the local expires_in deadline still ends it.
    let clock = Date.parse("2026-08-19T12:00:00.000Z");
    const fetch: typeof globalThis.fetch = async (input) => {
      if (String(input).includes("/login/device/code"))
        return json({ ...VERIFICATION, expires_in: 1 }); // 1-second code lifetime
      clock += 10_000; // each poll costs 10s of wall clock
      return json({ error: "authorization_pending" });
    };
    await expect(
      runGitHubDeviceFlow({ fetch, onVerification: () => undefined, now: () => clock }),
    ).rejects.toThrow(/expired_token/);
  });

  it("exports the committed client id and the repo+workflow scopes", () => {
    expect(RENNET_GITHUB_CLIENT_ID).toMatch(/^Ov23li/);
    expect(RENNET_GITHUB_SCOPES).toEqual(["repo", "workflow"]);
  });
});

describe("refreshGitHubCredential", () => {
  it("exchanges the refresh token with grant_type=refresh_token and NO secret", async () => {
    let params: Record<string, unknown> = {};
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      params = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      return json({
        access_token: "gho_rotated",
        expires_in: 28800,
        refresh_token: "ghr_refresh2",
        refresh_token_expires_in: 15811200,
      });
    };
    const credential = await refreshGitHubCredential({
      fetch,
      refreshToken: "ghr_refresh1",
      now: () => NOW,
    });
    expect(params).toEqual({
      client_id: RENNET_GITHUB_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "ghr_refresh1",
    });
    // GitHub ROTATES: the response carries a NEW refresh token to persist.
    expect(credential.token).toBe("gho_rotated");
    expect(credential.refreshToken).toBe("ghr_refresh2");
    expect(credential.expiresAt).toBe(new Date(NOW + 28800 * 1000).toISOString());
  });

  it("throws GitHubOAuthDeclined on bad_refresh_token (sign-in must be re-run)", async () => {
    const fetch: typeof globalThis.fetch = async () => json({ error: "bad_refresh_token" });
    await expect(refreshGitHubCredential({ fetch, refreshToken: "ghr_dead" })).rejects.toThrow(
      GitHubOAuthDeclined,
    );
  });

  it("propagates a transport failure as-is (a network blip is not a dead session)", async () => {
    const fetch: typeof globalThis.fetch = async () => new Response("bad gateway", { status: 502 });
    await expect(refreshGitHubCredential({ fetch, refreshToken: "ghr_ok" })).rejects.toThrow(/502/);
  });
});
