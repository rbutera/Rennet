import { describe, expect, it } from "vitest";
import {
  initialKickoff,
  type KickoffProject,
  kickoffReducer,
  matchProjectRepoKey,
  parsePrRef,
} from "./kickoff";

const projects: KickoffProject[] = [
  {
    id: "p1",
    name: "rennet",
    repo: { repoKey: "key-rennet", displayName: "rennet" },
    primaryBranch: "main",
  },
  {
    id: "p2",
    name: "atlas",
    repo: { repoKey: "key-atlas", displayName: "orbital/atlas" },
    primaryBranch: "main",
  },
];

describe("parsePrRef (#382 M2, task 5.1)", () => {
  it("parses a GitHub PR URL", () => {
    expect(parsePrRef("https://github.com/orbital/atlas/pull/214")).toMatchObject({
      owner: "orbital",
      repo: "atlas",
      number: 214,
    });
  });

  it("parses the short owner/repo#N form", () => {
    expect(parsePrRef("orbital/atlas#214")).toMatchObject({
      owner: "orbital",
      repo: "atlas",
      number: 214,
    });
  });

  it("rejects non-PR input", () => {
    expect(parsePrRef("just some text")).toBeNull();
    expect(parsePrRef("https://github.com/orbital/atlas")).toBeNull();
  });
});

describe("matchProjectRepoKey (#382 M2, task 5.1)", () => {
  it("matches a PR ref to the owning project's repo key", () => {
    const parsed = parsePrRef("https://github.com/orbital/atlas/pull/214");
    expect(parsed && matchProjectRepoKey(projects, parsed)).toBe("key-atlas");
  });

  it("returns undefined when no project owns the repo", () => {
    const parsed = parsePrRef("someone/unknown#1");
    expect(parsed && matchProjectRepoKey(projects, parsed)).toBeUndefined();
  });
});

describe("kickoffReducer (#382 M2, task 5.1)", () => {
  it("moves idle → starting → started", () => {
    let s = kickoffReducer(initialKickoff, { type: "start", kind: "pr" });
    expect(s).toEqual({ status: "starting", kind: "pr" });
    s = kickoffReducer(s, { type: "progress", note: "cloning…" });
    expect(s).toMatchObject({ status: "starting", note: "cloning…" });
    s = kickoffReducer(s, { type: "started", reviewId: "rev-1" });
    expect(s).toEqual({ status: "started", reviewId: "rev-1" });
  });

  it("surfaces a failure truthfully", () => {
    const s = kickoffReducer(
      { status: "starting", kind: "capture" },
      { type: "failed", reason: "no clone" },
    );
    expect(s).toEqual({ status: "failed", reason: "no clone" });
  });

  it("ignores progress once no longer starting", () => {
    const started = { status: "started", reviewId: "r" } as const;
    expect(kickoffReducer(started, { type: "progress", note: "late" })).toBe(started);
  });
});
