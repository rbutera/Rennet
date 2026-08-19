import { describe, expect, it, vi } from "vitest";
import { withConnectResilience } from "./github-fetch";

const ok = () => new Response("{}", { status: 200 });
const connectTimeout = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
  });

describe("withConnectResilience", () => {
  it("passes a clean response straight through — one call, no delay", async () => {
    const inner = vi.fn(async () => ok());
    const fetch = withConnectResilience(inner as unknown as typeof globalThis.fetch, 1);
    const res = await fetch("https://api.github.com/rate_limit");
    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("absorbs ONE connect blip: retry succeeds, caller never sees the failure", async () => {
    let calls = 0;
    const inner = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw connectTimeout();
      return ok();
    });
    const fetch = withConnectResilience(inner as unknown as typeof globalThis.fetch, 1);
    const res = await fetch("https://api.github.com/graphql", { method: "POST" });
    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("fails in PLAIN WORDS when the retry also times out, keeping the cause", async () => {
    const inner = vi.fn(async () => {
      throw connectTimeout();
    });
    const fetch = withConnectResilience(inner as unknown as typeof globalThis.fetch, 1);
    const error = await fetch("https://api.github.com/rate_limit").catch(
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    // The user-facing message: names the host, says nothing was sent, no undici jargon.
    expect((error as Error).message).toContain("api.github.com");
    expect((error as Error).message).toContain("nothing was sent");
    expect((error as Error).message).not.toContain("attempted address");
    expect((error as Error).cause).toBeDefined();
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-connect failure (a 500, an abort, a mid-response reset)", async () => {
    const inner = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      });
    });
    const fetch = withConnectResilience(inner as unknown as typeof globalThis.fetch, 1);
    await expect(fetch("https://api.github.com/x")).rejects.toThrow("fetch failed");
    expect(inner).toHaveBeenCalledTimes(1); // a reset may follow a DELIVERED request — never replay
  });

  it("retries transient DNS (EAI_AGAIN) the same way", async () => {
    let calls = 0;
    const inner = vi.fn(async () => {
      calls += 1;
      if (calls === 1)
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }),
        });
      return ok();
    });
    const fetch = withConnectResilience(inner as unknown as typeof globalThis.fetch, 1);
    await expect(fetch("https://api.github.com/user")).resolves.toBeInstanceOf(Response);
  });
});
