// The GitHub egress bound at the composition boundary (the lancelot field bug,
// 2026-08-19): a stalled TCP connection to api.github.com must never hang the
// product. Every request through `publishHttp` carries a deadline, so:
//   1. `project.detail` answers LOCAL-ONLY with `authUnavailable: "network"`
//      within the bound instead of queueing forever behind a poisoned memo,
//   2. the network verdict is never memoized — the next detail retries,
//   3. an outage AFTER the source is established degrades the same way (the
//      source memo survives; only the fetch failed),
//   4. `github.disconnect` completes while a validation is still in flight,
//   5. the device-flow connect fails with plain copy, not a raw undici string,
//      and a deliberate cancel is NEVER labelled a network problem,
//   6. the authenticated REST path (`github.setToken`, the same octokit-over-
//      publishHttp composition publish rides) is bounded too.
//
// Mutation-meaningful: the stalling transports below hang UNLESS the abort
// signal the timeout wrapper composes in fires — remove the wrapper in
// create-server.ts and these tests hang red.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubOctokit, GitHubPublishAdapter, isGitHubNetworkError } from "@rennet/adapters";
import type { ForgeReviewTarget } from "@rennet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRennetServer } from "./create-server";
import { composeGitHubTransport } from "./github-fetch";
import { createGitHubTokenStore } from "./github-token-store";

/** A transport that stalls forever but honors its abort signal, like real undici. */
function stallingFetch(): { fetch: typeof globalThis.fetch; calls: () => number } {
  let count = 0;
  const impl: typeof globalThis.fetch = (_input, init) => {
    count += 1;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  };
  return { fetch: impl, calls: () => count };
}

/** What real egress throws when GitHub is unreachable: undici's coded connect error. */
const unreachableFetch: typeof globalThis.fetch = () =>
  Promise.reject(
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Connect Timeout Error (attempted address: github.com:443)"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    }),
  );

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A healthy fake GitHub (validation + GraphQL) that can be flipped into a stall
 * mid-test — the post-establishment outage. Counts /rate_limit hits so tests can
 * prove the established source is NOT re-validated after the blip.
 */
