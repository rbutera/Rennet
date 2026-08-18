// @vitest-environment happy-dom
//
// The live running state, asserted at the APP level (critique review item 5). The
// per-organ test (running-review.dom.test.tsx) mounts `RunningReview` directly, so it
// stays green even if app.tsx stops rendering the organ — reverting app.tsx to the old
// static "Running the review…" card would slip through, because the render-race test
// only matches that shared TEXT. This pins the organ itself into the live-canvas load:
// while `review.canvases` is in flight the elapsed clock (a marker ONLY `RunningReview`
// carries) is on screen, and once the enrichment lands it is gone and the workspace
// renders. Deferred-bridge harness mirrors app.render-race.dom.test.tsx.
import type { RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
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

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const enriched = { canvases: demoCanvases(), elementDiffs: {} };

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

function freshClone(): Review {
  return structuredClone(baseReview);
}

describe("RennetApp — the live running-review organ during the canvas load (item 5)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the RunningReview elapsed clock while enrichment is in flight, gone once it lands", async () => {
    const canvases = deferred<unknown>();
    const invoke = async (name: string): Promise<unknown> => {
      switch (name) {
        case "app.bootstrap":
          return { review: freshClone(), repositoryPresent: true };
        case "review.checkFreshness":
          return { review: freshClone() };
        case "review.canvases":
          return canvases.promise;
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

    // In flight: the compact AI-loading bar is visible alongside the diff (wireframe
    // #06: the diff substrate is always visible; the AI loads progressively).
    expect(handle.container.querySelector(".ai-loading-bar")).not.toBeNull();
    expect(handle.container.querySelector(".canvas-app")).toBeNull();

    // The enrichment lands: the loading bar is gone and the workspace renders.
    await act(async () => {
      canvases.resolve(enriched);
      await flush();
    });
    expect(handle.container.querySelector(".ai-loading-bar")).toBeNull();
    expect(handle.container.querySelector(".canvas-app")).not.toBeNull();
  });
});
