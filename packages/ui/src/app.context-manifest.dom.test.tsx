// @vitest-environment happy-dom
//
// The "what was sent" inspector mount (issue #30): when the live canvases load
// returns a REAL ContextManifest, the review surface renders the inspector; when it
// returns none, nothing is rendered (honest absence, never a fabricated stand-in —
// Rule Zero). This mounts the whole `RennetApp` over a fake `RennetBridge` and
// asserts the mount behaviourally.
import type { RennetBridge } from "@rennet/protocol";
import type { ContextManifest, Review } from "@rennet/types";
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

const manifest: ContextManifest = {
  repoRecordId: "/code/rennet",
  projectSnapshotId: "fp-1",
  compositionDigest: "comp-1",
  freshness: { status: "current", staleMembers: [] },
  members: [],
  documents: [
    {
      order: 0,
      source: "claude-md",
      sourcePath: "CLAUDE.md",
      contentHash: "a".repeat(64),
      originalBytes: 120,
      bytes: 120,
      state: "included",
    },
  ],
  totalBytes: 120,
  assembledPromptDigest: "b".repeat(64),
  exhaustive: false,
  unmanagedSources: ["harness ambient file reads (context-isolation probe not yet run)"],
};

function bridgeWith(contextManifest?: ContextManifest): RennetBridge {
  const invoke = async (name: string): Promise<unknown> => {
    if (name === "review.canvases") {
      return {
        canvases: demoCanvases(),
        elementDiffs: {},
        engine: { aiReview: true, claudeAvailable: true, codexAvailable: true },
        ...(contextManifest ? { contextManifest } : {}),
      };
    }
    return { review };
  };
  return { invoke: invoke as unknown as RennetBridge["invoke"] };
}

describe("RennetApp — the 'what was sent' inspector mount (#30)", () => {
  it("renders the inspector when the live load returns a REAL manifest", async () => {
    const { container } = mount(<RennetApp bridge={bridgeWith(manifest)} />);
    // RED-proof: drop the `{contextManifest ? <ContextManifestPanel/> : null}` mount
    // (or the setContextManifest wiring) → this panel never renders → this fails.
    await waitFor(() => {
      const panel = container.querySelector('[data-testid="context-manifest"]');
      expect(panel).not.toBeNull();
      expect(panel?.textContent).toContain("CLAUDE.md");
    });
  });

  it("renders NOTHING when the live load returns no manifest (honest absence)", async () => {
    const { container } = mount(<RennetApp bridge={bridgeWith(undefined)} />);
    // The review surface loads (canvas app renders) but no manifest ⇒ no inspector,
    // never a fabricated empty-but-present panel.
    await waitFor(() => expect(container.querySelector(".canvas-app")).not.toBeNull());
    expect(container.querySelector('[data-testid="context-manifest"]')).toBeNull();
  });
});
