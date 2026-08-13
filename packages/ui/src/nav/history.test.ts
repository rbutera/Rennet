import { describe, expect, it } from "vitest";
import {
  ascendTo,
  back,
  crumb,
  forward,
  hydrate,
  NAV_HISTORY_VERSION,
  type NavHistoryState,
  navHistoryReducer,
  parse,
  push,
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
      (_, index): Surface => ({
        kind: "review",
        reviewId: `r${index}`,
      }),
    ).reduce<Surface[]>((recents, surface) => recordRecent(recents, surface), []);

    expect(visited).toHaveLength(8);
    expect(visited.map(surfaceIdentity)).toEqual([
      "review:r8",
      "review:r7",
      "review:r6",
      "review:r5",
      "review:r4",
      "review:r3",
      "review:r2",
      "review:r1",
    ]);
    expect(recordRecent(visited, { kind: "review", reviewId: "r4" }).map(surfaceIdentity)).toEqual([
      "review:r4",
      "review:r8",
      "review:r7",
      "review:r6",
      "review:r5",
      "review:r3",
      "review:r2",
      "review:r1",
    ]);
  });
});

describe("persisted navigation", () => {
  const persisted = {
    stack: [projects, project, review],
    future: [draft],
    recents: [review, project],
  } satisfies NavHistoryState & { recents: Surface[] };

  it("round-trips stack, future, and recents through the versioned blob", () => {
    const raw = serialize(persisted);

    expect(JSON.parse(raw).version).toBe(NAV_HISTORY_VERSION);
    expect(parse(raw)).toEqual(persisted);
    expect(hydrate(raw, "r1")).toEqual(persisted);
  });

  it("returns the clean default for absent, malformed, mismatched, or invalid state", () => {
    const clean = { stack: [projects], future: [], recents: [] };

    expect(hydrate(undefined, null)).toEqual(clean);
    expect(hydrate("not json", null)).toEqual(clean);
    expect(
      hydrate(JSON.stringify({ ...persisted, version: NAV_HISTORY_VERSION + 1 }), null),
    ).toEqual(clean);
    expect(
      hydrate(JSON.stringify({ version: NAV_HISTORY_VERSION, ...persisted, stack: [] }), null),
    ).toEqual(clean);
  });

  it("keeps a matching bootstrap review exactly once", () => {
    const hydrated = hydrate(serialize(persisted), "r1");

    expect(hydrated.stack).toEqual([projects, project, review]);
    expect(hydrated.stack.filter((surface) => surface.kind === "review")).toHaveLength(1);
  });

  it("floors a stale review-family tip to its nearest project ancestor and clears future", () => {
    const stale = serialize({
      stack: [projects, project, review, draft, paper],
      future: [{ kind: "review", reviewId: "future" }],
      recents: [paper, review],
    });

    expect(hydrate(stale, "another-review")).toEqual({
      stack: [projects, project],
      future: [],
      recents: [paper, review],
    });
    expect(
      hydrate(serialize({ stack: [projects, review], future: [draft], recents: [review] }), null),
    ).toEqual({ stack: [projects], future: [], recents: [review] });
  });
});
