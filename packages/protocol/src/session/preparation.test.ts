import { describe, expect, it } from "vitest";
import { sidebarSessionSchema } from "../wire";
import { SessionModelSchema, SessionPreparationSchema } from "./model";

// review-preparation-reliability 2.1: every new preparation variant round-trips, and the
// payloads a daemon persisted before the change still parse unchanged.
describe("SessionPreparation (review-preparation-reliability)", () => {
  const roundTrip = (value: unknown) =>
    SessionPreparationSchema.parse(JSON.parse(JSON.stringify(value)));

  it("round-trips a classified workspace failure with every new field", () => {
    const failed = {
      status: "failed",
      stage: "workspace",
      reason: "Git LFS isn't installed, so this pull request's large files can't be checked out.",
      kind: "tool-missing",
      action: "install",
      tool: "git-lfs",
      detail: "git-lfs filter-process --skip: git-lfs: command not found",
      reviewId: "rev-1",
    } as const;
    expect(roundTrip(failed)).toEqual(failed);
  });

  it("round-trips every failure kind and action", () => {
    for (const kind of ["tool-missing", "large-file", "auth", "ref-gone", "unknown"] as const) {
      for (const action of ["install", "choose-large-files", "sign-in", "retry"] as const) {
        const failed = { status: "failed", stage: "workspace", reason: "x", kind, action };
        expect(roundTrip(failed)).toEqual(failed);
      }
    }
  });

  it("round-trips the awaiting large-file choice, with and without Git LFS", () => {
    for (const lfsAvailable of [true, false]) {
      const awaiting = {
        status: "awaiting",
        kind: "large-file-choice",
        lfsAvailable,
        reviewId: "rev-1",
      } as const;
      expect(roundTrip(awaiting)).toEqual(awaiting);
    }
  });

  it("round-trips a cancellation at the workspace stage", () => {
    const cancelled = { status: "cancelled", stage: "workspace", reviewId: "rev-1" } as const;
    expect(roundTrip(cancelled)).toEqual(cancelled);
  });

  it("still parses the payloads a daemon persisted before the change", () => {
    const old = [
      { status: "capturing", step: "resolving-repository" },
      { status: "drafting", reviewId: "rev-1", lanes: [] },
      { status: "failed", stage: "capture", reason: "fatal: not a git repository" },
      {
        status: "failed",
        stage: "boards",
        reason: "Drafting failed.",
        reviewId: "rev-1",
        lanes: [],
      },
      { status: "cancelled", stage: "capture" },
      { status: "cancelled", stage: "boards", reviewId: "rev-1", lanes: [] },
    ];
    for (const payload of old) expect(roundTrip(payload)).toEqual(payload);
  });

  it("refuses an awaiting state with no review, and an unknown kind or stage", () => {
    expect(
      SessionPreparationSchema.safeParse({
        status: "awaiting",
        kind: "large-file-choice",
        lfsAvailable: true,
      }).success,
    ).toBe(false);
    expect(
      SessionPreparationSchema.safeParse({
        status: "failed",
        stage: "workspace",
        reason: "x",
        kind: "network",
      }).success,
    ).toBe(false);
    expect(
      SessionPreparationSchema.safeParse({ status: "failed", stage: "fetch", reason: "x" }).success,
    ).toBe(false);
  });

  it("carries workspace notes on the session record and its sidebar row", () => {
    const note =
      "Large files were left as placeholders. This repository's Git LFS hook needs Git LFS, which isn't installed, so the hook was skipped.";
    const session = SessionModelSchema.parse({
      id: "s-1",
      projectId: "p-1",
      threads: [],
      createdAt: 1,
      workspaceNotes: [note],
      preparation: {
        status: "awaiting",
        kind: "large-file-choice",
        lfsAvailable: false,
        reviewId: "r",
      },
    });
    expect(session.workspaceNotes).toEqual([note]);
    const row = sidebarSessionSchema.parse({
      id: "s-1",
      projectId: "p-1",
      title: "feat/widget",
      target: "your-pr",
      pinned: false,
      archived: false,
      createdAt: 1,
      workspaceNotes: [note],
    });
    expect(row.workspaceNotes).toEqual([note]);
  });
});
