import type { PatchsetIntent } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { patchsetIntentToReviewIntent } from "./patchset-intent";

describe("patchsetIntentToReviewIntent (#136)", () => {
  it("carries a PR title and body straight onto the runner seam", () => {
    const intent: PatchsetIntent = {
      surface: "github-pr",
      prTitle: "Add the thing",
      prBody: "Why the thing.",
    };
    expect(patchsetIntentToReviewIntent(intent)).toEqual({
      prTitle: "Add the thing",
      prBody: "Why the thing.",
    });
  });

  it("drops an absent PR body — never forwards it as an empty string", () => {
    const intent: PatchsetIntent = {
      surface: "github-pr",
      prTitle: "Add the thing",
      prBody: "",
      prBodyAbsent: true,
    };
    expect(patchsetIntentToReviewIntent(intent)).toEqual({ prTitle: "Add the thing" });
  });

  it("renders the frozen spec snapshots into a labelled spec layer, inlining only what survived the cap", () => {
    const intent: PatchsetIntent = {
      surface: "github-pr",
      specSnapshots: [
        { path: "openspec/a.md", digest: "d1", content: "rule A" },
        { path: "openspec/b.md", digest: "d2" }, // digest-only (over the cap): no content
      ],
    };
    expect(patchsetIntentToReviewIntent(intent)).toEqual({
      spec: "# openspec/a.md\n\nrule A",
    });
  });

  it("degrades to undefined for a no-PR surface with no title/body/spec (structure-only, unchanged)", () => {
    const intent: PatchsetIntent = {
      surface: "working-tree",
      prBodyAbsent: true,
      commitSubjects: ["did a thing", "did another"],
    };
    // Commit subjects are frozen on the patchset for the spec view but are NOT
    // folded into a PR-body slot they do not belong in.
    expect(patchsetIntentToReviewIntent(intent)).toBeUndefined();
  });

  it("feeds the spec even for a no-PR review that touched a spec", () => {
    const intent: PatchsetIntent = {
      surface: "working-tree",
      prBodyAbsent: true,
      specSnapshots: [{ path: "openspec/spec.md", digest: "d", content: "the rule" }],
    };
    expect(patchsetIntentToReviewIntent(intent)).toEqual({
      spec: "# openspec/spec.md\n\nthe rule",
    });
  });

  it("returns undefined for an absent intent, so it degrades exactly like a pre-capture patchset", () => {
    expect(patchsetIntentToReviewIntent(undefined)).toBeUndefined();
  });

  it("ignores whitespace-only title/body", () => {
    const intent: PatchsetIntent = { surface: "github-pr", prTitle: "   ", prBody: "\n\n" };
    expect(patchsetIntentToReviewIntent(intent)).toBeUndefined();
  });
});
