import { describe, expect, it } from "vitest";
import {
  ascendTo,
  back,
  crumb,
  forward,
  type NavHistoryState,
  navHistoryReducer,
  push,
  replaceTop,
  type Surface,
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

  it("replaceTop swaps the tip without changing history length or future", () => {
    const state: NavHistoryState = {
      stack: [projects, project, review],
      future: [draft],
    };

    const next = navHistoryReducer(state, replaceTop({ kind: "review", reviewId: "r2" }));

    expect(next.stack).toHaveLength(state.stack.length);
    expect(next.stack.at(-1)).toEqual({ kind: "review", reviewId: "r2" });
    expect(next.future).toEqual(state.future);
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
});
