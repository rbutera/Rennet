// @vitest-environment happy-dom
//
// The REGENERATE staleness trap (#160/P0-2), proven end-to-end over the whole
// RennetApp. Canvas loading keys on reviewId::activePatchsetId; the flagged effect
// used to key on reviewId alone. A regenerate activates a NEW patchset under the
// SAME review id, so the flagged effect neither cleared nor re-ran — the new canvases
// rendered beside the OLD hypothesis, findings, and cross-check statuses: internally
// consistent, about the wrong diff.
//
// This mounts the app at patch-one (its hypothesis frame shows), drives a regenerate
// via the freshness poll (a new active patchset), and asserts: the stale frame is
// GONE during the refetch gap (the effect clears + the patchset binding drops it),
// then the NEW patchset's frame appears once its flagged review lands (the effect
// re-ran on the patchset change). Red-provable against the pre-fix reviewId-only key.
import type { FlaggedReview, RennetBridge, Review, ReviewHypothesis } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
import { act, mount } from "./test/dom";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const enriched = { canvases: demoCanvases(), elementDiffs: {} };

function reviewAt(patchsetId: string): Review {
  return {
    id: "review",
    repositoryRoot: "/code/rennet",
    activePatchsetId: patchsetId,
    dispositions: [],
    status: "current",
    patchsets: [
      {
        id: patchsetId,
        createdAt: "2026-08-08T00:00:00.000Z",
        repository: {
          id: "repository",
          root: "/code/rennet",
          commonDir: "/code/rennet/.git",
          baseRef: "main",
          baseOid: "1111111111111111",
          headOid: `${patchsetId}-head`,
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

function hypothesis(domain: string): ReviewHypothesis {
  return {
    domain,
    scope: { inScope: ["x"], outOfScope: ["y"] },
    designExpectation: "a design",
    risks: [
      {
        riskId: "R1",
        statement: "a predicted risk",
        severity: "high",
        disconfirmer: "check it",
      },
    ],
    repoContextPresent: true,
  };
}

function flaggedFor(patchsetId: string, domain: string): FlaggedReview {
  return {
    status: "ok",
    findings: [],
    hypothesis: hypothesis(domain),
    crossChecks: [{ riskId: "R1", status: "open", findingIds: [] }],
    patchsetId,
  };
}

describe("RennetApp — the flagged frame does not go stale on regenerate (#160/P0-2)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the old patchset's frame and shows the new one after a regenerate", async () => {
    vi.useFakeTimers();
    let current = reviewAt("patch-one");
    const phaseTwoFlagged = deferred<FlaggedReview>();
    let flaggedCalls = 0;
    const invoke = async (name: string): Promise<unknown> => {
      switch (name) {
        case "app.bootstrap":
          return { review: structuredClone(current), repositoryPresent: true };
        case "review.checkFreshness":
          return { review: structuredClone(current) };
        case "review.canvases":
          return enriched;
        case "flagged.review": {
          flaggedCalls += 1;
          // Phase 1 (patch-one) resolves immediately; phase 2 (patch-two) is deferred
          // so the test can observe the gap where NOTHING stale must show.
          return current.activePatchsetId === "patch-one"
            ? flaggedFor("patch-one", "alpha-domain")
            : phaseTwoFlagged.promise;
        }
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

    // Phase 1: the patch-one reading frame is on screen.
    expect(handle.container.querySelector(".hypothesis-panel")).not.toBeNull();
    expect(handle.container.textContent).toContain("alpha-domain");
    expect(flaggedCalls).toBe(1);

    // Regenerate: a NEW active patchset under the same review id. The freshness poll
    // picks it up and the app re-renders around it.
    current = reviewAt("patch-two");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
      await flush();
    });

    // The gap: the flagged effect re-ran (patchset dep), cleared the result, and
    // fetched the new patchset's flagged review — still pending. NOTHING stale shows:
    // the old "alpha-domain" frame is GONE, not rendered beside the new diff.
    // (Pre-fix red-proof: the reviewId-only key never re-ran, so alpha-domain persisted.)
    expect(handle.container.querySelector(".hypothesis-panel")).toBeNull();
    expect(handle.container.textContent).not.toContain("alpha-domain");
    expect(flaggedCalls).toBe(2);

    // The new patchset's flagged review lands → its frame appears (the effect re-ran).
    await act(async () => {
      phaseTwoFlagged.resolve(flaggedFor("patch-two", "beta-domain"));
      await flush();
    });
    expect(handle.container.querySelector(".hypothesis-panel")).not.toBeNull();
    expect(handle.container.textContent).toContain("beta-domain");
    expect(handle.container.textContent).not.toContain("alpha-domain");
  });
});
