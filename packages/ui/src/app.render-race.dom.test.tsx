// @vitest-environment happy-dom
//
// The #59 RENDER RACE, proven with a fake clock + a slow harness (issue #53 harness).
//
// `bootstrap()` opens a review; a 1500ms freshness poll (`review.checkFreshness`)
// then deserializes a FRESH `Review` object every tick. Before the fix the live-
// canvas effect depended on that churning object reference, so each poll re-ran the
// effect, its cleanup cancelled the in-flight `review.canvases` enrichment fetch,
// and the effect's synchronous "fetched" guard (keyed on review id, set at fetch
// START) then blocked the retry. On a SLOW real harness — where the enrichment takes
// longer than one poll — the enrichment therefore never landed: the app sat on
// "Running the review…" while a real canvas set had genuinely been produced.
//
// These mount the WHOLE `RennetApp` over a fake `RennetBridge`. Test 1 makes
// `review.canvases` a DEFERRED (slow) promise, drives the 1500ms poll with vitest
// fake timers WHILE the fetch is in flight, then resolves it, and asserts the
// enriched workspace (`.canvas-app`) renders. Test 2 fails the first enrichment and
// asserts the retry re-fetches (success-only key recording). Both are behavioural and
// red-provable against the pre-fix effect.
import type { RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
import { act, fireEvent, mount } from "./test/dom";

/** A manually-settleable promise, so a test controls exactly when a fetch lands. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain the microtask queue so React state updates + effect chains settle. Fake
 * timers do not fake the microtask queue, so this works under both clocks. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const enriched = { canvases: demoCanvases(), elementDiffs: {} };

// A ready review with one changed file. The Canvases view is the default landing, so
// opening it fires the live-canvas enrichment fetch directly (no consent gate).
const baseReview: Review = {
  id: "review",
  repositoryRoot: "/code/rennet",
  activePatchsetId: "patch-one",
  dispositions: [],
  status: "current",
  patchsets: [
    {
      id: "patch-one",
      createdAt: "2026-08-08T00:00:00.000Z",
      repository: {
        id: "repository",
        root: "/code/rennet",
        commonDir: "/code/rennet/.git",
        baseRef: "main",
        baseOid: "1111111111111111",
        headOid: "2222222222222222",
      },
      files: [
        {
          path: "src/x.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          binary: false,
          patch: "+const reviewed = true;",
        },
      ],
      rawDiff: "+const reviewed = true;",
      byteLength: 24,
      truncated: false,
    },
  ],
};

// A fresh deserialization of the SAME review: a new object reference with an
// identical id + active patchset — exactly what the freshness poll returns when
// nothing changed on disk (the reference churn that used to cancel the fetch).
function freshClone(): Review {
  return structuredClone(baseReview);
}

describe("RennetApp — the live-canvas render race (#59)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a slow enrichment survives a 1500ms freshness-poll churn and still lands", async () => {
    vi.useFakeTimers();
    const canvases = deferred<unknown>();
    let canvasCalls = 0;
    let freshnessCalls = 0;
    const invoke = async (name: string): Promise<unknown> => {
      switch (name) {
        case "app.bootstrap":
          return { review: freshClone(), repositoryPresent: true };
        // Opening Canvases fires the enrichment fetch directly — running the harness
        // is Rennet's whole job, so there is no consent gate to clear.
        case "review.checkFreshness":
          freshnessCalls += 1;
          return { review: freshClone() }; // the churn: new object, same identity
        case "review.canvases":
          canvasCalls += 1;
          return canvases.promise; // the SLOW enrichment
        default:
          return {}; // flagged/noise: honest empty, never disturbs the canvas load
      }
    };
    const bridge = { invoke: invoke as unknown as RennetBridge["invoke"] };

    let handle!: ReturnType<typeof mount>;
    await act(async () => {
      handle = mount(<RennetApp bridge={bridge} />);
    });
    // Let bootstrap resolve and the effects settle.
    await act(async () => {
      await flush();
    });

    // The enrichment fetch is in flight (still pending): the pending primer is up,
    // the enriched workspace is not, and exactly one fetch has started.
    expect(canvasCalls).toBe(1);
    expect(handle.container.querySelector(".canvas-app")).toBeNull();
    expect(handle.container.querySelector(".ai-loading-bar")).not.toBeNull();

    // Fire the 1500ms freshness poll WHILE the enrichment is still pending. It
    // deserializes a fresh Review (the reference churn). Pre-fix: this cancels the
    // in-flight fetch and the id-keyed guard blocks the retry.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(freshnessCalls).toBeGreaterThanOrEqual(1);
    // The poll must NOT have kicked a second enrichment fetch.
    expect(canvasCalls).toBe(1);

    // Only now does the slow enrichment resolve.
    await act(async () => {
      canvases.resolve(enriched);
      await flush();
    });

    // WITH THE FIX: the enrichment lands — the workspace renders, the primer is gone,
    // and there was never a redundant second fetch of the same identity.
    // WITHOUT THE FIX (red-proof): the poll churn cancelled the fetch and blocked the
    // retry, so this resolve is dropped and `.canvas-app` never appears.
    expect(handle.container.querySelector(".canvas-app")).not.toBeNull();
    expect(handle.container.querySelector(".ai-loading-bar")).toBeNull();
    expect(canvasCalls).toBe(1);
  });

  it("a failed enrichment does not poison the identity — the retry re-fetches and lands", async () => {
    // The success-only key recording (#59): a failed load records nothing, so the
    // "Try again" affordance can re-fetch the SAME identity. Pre-fix the id-keyed
    // guard was set synchronously at fetch START, so a failed load latched the
    // identity and the retry early-returned — a permanent, un-retryable failure.
    let canvasCalls = 0;
    const invoke = async (name: string): Promise<unknown> => {
      switch (name) {
        case "app.bootstrap":
          return { review: freshClone(), repositoryPresent: true };
        case "review.checkFreshness":
          return { review: freshClone() };
        case "review.canvases":
          canvasCalls += 1;
          if (canvasCalls === 1) throw new Error("no harness"); // first load fails
          return enriched; // the retry succeeds
        default:
          return {};
      }
    };
    const bridge = { invoke: invoke as unknown as RennetBridge["invoke"] };

    let handle!: ReturnType<typeof mount>;
    await act(async () => {
      handle = mount(<RennetApp bridge={bridge} />);
    });
    await act(async () => {
      await flush();
    });
    // The first enrichment failed → the honest failure surface with a retry.
    expect(canvasCalls).toBe(1);
    expect(handle.container.textContent).toContain("The review failed");
    const retry = handle.getByRole("button", { name: "Try again" });

    // Click "Try again": this must re-run the fetch for the same identity — proving
    // the failed load did NOT record (poison) the key.
    await act(async () => {
      fireEvent.click(retry);
      await flush();
    });
    expect(canvasCalls).toBe(2);

    // The retry succeeded; the enriched workspace renders and the failure is gone.
    expect(handle.container.querySelector(".canvas-app")).not.toBeNull();
    expect(handle.container.textContent).not.toContain("The review failed");
  });
});
