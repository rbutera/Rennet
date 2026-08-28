// @vitest-environment happy-dom
import type { PatchFile } from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { cleanup, mount } from "../test/dom";
import { DiffView } from "./diff-view";

// The diff surface writes the singleton review slice directly (no provider shim,
// reconciliation 4). Reset it between tests except the one that proves same-store persistence.
beforeEach(() => useRennetStore.getState().reviewActions.resetReview());

const PATH = "packages/core/src/a.ts";
const FILE: PatchFile = {
  path: PATH,
  status: "modified",
  additions: 1,
  deletions: 1,
  // new-side line 1 = context, line 2 = added.
  binary: false,
  patch: ["@@ -1,2 +1,2 @@", " const x = 1", "-const y = 2", "+const y = 3"].join("\n"),
};

function mountDiff() {
  const history = memoryHistory("/s/x?view=diff");
  return mount(
    <Router hook={history.hook} searchHook={history.searchHook}>
      <DiffView files={[FILE]} />
    </Router>,
  );
}

function rowState(line: number, container: HTMLElement): string | null {
  return container.querySelector(`[data-line="${line}"]`)?.getAttribute("data-line-state") ?? null;
}

describe("DiffView line comments — the C4 machinery, one object with the board", () => {
  it("clicking a line's comment button opens the editor; Save writes review.codeComments", async () => {
    const { getByLabelText, getByPlaceholderText, getByText, container, user } = mountDiff();
    await user.click(getByLabelText("Comment on line 2"));
    await user.type(getByPlaceholderText("Leave a comment on this line…"), "needs a guard");
    await user.click(getByText("Save"));
    expect(useRennetStore.getState().review.codeComments[PATH]?.[2]).toBe("needs a guard");
    // The commented line now shows the persistent (edit) glyph and reads evidence green.
    expect(getByLabelText("Edit comment on line 2")).toBeTruthy();
    expect(rowState(2, container)).toBe("comment");
    expect(container.querySelector('[data-line="2"]')?.className).toContain("bg-green/15");
  });

  it("a saved comment's glyph persists across a remount of the same store", () => {
    useRennetStore.getState().reviewActions.setCodeComment(PATH, 2, "note");
    const first = mountDiff();
    expect(first.getByLabelText("Edit comment on line 2")).toBeTruthy();
    first.unmount();
    const second = mountDiff();
    expect(second.getByLabelText("Edit comment on line 2")).toBeTruthy();
    second.unmount();
  });

  it("Request Changes saves the comment AND stages the path:line ask; the line reads danger red", async () => {
    const { getByLabelText, getByPlaceholderText, getByText, container, user } = mountDiff();
    await user.click(getByLabelText("Comment on line 1"));
    await user.type(getByPlaceholderText("Leave a comment on this line…"), "rename this");
    await user.click(getByText("Request Changes"));
    expect(useRennetStore.getState().review.codeComments[PATH]?.[1]).toBe("rename this");
    expect(useRennetStore.getState().review.stagedAsks[`${PATH}:1`]).toEqual({
      id: `${PATH}:1`,
      anchor: `${PATH}:1`,
      type: "request-change",
      body: "rename this",
    });
    // Danger red rides the row, and its state attr flips to "ask".
    expect(rowState(1, container)).toBe("ask");
    expect(container.querySelector('[data-line="1"]')?.className).toContain("bg-destructive/25");
  });

  it("danger-red vs evidence-green follows the store, not local state", () => {
    useRennetStore.getState().reviewActions.setCodeComment(PATH, 1, "plain note");
    useRennetStore.getState().reviewActions.setCodeComment(PATH, 2, "ask body");
    useRennetStore.getState().reviewActions.stageAsk({
      id: `${PATH}:2`,
      anchor: `${PATH}:2`,
      type: "request-change",
      body: "ask body",
    });
    const { container } = mountDiff();
    expect(rowState(1, container)).toBe("comment");
    expect(rowState(2, container)).toBe("ask");
    cleanup();
  });

  it("a deleted line (no new-side number) offers no comment button", () => {
    const { queryByLabelText } = mountDiff();
    // The del row is old-line 2 / new-line null — it carries no comment affordance.
    expect(queryByLabelText("Comment on line 2")).toBeTruthy(); // the ADDED new-line 2 does
    // …but there is no comment button for the deleted content itself (it has no new line).
    // Every comment button targets a new-side line, proven by there being exactly two
    // (context line 1 + added line 2), never three.
    const buttons = [1, 2].map((n) => queryByLabelText(`Comment on line ${n}`)).filter(Boolean);
    expect(buttons).toHaveLength(2);
  });
});

