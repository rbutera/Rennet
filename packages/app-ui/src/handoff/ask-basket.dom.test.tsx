// @vitest-environment happy-dom
//
// The ask basket (C08 cluster 3, Objective clause 2, R29). The load-bearing claims: a staged
// ask appears; unstage removes it AND decrements the derived exit pip (selectExitPipCount);
// body-vs-line routing is by PLACEMENT (a code-anchored ask in the line stratum, an anchorless
// one in the body stratum) with no chrome copy explaining the split.
import { afterEach, describe, expect, it } from "vitest";
import { useRennetStore } from "../store";
import { act, cleanup, mount } from "../test/dom";
import { AskBasket } from "./ask-basket";
import { selectExitPipCount } from "./selectors";

const store = () => useRennetStore.getState();
const pip = () => selectExitPipCount(useRennetStore.getState());
function stage(anchor: string, type: "comment" | "request-change" = "comment") {
  act(() =>
    store().reviewActions.stageAsk({ id: anchor, anchor, type, body: `body for ${anchor}` }),
  );
}

afterEach(() => {
  cleanup();
  store().reviewActions.resetReview();
});

describe("AskBasket", () => {
  it("renders a staged ask with its body", () => {
    stage("This holds up.");
    const r = mount(<AskBasket />);
    expect(r.getByText("body for This holds up.")).toBeTruthy();
  });

  it("shows an empty state when nothing is staged", () => {
    const r = mount(<AskBasket />);
    expect(r.getByText("No asks staged.")).toBeTruthy();
  });

  it("unstage removes the ask and decrements the derived pip", async () => {
    stage("src/store.ts:42", "request-change");
    stage("Another span.");
    expect(pip()).toBe(2);
    const r = mount(<AskBasket />);
    expect(r.getAllByRole("listitem")).toHaveLength(2);

    await r.user.click(r.getByRole("button", { name: /unstage request change/i }));
    expect(store().review.stagedAsks["src/store.ts:42"]).toBeUndefined();
    expect(pip()).toBe(1);
    expect(r.getAllByRole("listitem")).toHaveLength(1);
  });

  it("routes a code-anchored ask to the line stratum and an anchorless one to the body", () => {
    stage("src/store.ts:42"); // path:line ⇒ line comment
    stage("This reads clean."); // prose span ⇒ review body
    const r = mount(<AskBasket />);
    const lists = r.container.querySelectorAll("ul");
    // Two strata rendered by placement — no label copy names either.
    expect(lists).toHaveLength(2);
    // The code anchor shows as a monospace path:line; the prose span shows quoted.
    expect(r.getByText("src/store.ts:42")).toBeTruthy();
    expect(r.getByText(/“This reads clean\.”/)).toBeTruthy();
  });

  // ── Round 5, item 4 ─────────────────────────────────────────────────────────
  // The session thread can stage an ask, the durable log has recorded WHO since the app
  // tools shipped (stamped server-side from the call's own address), and no surface read it:
  // app-ui's own `StagedAsk` did not declare `author`, so the field arrived in every
  // `hydrateAsks` projection at runtime and reached no pixel — while the spec and three doc
  // pages said the reviewer sees it. These pin the fact on the object.
  it("names the chat thread on an ask the thread staged", () => {
    act(() =>
      store().reviewActions.stageAsk({
        id: "a1",
        anchor: "src/auth.ts:12",
        type: "request-change",
        body: "Retry the refresh before failing the request.",
        author: { kind: "orchestrator", id: "thread-1" },
      }),
    );
    const r = mount(<AskBasket />);
    expect(r.getByText("From the chat thread")).toBeTruthy();
  });

  it("says nothing about authorship on the reviewer's own ask — the default needs no label", () => {
    // The control: the label is a fact about an ask that has one, not chrome on every row.
    stage("src/auth.ts:12", "request-change");
    const r = mount(<AskBasket />);
    expect(r.queryByText("From the chat thread")).toBeNull();
    expect(r.container.querySelector("[data-ask-author]")).toBeNull();
  });

  it("carries `author` through the projection hydration, which is how it arrives in production", () => {
    // The renderer reads the slice, and the slice is REPLACED wholesale by `ask.read`'s
    // projection — so a type that dropped the field on the way in would leave the two tests
    // above passing over a locally-staged ask and failing over a real one.
    act(() =>
      store().reviewActions.hydrateAsks({
        stagedAsks: {
          a1: {
            id: "a1",
            anchor: "src/auth.ts:12",
            type: "comment",
            body: "From the thread.",
            author: { kind: "orchestrator", id: "thread-1" },
          },
        },
        findingDispositions: {},
        lineComments: {},
        quoteThreads: {},
        retired: {},
        verdictOverride: null,
      }),
    );
    expect(store().review.stagedAsks.a1?.author?.kind).toBe("orchestrator");
    const r = mount(<AskBasket />);
    expect(r.getByText("From the chat thread")).toBeTruthy();
  });

  it("shows only the body stratum when every ask is prose", () => {
    stage("One prose ask.");
    stage("Two prose asks.");
    const r = mount(<AskBasket />);
    expect(r.container.querySelectorAll("ul")).toHaveLength(1);
  });
});