function outageFetch(): {
  fetch: typeof globalThis.fetch;
  stall: (on: boolean) => void;
  rateLimitCalls: () => number;
} {
  let stalled = false;
  let rateLimitCalls = 0;
  const impl: typeof globalThis.fetch = (input, init) => {
    if (stalled) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason));
      });
    }
    const url = String(input instanceof Request ? input.url : input);
    const path = new URL(url).pathname;
    if (path === "/rate_limit") {
      rateLimitCalls += 1;
      return Promise.resolve(
        json(
          { resources: {} },
          { "X-OAuth-Scopes": "repo, workflow", "X-RateLimit-Limit": "5000" },
        ),
      );
    }
    if (path === "/user") return Promise.resolve(json({ login: "rbutera" }));
    if (path === "/graphql") {
      const body = String(init?.body ?? "");
      // NOTE: the open-PRs query contains "requestedReviewer", so route on the
      // field only IT has rather than on the substring "viewer".
      if (!body.includes("pullRequests"))
        return Promise.resolve(json({ data: { viewer: { login: "rbutera" } } }));
      return Promise.resolve(
        json({
          data: {
            repository: {
              pullRequests: {
                totalCount: 0,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return {
    fetch: impl,
    stall: (on) => {
      stalled = on;
    },
    rateLimitCalls: () => rateLimitCalls,
  };
}

describe("GitHub egress bounds (the lancelot hang)", () => {
  const dirs: string[] = [];
  const shutdowns: (() => void)[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const shutdown of shutdowns.splice(0)) shutdown();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function makeServer(httpFetch: typeof globalThis.fetch) {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-egress-"));
    dirs.push(dataDir);
    // A stored token that is FINE — only the network is broken.
    await createGitHubTokenStore(dataDir).setGitHubCredential({ token: "gho_perfectly_fine" });
    const server = await createRennetServer({
      dataDir,
      env: {},
      httpFetch,
      // The real default is 15s; tests shrink the deadline, not the semantics.
      httpTimeoutMs: 150,
    });
    shutdowns.push(server.shutdown);
    return server;
  }

  /** A real one-commit git repo, added as a project so `project.detail` runs live. */
  async function addProject(
    server: Awaited<ReturnType<typeof makeServer>>,
    options: { forgeRemote?: boolean } = {},
  ): Promise<string> {
    const repo = mkdtempSync(join(tmpdir(), "rennet-egress-repo-"));
    dirs.push(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "x");
    // A forge remote makes the PR fan-out real (owner/name parses).
    if (options.forgeRemote)
      git("remote", "add", "origin", "https://github.com/rbutera/fixture.git");
    const added = (await server.dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: repo,
        kind: "repo",
        repos: [{ name: "repo", path: repo, branches: 1 }],
        primaryBranch: "main",
      },
      includedRepos: ["repo"],
      primaryBranch: "main",
    })) as { project: { id: string } };
    return added.project.id;
  }

  it("project.detail degrades to local-only with authUnavailable network within the bound", async () => {
    const stalling = stallingFetch();
    const server = await makeServer(stalling.fetch);
    const projectId = await addProject(server);

    const started = Date.now();
    const detail = (await server.dispatch("project.detail", { projectId })) as {
      prs: unknown[];
      authUnavailable?: string;
    };
    // Bounded: the deadline fired and the surface answered — no forever-pending memo.
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(detail.authUnavailable).toBe("network");
    expect(detail.prs).toEqual([]);

    // The network verdict is TRANSIENT and never memoized: a second detail hits
    // the transport again instead of being pinned local-only forever.
    const before = stalling.calls();
    const again = (await server.dispatch("project.detail", { projectId })) as {
      authUnavailable?: string;
    };
    expect(again.authUnavailable).toBe("network");
    expect(stalling.calls()).toBeGreaterThan(before);
  }, 15_000);

  it("an outage AFTER the source is established degrades to local-only network — memo survives", async () => {
    const outage = outageFetch();
    const server = await makeServer(outage.fetch);
    const projectId = await addProject(server, { forgeRemote: true });

    // Establish: validation + GraphQL succeed, the PR source memoizes.
    const healthy = (await server.dispatch("project.detail", { projectId })) as {
      prs: unknown[];
      authUnavailable?: string;
    };
    expect(healthy.authUnavailable).toBeUndefined();
    const validations = outage.rateLimitCalls();
    expect(validations).toBeGreaterThan(0);

    // The outage: every request now stalls. The live PR load must abort at the
    // deadline and degrade — never propagate out of project.detail as a failure.
    outage.stall(true);
    const started = Date.now();
    const degraded = (await server.dispatch("project.detail", { projectId })) as {
      prs: unknown[];
      locals: unknown[];
      authUnavailable?: string;
    };
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(degraded.authUnavailable).toBe("network");
    expect(degraded.prs).toEqual([]);
    expect(Array.isArray(degraded.locals)).toBe(true);

    // Recovery: the SOURCE was fine all along (memo kept) — the next detail
    // fetches PRs again without a single new validation round-trip.
    outage.stall(false);
    const recovered = (await server.dispatch("project.detail", { projectId })) as {
      authUnavailable?: string;
    };
    expect(recovered.authUnavailable).toBeUndefined();
    expect(outage.rateLimitCalls()).toBe(validations);
  }, 15_000);

  it("github.disconnect completes while a validation is still in flight", async () => {
    const stalling = stallingFetch();
    const server = await makeServer(stalling.fetch);

    // A validation hanging on the dead network (resolves at the deadline)…
    const statusInFlight = server.dispatch("github.status", {}) as Promise<{
      status: { state: string };
    }>;
    // …must not hold the account subsystem hostage: disconnect is a local store
    // write and completes promptly.
    const started = Date.now();
    await server.dispatch("github.disconnect", {});
    expect(Date.now() - started).toBeLessThan(2_000);

    // The in-flight validation still settles honestly (network, not token-invalid).
    expect((await statusInFlight).status.state).toBe("network");
    // And the account is really gone.
    const after = (await server.dispatch("github.status", {})) as { status: { state: string } };
    expect(after.status.state).toBe("not-connected");
  }, 15_000);

  it("the device-flow connect fails with plain copy, never a raw undici string", async () => {
    const server = await makeServer(unreachableFetch);

    await expect(server.dispatch("github.connectStart", {})).rejects.toThrow(
      "Couldn't reach github.com — check your connection.",
    );
    const { poll } = (await server.dispatch("github.connectPoll", {})) as {
      poll: { phase: string; message?: string };
    };
    expect(poll.phase).toBe("failed");
    expect(poll.message).toBe("Couldn't reach github.com — check your connection.");
    expect(poll.message).not.toContain("UND_ERR");
  }, 15_000);

  /** Mint the device code, then stall (or keep stalling) every poll POST. */
  function deviceFlowFetch(): { fetch: typeof globalThis.fetch; polls: () => number } {
    let polls = 0;
    const impl: typeof globalThis.fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (new URL(url).pathname === "/login/device/code") {
        return Promise.resolve(
          json({
            device_code: "dc",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 30,
            interval: 1,
          }),
        );
      }
      polls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason));
      });
    };
    return { fetch: impl, polls: () => polls };
  }

  it("a STALLED device-flow poll is bounded: the connect fails with plain copy", async () => {
    const flow = deviceFlowFetch();
    const server = await makeServer(flow.fetch);

    const started = await server.dispatch("github.connectStart", {});
    expect((started as { userCode: string }).userCode).toBe("ABCD-1234");

    // The poll POST stalls; the wrapper's deadline turns it into a bounded
    // failure the flow reports honestly. Poll until it lands (sleep 1s + 150ms).
    const deadline = Date.now() + 10_000;
    let poll: { phase: string; message?: string } = { phase: "pending" };
    while (Date.now() < deadline && poll.phase !== "failed") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      poll = ((await server.dispatch("github.connectPoll", {})) as { poll: typeof poll }).poll;
    }
    expect(poll.phase).toBe("failed");
    expect(poll.message).toBe("Couldn't reach github.com — check your connection.");
  }, 15_000);

  it("a deliberate cancel is NEVER labelled a network problem", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const flow = deviceFlowFetch();
    const server = await makeServer(flow.fetch);

    await server.dispatch("github.connectStart", {});
    // Cancel while the poll POST is IN FLIGHT: the abort rejects that fetch with
    // an AbortError, which must read as the user's cancel, not "GitHub is down".
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && flow.polls() === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(flow.polls()).toBeGreaterThan(0);
    await server.dispatch("github.connectCancel", {});
    // Let the aborted flow's rejection path run.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // No network warning, no "Couldn't reach github.com": the cancel stays a cancel.
    expect(warn).not.toHaveBeenCalledWith(
      "GitHub device flow could not reach github.com",
      expect.anything(),
    );
    const { poll } = (await server.dispatch("github.connectPoll", {})) as {
      poll: { phase: string; message?: string };
    };
    expect(poll.phase).toBe("idle");
  }, 15_000);

  it("github.setToken over a stalled transport answers network within the bound (the authenticated REST path)", async () => {
    const stalling = stallingFetch();
    const server = await makeServer(stalling.fetch);

    const started = Date.now();
    const result = (await server.dispatch("github.setToken", { token: "gho_candidate" })) as {
      status: { state: string };
    };
    expect(Date.now() - started).toBeLessThan(4_000);
    // Bounded AND honest: a stalled validation is the network's failure — the
    // paste is neither stored nor blamed.
    expect(result.status.state).toBe("network");
  }, 15_000);

  it("connect failure + retry + stall shares ONE aggregate budget through the server", async () => {
    // First attempt fails the connect phase; the retry then stalls. Per-attempt
    // deadlines would chain ~150 + 750 (pause) + 150; the aggregate contract is
    // ~150 total — the deadline spans the pause and the second attempt.
    let calls = 0;
    const stalling = stallingFetch();
    const connectFailThenStall: typeof globalThis.fetch = (input, init) => {
      calls += 1;
      if (calls === 1) return unreachableFetch(input, init);
      return stalling.fetch(input, init);
    };
    const server = await makeServer(connectFailThenStall);

    const started = Date.now();
    const result = (await server.dispatch("github.setToken", { token: "gho_candidate" })) as {
      status: { state: string };
    };
    expect(result.status.state).toBe("network");
    expect(Date.now() - started).toBeLessThan(600);
  }, 15_000);
});

describe("publish egress rides the SAME bounded transport (unit-level middle ground)", () => {
  // Full publish.review e2e needs the composed review + consent machinery; this
  // drives the REAL publish adapter over the REAL create-server transport stack
  // (withRequestTimeout(withConnectResilience(raw))) so that mutating ONLY the
  // publish octokit wiring to an unbounded transport turns this red (it hangs).
  it("a stalled GraphQL during the publish reconcile settles within the bound as a network error", async () => {
    const stalling = stallingFetch();
    const publishHttp = composeGitHubTransport(stalling.fetch, 150);
    const adapter = new GitHubPublishAdapter({
      resolveOctokit: async () =>
        createGitHubOctokit({ fetch: publishHttp, token: "gho_perfectly_fine" }),
    });
    const target: ForgeReviewTarget = {
      ref: { repo: { forge: "github", owner: "rbutera", name: "fixture" }, number: 3 },
      forgeRef: "PR_kwFIXTURE",
      headOid: "cafe0003",
    };
    const started = Date.now();
    const error = await adapter
      .findExistingReview(target, "marker-1")
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).not.toBeNull();
    expect(isGitHubNetworkError(error)).toBe(true);
    expect(stalling.calls()).toBe(1); // a stall is not a connect failure — never replayed
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
