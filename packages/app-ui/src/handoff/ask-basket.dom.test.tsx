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
  act(() => store().reviewActions.stageAsk({ anchor, type, body: `body for ${anchor}` }));
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

  it("shows only the body stratum when every ask is prose", () => {
    stage("One prose ask.");
    stage("Two prose asks.");
    const r = mount(<AskBasket />);
    expect(r.container.querySelectorAll("ul")).toHaveLength(1);
  });
});
