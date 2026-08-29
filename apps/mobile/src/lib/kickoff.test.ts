import { describe, expect, it } from "vitest";
import {
  initialKickoff,
  type KickoffProject,
  kickoffReducer,
  matchProjectRepoKey,
  parsePrRef,
  planOpenPr,
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

  it("matches a bare repo name only when it is unique (#382 M2 finding 9)", () => {
    // `rennet` (bare displayName) is unique across the two projects ⇒ a bare-name match resolves it.
    const parsed = parsePrRef("me/rennet#1");
    expect(parsed && matchProjectRepoKey(projects, parsed)).toBe("key-rennet");
  });

  it("PREFERS an exact owner/repo over an ambiguous bare name (#382 M2 finding 9)", () => {
    // Two clones share the repo name `rennet` under different owners — a fork and its upstream.
    const forks: KickoffProject[] = [
      {
        id: "a",
        name: "rennet",
        repo: { repoKey: "key-mine", displayName: "me/rennet" },
        primaryBranch: "main",
      },
      {
        id: "b",
        name: "rennet",
        repo: { repoKey: "key-theirs", displayName: "you/rennet" },
        primaryBranch: "main",
      },
    ];
    // Exact owner/repo routes to the right clone, never a guess.
    const mine = parsePrRef("me/rennet#7");
    expect(mine && matchProjectRepoKey(forks, mine)).toBe("key-mine");
    const theirs = parsePrRef("you/rennet#7");
    expect(theirs && matchProjectRepoKey(forks, theirs)).toBe("key-theirs");
    // A bare name is now AMBIGUOUS (both display as `.../rennet`) ⇒ refuse rather than guess.
    const ambiguous = parsePrRef("someoneelse/rennet#7");
    expect(ambiguous && matchProjectRepoKey(forks, ambiguous)).toBeUndefined();
  });
});

/**
 * The Open button is the primary "new review from a PR" entry point and is always enabled. It used
 * to open with `if (!connection || !parsed) return;`, so an empty or unparseable link made the tap
 * do literally nothing. These assert what the USER ends up seeing: the screen renders exactly
 * `state.reason` when `state.status === "failed"`, so each case is folded through the reducer and
 * the rendered string is the assertion.
 *
 * What this cannot catch: that the screen calls `planOpenPr` at all. That wiring is a control-flow
 * fact about `app/kickoff.tsx`, and it is pinned separately in `dead-controls.test.ts`.
 */
describe("planOpenPr — pressing Open always tells the user something", () => {
  /** The danger line the screen renders under the field, for whatever Open decided. */
  function shownAfterPressing(link: string): string | null {
    const plan = planOpenPr(link, projects);
    if (plan.kind !== "failed") return null;
    const state = kickoffReducer(initialKickoff, { type: "failed", reason: plan.reason });
    return state.status === "failed" ? state.reason : null;
  }

  it("states a reason for an unparseable link, rather than doing nothing", () => {
    expect(shownAfterPressing("not a link at all")).toBe(
      "That is not a pull request link. Paste a GitHub PR URL, or owner/repo#123.",
    );
    // A repo URL that is not a PR — the near-miss most likely to be pasted by accident.
    expect(shownAfterPressing("https://github.com/orbital/atlas")).toBe(
      "That is not a pull request link. Paste a GitHub PR URL, or owner/repo#123.",
    );
  });

  it("states a reason for an empty field, rather than doing nothing", () => {
    expect(shownAfterPressing("")).toBe(
      "Paste a pull request link first — a GitHub PR URL, or owner/repo#123.",
    );
    expect(shownAfterPressing("   ")).toBe(
      "Paste a pull request link first — a GitHub PR URL, or owner/repo#123.",
    );
  });

  it("states a reason when the link parses but no paired project owns the repo", () => {
    expect(shownAfterPressing("someone/unknown#4")).toBe(
      "No paired project owns someone/unknown. Add it on your desktop first.",
    );
  });

  it("opens a PR the phone can actually address", () => {
    expect(planOpenPr("https://github.com/orbital/atlas/pull/214", projects)).toEqual({
      kind: "open",
      ref: "https://github.com/orbital/atlas/pull/214",
      repoKey: "key-atlas",
    });
  });

  it("has no silent outcome for any input", () => {
    const inputs = [
      "",
      " ",
      "\n\t",
      "garbage",
      "https://github.com",
      "https://github.com/orbital/atlas",
      "https://github.com/orbital/atlas/pull/notanumber",
      "orbital/atlas#",
      "someone/unknown#4",
      "orbital/atlas#214",
      "https://github.com/orbital/atlas/pull/214",
    ];
    for (const input of inputs) {
      const plan = planOpenPr(input, projects);
      if (plan.kind === "failed") {
        expect(
          plan.reason.trim().length,
          `silent failure for ${JSON.stringify(input)}`,
        ).toBeGreaterThan(0);
      } else {
        expect(
          plan.repoKey.length,
          `unaddressable open for ${JSON.stringify(input)}`,
        ).toBeGreaterThan(0);
      }
    }
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
