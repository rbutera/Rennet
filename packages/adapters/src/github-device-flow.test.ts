import { describe, expect, it, vi } from "vitest";
import {
  RENNET_GITHUB_CLIENT_ID,
  RENNET_GITHUB_SCOPES,
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

describe("runGitHubDeviceFlow", () => {
  it("mints the device code, surfaces the verification, and polls to a token", async () => {
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
      // First poll: still pending; second poll: authorized.
      if (polls === 1) return json({ error: "authorization_pending" });
      return json({ access_token: "gho_minted", token_type: "bearer", scope: "repo,workflow" });
    };

    const onVerification = vi.fn<(verification: Verification) => void>();
    const { token } = await runGitHubDeviceFlow({ fetch, onVerification });

    expect(token).toBe("gho_minted");
    expect(onVerification).toHaveBeenCalledOnce();
    expect(onVerification.mock.calls[0]?.[0]?.user_code).toBe("ABCD-1234");
    expect(onVerification.mock.calls[0]?.[0]?.verification_uri).toBe(
      "https://github.com/login/device",
    );
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

  it("exports the committed client id and the repo+workflow scopes", () => {
    expect(RENNET_GITHUB_CLIENT_ID).toMatch(/^Ov23li/);
    expect(RENNET_GITHUB_SCOPES).toEqual(["repo", "workflow"]);
  });
});
