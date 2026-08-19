// The GitHub egress bound (the lancelot field bug): every request through the
// wrapped transport must fail within the deadline instead of hanging forever,
// a caller's own abort signal must stay composed in (the device-flow cancel),
// and the network classifier must name transport failures without ever
// swallowing a credential problem.
import { describe, expect, it } from "vitest";
import { isGitHubNetworkError, withRequestTimeout } from "./github-fetch";

/** A transport that stalls forever but honors its abort signal, like real undici. */
const stalling: typeof globalThis.fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

describe("withRequestTimeout — the per-request egress bound", () => {
  it("aborts a stalled request at the deadline (a hang becomes a bounded failure)", async () => {
    const bound = withRequestTimeout(stalling, 20);
    const started = Date.now();
    await expect(bound("https://api.github.com/rate_limit")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    // Well under a network-scale wait: the deadline fired, not a test timeout.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps a caller-provided signal composed in (device-flow cancel still works)", async () => {
    const bound = withRequestTimeout(stalling, 60_000);
    const controller = new AbortController();
    const pending = bound("https://github.com/login/oauth/access_token", {
      signal: controller.signal,
    });
    controller.abort(new Error("GitHub connect was cancelled"));
    await expect(pending).rejects.toThrow("GitHub connect was cancelled");
  });

  it("bounds a stalled request even when the input is a Request object", async () => {
    const bound = withRequestTimeout(stalling, 20);
    const started = Date.now();
    await expect(bound(new Request("https://api.github.com/rate_limit"))).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("composes a Request object's OWN signal in (no init at all)", async () => {
    const bound = withRequestTimeout(stalling, 60_000);
    const controller = new AbortController();
    const pending = bound(
      new Request("https://api.github.com/graphql", { signal: controller.signal }),
    );
    controller.abort(new Error("caller aborted the Request"));
    await expect(pending).rejects.toThrow("caller aborted the Request");
  });

  it("passes a fast response through untouched", async () => {
    const bound = withRequestTimeout(async () => new Response("ok"), 20);
    const res = await bound("https://api.github.com/rate_limit");
    expect(await res.text()).toBe("ok");
  });
});

describe("isGitHubNetworkError — the honest name for an unreachable GitHub", () => {
  it("names undici transport failures, walking the octokit cause chain", () => {
    // What octokit throws: RequestError(status 500) wrapping fetch's TypeError,
    // which wraps undici's coded connect error.
    const undici = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const fetchFailed = Object.assign(new TypeError("fetch failed"), { cause: undici });
    const wrapped = Object.assign(new Error("Connect Timeout Error"), {
      status: 500,
      cause: fetchFailed,
    });
    expect(isGitHubNetworkError(wrapped)).toBe(true);
    expect(isGitHubNetworkError(fetchFailed)).toBe(true);
    expect(isGitHubNetworkError(undici)).toBe(true);
  });

  it("names the deadline abort and system-level connect failures", () => {
    expect(isGitHubNetworkError({ name: "TimeoutError" })).toBe(true);
    expect(isGitHubNetworkError({ name: "AbortError" })).toBe(true);
    expect(isGitHubNetworkError(Object.assign(new Error("dns"), { code: "ENOTFOUND" }))).toBe(true);
  });

  it("never claims an ordinary error or an HTTP failure is the network", () => {
    expect(isGitHubNetworkError(new Error("boom"))).toBe(false);
    // A real HTTP 401/500 RequestError has no transport cause: not a network problem.
    expect(isGitHubNetworkError(Object.assign(new Error("Bad credentials"), { status: 401 }))).toBe(
      false,
    );
    expect(isGitHubNetworkError(null)).toBe(false);
  });
});
