import { withRequestTimeout } from "@rennet/adapters";
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

describe("the composed egress stack — ONE absolute budget (create-server order)", () => {
  // The exact create-server composition: deadline OUTSIDE the retry, so a slow
  // connect failure + the pause + a stalled second attempt share one budget.
  const composed = (
    raw: typeof globalThis.fetch,
    delayMs: number,
    timeoutMs: number,
  ): typeof globalThis.fetch => withRequestTimeout(withConnectResilience(raw, delayMs), timeoutMs);

  const stallOnSignal = (): typeof globalThis.fetch =>
    ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;

  it("connect failure + retry + stall settles within the AGGREGATE deadline, not per-attempt", async () => {
    let calls = 0;
    const stalling = stallOnSignal();
    const raw: typeof globalThis.fetch = (input, init) => {
      calls += 1;
      if (calls === 1) return Promise.reject(connectTimeout());
      return stalling(input, init);
    };
    const bound = composed(raw, 50, 200);
    const started = Date.now();
    const error = await bound("https://api.github.com/graphql").catch((e: unknown) => e as Error);
    const elapsed = Date.now() - started;
    expect((error as Error).name).toBe("TimeoutError");
    expect(calls).toBe(2);
    // Per-attempt deadlines would chain to ~200+50+200; the aggregate budget is ~200.
    expect(elapsed).toBeLessThan(400);
  });

  it("the deadline interrupts the retry PAUSE — the second attempt never launches", async () => {
    let calls = 0;
    const raw: typeof globalThis.fetch = () => {
      calls += 1;
      return Promise.reject(connectTimeout());
    };
    const bound = composed(raw, 10_000, 100);
    const started = Date.now();
    const error = await bound("https://api.github.com/rate_limit").catch(
      (e: unknown) => e as Error,
    );
    expect((error as Error).name).toBe("TimeoutError");
    expect(calls).toBe(1); // aborted mid-pause; no doomed second request
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a caller cancel interrupts the pause the same way", async () => {
    const controller = new AbortController();
    const raw: typeof globalThis.fetch = () => Promise.reject(connectTimeout());
    const bound = composed(raw, 10_000, 60_000);
    const pending = bound("https://api.github.com/x", { signal: controller.signal }).catch(
      (e: unknown) => e as Error,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const error = await pending;
    expect((error as Error).name).toBe("AbortError");
  });

  it("a deadline abort is NEVER classified as a connect failure (no replay of a stall)", async () => {
    let calls = 0;
    const stalling = stallOnSignal();
    const raw: typeof globalThis.fetch = (input, init) => {
      calls += 1;
      return stalling(input, init);
    };
    const bound = composed(raw, 1, 80);
    await expect(bound("https://api.github.com/graphql")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(calls).toBe(1);
  });
});
