// @vitest-environment happy-dom
//
// #160's RENDERER delivery, proven end-to-end over the whole RennetApp. The protocol
// schema test proves the boundary CARRIES `decisionsRun`; this proves the app actually
// THREADS it — review.canvases → loadCanvases → setDecisionsRun → the CanvasWorkspace
// `decisionsRunStatus` prop → the Decisions lens's failed banner. Codex mutation-tested
// the earlier suite and found that deleting `setDecisionsRun(live.decisionsRun)` left all
// UI tests green: the pipe could be cut and nothing noticed. This closes that gap.
// (Red-proof: delete that setState in app.tsx and the failed banner never renders here.)
import type { RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
import { act, mount } from "./test/dom";

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const review: Review = {
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

describe("RennetApp — the Decisions failed state threads to the banner (#160)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the Decisions failed banner when review.canvases reports decisionsRun failed", async () => {
    const invoke = async (name: string): Promise<unknown> => {
      switch (name) {
        case "app.bootstrap":
          return { review: structuredClone(review) };
        case "review.checkFreshness":
          return { review: structuredClone(review) };
        case "review.canvases":
          // The engine reports the Decisions runner FAILED — this must reach the banner,
          // not render identically to "ran, found nothing".
          return {
            canvases: demoCanvases(),
            elementDiffs: {},
            decisionsRun: { status: "failed", reason: "the extraction runner timed out" },
          };
        case "flagged.review":
          return { status: "ok", findings: [] };
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

    // The live workspace is up; switch to the Decisions lens where the runner status lives.
    const decisionsTab = handle.getByRole("tab", { name: "Decisions" });
    await act(async () => {
      decisionsTab.click();
      await flush();
    });

    // The failed banner fires — distinctly from the "no decisions" empty state.
    expect(handle.container.querySelector(".decisions-failed")).not.toBeNull();
    expect(handle.container.querySelector(".decisions-empty")).toBeNull();
    expect(handle.container.textContent).toContain("Couldn't reconstruct decisions");
    expect(handle.container.textContent).toContain("the extraction runner timed out");
  });
});
