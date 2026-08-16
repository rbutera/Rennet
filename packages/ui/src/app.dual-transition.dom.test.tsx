// @vitest-environment happy-dom
//
// Dual-model default across a REVIEW TRANSITION (issue #191, P1 fix).
//
// Dual-model is the default; a human may opt ONE review DOWN to the single-Claude
// quick review. The bug this guards: with the mode held as per-review STATE reset in
// an effect, opening review B while review A was opted-down let the flagged-fetch
// effect read A's inherited `deepReview:false` in the SAME render — before the reset
// effect committed `true` — so review B fired a WASTED single-seat run first, then a
// dual rerun. Real model spend + a single-seat flash, on a review nobody opted down.
//
// The fix derives the mode SYNCHRONOUSLY from reviewId (the opt-down choice is keyed
// to the review it was made on), so a new/other review reads the dual default in the
// same render its id changes. This test mounts the whole app over a fake bridge,
// records every `flagged.review` invocation, opts review A down, then transitions to
// review B via the freshness poll — and asserts review B NEVER receives
// `deepReview:false`, only the dual default. Red-provable against the pre-fix boundary
// (which produced a {B, false} call before the {B, true} rerun).
import type { RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
import { act, fireEvent, mount } from "./test/dom";

/** Drain the microtask queue so React state updates + effect chains settle. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const enriched = { canvases: demoCanvases(), elementDiffs: {} };

/** A ready local-capture review with the given id (local capture ⇒ freshness poll runs). */
function reviewWithId(id: string): Review {
  return {
    id,
    repositoryRoot: "/code/rennet",
    activePatchsetId: `patch-${id}`,
    dispositions: [],
    status: "current",
    patchsets: [
      {
        id: `patch-${id}`,
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
}

interface FlaggedCall {
  reviewId: string;
  deepReview: unknown;
}

/**
 * A fake bridge that boots review A, serves enriched canvases, and — once
 * `freshnessReview` is swapped to B — returns B from the freshness poll so the app
 * transitions reviews. Every `flagged.review` invocation is recorded with its
 * `deepReview` flag, which is the whole assertion surface.
 */
function makeBridge(state: { freshnessReview: Review }, calls: FlaggedCall[]): RennetBridge {
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    switch (name) {
      case "app.bootstrap":
        return { review: reviewWithId("A"), repositoryPresent: true };
      case "review.checkFreshness":
        return { review: state.freshnessReview };
      case "review.canvases":
        return enriched;
      case "flagged.review": {
        const arg = input as { reviewId: string; deepReview?: unknown };
        calls.push({ reviewId: arg.reviewId, deepReview: arg.deepReview });
        return { status: "ok", findings: [] };
      }
      case "noise.review":
        return { status: "ok", groups: [] };
      default:
        return {};
    }
  };
  return { invoke: invoke as unknown as RennetBridge["invoke"] };
}

describe("RennetApp — dual-model default survives a review transition (#191 P1)", () => {
  beforeEach(() => {
    // Fake timers so the 1500ms freshness poll fires only when we advance it — never
    // incidentally during setup. We drive clicks with fireEvent (no userEvent/timer mix).
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opening review B after opting review A DOWN never fires a single-seat (deepReview:false) run for B", async () => {
    const calls: FlaggedCall[] = [];
    // The freshness poll returns review A until we swap it to B below.
    const state = { freshnessReview: reviewWithId("A") };
    const bridge = makeBridge(state, calls);

    let handle!: ReturnType<typeof mount>;
    await act(async () => {
      handle = mount(<RennetApp bridge={bridge} />);
    });
    await act(async () => {
      await flush();
    });

    // Land in the enriched Canvases workspace and switch to the Flagged lens so the
    // dual-model toggle is on screen.
    expect(handle.container.querySelector(".canvas-app")).not.toBeNull();
    await act(async () => {
      fireEvent.click(handle.getByRole("tab", { name: "Flagged" }));
      await flush();
    });

    // Review A booted DUAL by default.
    expect(calls.some((c) => c.reviewId === "A" && c.deepReview === true)).toBe(true);

    // Opt review A DOWN to quick (the manual opt-down).
    const toggle = handle.container.querySelector<HTMLButtonElement>(".flag-deep-review");
    if (!toggle) throw new Error("expected the dual-model toggle in the Flagged lens");
    expect(toggle.textContent).toContain("switch to quick"); // dual is on for A
    await act(async () => {
      fireEvent.click(toggle);
      await flush();
    });
    // The opt-down registered: A re-fetched as a single-seat quick review.
    expect(calls.some((c) => c.reviewId === "A" && c.deepReview === false)).toBe(true);

    const callsBeforeB = calls.length;

    // Now transition to review B via the freshness poll (swap what it returns, then
    // let the 1500ms interval fire). This is the exact render where the pre-fix code
    // leaked A's inherited `false` onto B.
    state.freshnessReview = reviewWithId("B");
    await act(async () => {
      vi.advanceTimersByTime(1500);
      await flush();
    });

    const bCalls = calls.slice(callsBeforeB).filter((c) => c.reviewId === "B");
    // Review B ran at least once, and EVERY B run used the dual default — never once
    // the wasted single-seat `false`.
    expect(bCalls.length).toBeGreaterThan(0);
    expect(bCalls.every((c) => c.deepReview === true)).toBe(true);
    expect(bCalls.some((c) => c.deepReview === false)).toBe(false);
  });
});