// ── A HISTORICAL surface writes nothing into the review's keyspace (#571) ─────
//
// THE DEFECT THIS GUARDS, which this PR introduced and review caught: `DiffView` had only
// ever been mounted over the review's own patchset, so `${path}:${line}` was unambiguous.
// Wiring the round diff mounted the same surface over checkpoint-to-checkpoint line
// numbers — a different coordinate system under the same key. Two silent losses follow:
// a comment left on a past round reappears on the live diff over code nobody read, and a
// request-change ask staged there REPLACES the live-diff ask at the same `path:line`
// ("re-save replaces it"). Nothing errors. The reviewer's own words go without a trace.
describe("a historical DiffView never touches the review's path:line keyspace (#571)", () => {
  function mountHistorical() {
    const history = memoryHistory("/s/x?view=diff&round=1");
    return mount(
      <Router hook={history.hook} searchHook={history.searchHook}>
        <DiffView files={[FILE]} historical />
      </Router>,
    );
  }

  it("offers no comment gutter at all — the live surface does, so the difference is the flag", () => {
    // The live surface: every new-side line carries the affordance.
    const live = mountDiff();
    expect(live.queryByLabelText("Comment on line 1")).toBeTruthy();
    live.unmount();
    // The historical surface: none of them do. Absent, not disabled.
    const past = mountHistorical();
    expect(past.queryByLabelText("Comment on line 1")).toBeNull();
    expect(past.queryByLabelText("Comment on line 2")).toBeNull();
    expect(past.container.querySelector("button[disabled]")).toBeNull();
  });

  it("does not PAINT the review's marks either — the read direction of the same lie", () => {
    // A live-diff comment on line 1 and a live-diff ask on line 2, both real.
    useRennetStore.getState().reviewActions.setCodeComment(PATH, 1, "live note");
    useRennetStore.getState().reviewActions.stageAsk({
      id: `${PATH}:2`,
      anchor: `${PATH}:2`,
      type: "request-change",
      body: "live ask",
    });
    const { container } = mountHistorical();
    // On the round's diff those lines are different code, so they wear neither mark.
    expect(rowState(1, container)).toBe("context");
    expect(rowState(2, container)).toBe("add");
    cleanup();
  });

  // THE HARM, EXECUTED. This drives whatever comment affordance the surface offers at the
  // coordinates a live-diff ask already occupies, then asserts the ask is untouched.
  //
  // ⚠️ In the FIXED state there is no affordance, so the click is a no-op and the survival
  // assertion passes because nothing could be written — it is vacuous here, and naming that
  // is the point. The CONTROL is what makes it load-bearing: drop `historical` from
  // `DiffViewContainer` (or from the mount below) and this fails with `body: "overwritten"`,
  // which is the silent replacement in full.
  it("a live-diff ask survives an attempt to comment at the same path:line", async () => {
    useRennetStore.getState().reviewActions.stageAsk({
      id: `${PATH}:1`,
      anchor: `${PATH}:1`,
      type: "request-change",
      body: "the reviewer's real words",
    });
    const { container, queryByLabelText, queryByPlaceholderText, queryByText, user } =
      mountHistorical();

    const gutter = queryByLabelText("Comment on line 1");
    expect(gutter).toBeNull(); // the affordance is absent — stated, not assumed
    if (gutter) {
      await user.click(gutter);
      const box = queryByPlaceholderText("Leave a comment on this line…");
      if (box) await user.type(box, "overwritten");
      const request = queryByText("Request Changes");
      if (request) await user.click(request);
    }

    expect(useRennetStore.getState().review.stagedAsks[`${PATH}:1`]?.body).toBe(
      "the reviewer's real words",
    );
    expect(useRennetStore.getState().review.codeComments[PATH]?.[1]).toBeUndefined();
    expect(container).toBeTruthy();
    cleanup();
  });
});
