import { describe, expect, it } from "vitest";
import {
  ascendTo,
  back,
  crumb,
  forward,
  NAV_HISTORY_VERSION,
  type NavHistoryState,
  navHistoryReducer,
  parse,
  push,
  type RecentSurface,
  recordRecent,
  replaceTop,
  type Surface,
  serialize,
  surfaceIdentity,
} from "./history";

const projects: Surface = { kind: "projects" };
const project: Surface = { kind: "project", projectId: "p1" };
const review: Surface = { kind: "review", reviewId: "r1" };
const draft: Surface = { kind: "draft", reviewId: "r1" };
const paper: Surface = { kind: "paper", reviewId: "r1" };

describe("navigation history laws", () => {
  it("push grows the stack by one and clears future", () => {
    const state: NavHistoryState = {
      stack: [projects, project],
      future: [paper],
    };

    const next = navHistoryReducer(state, push(review));

    expect(next.stack).toHaveLength(state.stack.length + 1);
    expect(next.stack.at(-1)).toEqual(review);
    expect(next.future).toEqual([]);
  });

  it("back from a review lands on its project, not Projects", () => {
    const state: NavHistoryState = {
      stack: [projects, project, review],
      future: [],
    };

    const next = navHistoryReducer(state, back());

    expect(next.stack.at(-1)).toEqual(project);
    expect(next.stack.at(-1)).not.toEqual(projects);
    expect(next.future).toEqual([review]);
  });

  it("forward after back restores the popped surface", () => {
    const state: NavHistoryState = {
      stack: [projects, project, review],
      future: [],
    };

    const afterBack = navHistoryReducer(state, back());
    const afterForward = navHistoryReducer(afterBack, forward());

    expect(afterForward).toEqual(state);
  });

  it("ascendTo truncates to the selected tier and clears future", () => {
    const state: NavHistoryState = {
      stack: [projects, project, review, draft],
      future: [paper],
    };

    const next = navHistoryReducer(state, ascendTo(1));

    expect(next.stack).toEqual([projects, project]);
    expect(next.future).toEqual([]);
  });

  it("replaceTop swaps the tip without changing history length and invalidates future", () => {
    const state: NavHistoryState = {
      stack: [projects, project, review],
      future: [{ kind: "draft", reviewId: "r1" }],
    };

    const next = navHistoryReducer(state, replaceTop({ kind: "review", reviewId: "r2" }));

    expect(next.stack).toHaveLength(state.stack.length);
    expect(next.stack.at(-1)).toEqual({ kind: "review", reviewId: "r2" });
    expect(next.future).toEqual([]);
  });
});

describe("crumb", () => {
  it("returns one ordered segment per surface and no lens segment", () => {
    const stack: Surface[] = [projects, project, review, draft, paper];

    const segments = crumb(stack);

    expect(segments).toHaveLength(stack.length);
    expect(segments).toEqual([
      { label: "Projects", kind: "projects", index: 0 },
      { label: "p1", kind: "project", index: 1 },
      { label: "r1", kind: "review", index: 2 },
      { label: "Draft", kind: "draft", index: 3 },
      { label: "Paper", kind: "paper", index: 4 },
    ]);
    expect(segments.map(({ kind }) => kind)).not.toContain("lens");
  });

  it("uses known human labels, falls back to ids, and keeps fixed surface words", () => {
    const segments = crumb([projects, project, review, draft, paper], {
      project: (id) => (id === "p1" ? "Rennet" : undefined),
      review: () => "Review of navigation polish",
    });

    expect(segments.map(({ label }) => label)).toEqual([
      "Projects",
      "Rennet",
      "Review of navigation polish",
      "Draft",
      "Paper",
    ]);
    expect(
      crumb(
        [
          { kind: "project", projectId: "unknown-project" },
          { kind: "review", reviewId: "unknown-review" },
        ],
        { project: () => undefined, review: () => "" },
      ).map(({ label }) => label),
    ).toEqual(["unknown-project", "unknown-review"]);
  });
});

