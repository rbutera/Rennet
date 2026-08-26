// @vitest-environment happy-dom
//
// The real-AI-default honesty signal (real-AI-default). The Canvases view IS the
// AI review and is the default landing. When the engine reports it produced the
// DETERMINISTIC mechanical outline (no model installed), the UI must say so LOUDLY
// — never pass the outline off as an AI review. This mounts the whole `RennetApp`
// over a fake `RennetBridge` (the live load fires directly — running the harness is
// Rennet's whole job, no consent step) and asserts, behaviourally, that the loud
// fallback banner appears iff the
// engine's `aiReview` is false, and names the missing Claude CLI.
import type { RennetBridge, Review, ReviewEngine } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { demoCanvases } from "./canvas/fixtures";
import { mount, waitFor } from "./test/dom";

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

/** A bridge whose live load reports the given engine provenance. */
function bridgeWithEngine(engine: ReviewEngine): RennetBridge {
  const invoke = async (name: string): Promise<unknown> => {
    if (name === "app.bootstrap") return { review, repositoryPresent: true };
    if (name === "review.canvases") return { canvases: demoCanvases(), elementDiffs: {}, engine };
    return { review };
  };
  return { invoke: invoke as unknown as RennetBridge["invoke"] };
}

describe("RennetApp — the mechanical-outline fallback is loud (real-AI-default)", () => {
  it("shows the loud fallback banner naming the missing Claude CLI when no model ran", async () => {
    const bridge = bridgeWithEngine({
      aiReview: false,
      claudeAvailable: false,
      codexAvailable: false,
    });
    const { container } = mount(<RennetApp bridge={bridge} />);

    // The auto-mode live load runs on the default Canvases landing, then the loud
    // banner appears BECAUSE the engine reported the mechanical outline.
    // RED-proof: gate the banner on `engine?.aiReview === true` (or drop it) → the
    // banner never renders → this never satisfies.
    await waitFor(() => {
      const banner = container.querySelector(".engine-fallback");
      expect(banner).not.toBeNull();
      expect(banner?.textContent).toContain("Claude CLI");
    });
  });

  it("shows NO fallback banner when the engine reports a real AI review", async () => {
    const bridge = bridgeWithEngine({
      aiReview: true,
      claudeAvailable: true,
      codexAvailable: true,
    });
    const { container } = mount(<RennetApp bridge={bridge} />);

    // The live set loads (the canvas workspace renders) and, because aiReview is
    // true, the fallback banner is absent — the real review carries no apology.
    await waitFor(() => expect(container.querySelector(".canvas-app")).not.toBeNull());
    expect(container.querySelector(".engine-fallback")).toBeNull();
  });
});