describe("recent surfaces", () => {
  it("identifies surfaces by kind and id", () => {
    expect(surfaceIdentity(project)).toBe("project:p1");
    expect(surfaceIdentity(review)).toBe("review:r1");
    expect(surfaceIdentity(draft)).toBe("draft:r1");
    expect(surfaceIdentity(projects)).toBe("projects");
  });

  it("unshifts the latest landing, dedupes by identity, and caps at eight", () => {
    const visited = Array.from(
      { length: 9 },
      (_, index): RecentSurface => ({
        kind: "project",
        projectId: `p${index}`,
      }),
    ).reduce<RecentSurface[]>((recents, surface) => recordRecent(recents, surface), []);

    expect(visited).toHaveLength(8);
    expect(visited.map(surfaceIdentity)).toEqual([
      "project:p8",
      "project:p7",
      "project:p6",
      "project:p5",
      "project:p4",
      "project:p3",
      "project:p2",
      "project:p1",
    ]);
    expect(
      recordRecent(visited, { kind: "project", projectId: "p4" }).map(surfaceIdentity),
    ).toEqual([
      "project:p4",
      "project:p8",
      "project:p7",
      "project:p6",
      "project:p5",
      "project:p3",
      "project:p2",
      "project:p1",
    ]);
  });
});

describe("persisted navigation (v3 stack + recents)", () => {
  const persisted = { recents: [project, projects], stack: [], future: [] };

  it("is version 3", () => {
    expect(NAV_HISTORY_VERSION).toBe(3);
  });

  it("serialize emits { version: 3, recents, stack, future } and round-trips all three", () => {
    const stack: Surface[] = [projects, project, review];
    const future: Surface[] = [draft];
    const raw = serialize([project, projects], stack, future);

    expect(JSON.parse(raw)).toEqual({
      version: 3,
      recents: [project, projects],
      stack,
      future,
    });
    expect(parse(raw)).toEqual({ recents: [project, projects], stack, future });
  });

  it("review-family surfaces are legal in the persisted stack (the #305 exclusion is gone)", () => {
    const stack: Surface[] = [projects, project, review, draft, paper];
    const raw = serialize([], stack, []);
    expect(parse(raw).stack).toEqual(stack);
  });

  it("serialize with no stack/future defaults them to empty arrays", () => {
    expect(JSON.parse(serialize([project]))).toEqual({
      version: 3,
      recents: [project],
      stack: [],
      future: [],
    });
  });

  it("keeps a v2 blob's recents with an empty stack (no migration ceremony)", () => {
    const v2 = JSON.stringify({ version: 2, recents: [project, projects] });
    expect(parse(v2)).toEqual({ recents: [project, projects], stack: [], future: [] });
  });

  it("returns the clean default for absent, malformed, or unknown-version blobs", () => {
    const clean = { recents: [], stack: [], future: [] };

    expect(parse(undefined)).toEqual(clean);
    expect(parse(null)).toEqual(clean);
    expect(parse("not json")).toEqual(clean);
    expect(
      parse(JSON.stringify({ version: 99, recents: persisted.recents, stack: [], future: [] })),
    ).toEqual(clean);
  });

  it("drops the stack but keeps valid recents when a stack entry is invalid", () => {
    const raw = JSON.stringify({
      version: 3,
      recents: [project],
      stack: [projects, { kind: "review", reviewId: "" }],
      future: [],
    });
    expect(parse(raw)).toEqual({ recents: [project], stack: [], future: [] });
  });

  it("still parses recents when they are invalid (recents empty, stack preserved)", () => {
    const raw = JSON.stringify({
      version: 3,
      recents: [review],
      stack: [projects, project],
      future: [],
    });
    // A review is not a legal RECENT (projects/project only) → recents drop to empty,
    // but the stack (where review IS legal) survives.
    expect(parse(raw)).toEqual({ recents: [], stack: [projects, project], future: [] });
  });

  it("globally dedupes first occurrences and caps parsed recents", () => {
    const recents = [
      { kind: "project", projectId: "p0" },
      { kind: "project", projectId: "p0" },
      ...Array.from({ length: 9 }, (_, index) => ({
        kind: "project" as const,
        projectId: `p${index + 1}`,
      })),
    ];

    expect(
      parse(
        JSON.stringify({ version: NAV_HISTORY_VERSION, recents, stack: [], future: [] }),
      ).recents.map(surfaceIdentity),
    ).toEqual([
      "project:p0",
      "project:p1",
      "project:p2",
      "project:p3",
      "project:p4",
      "project:p5",
      "project:p6",
      "project:p7",
    ]);
  });
});
