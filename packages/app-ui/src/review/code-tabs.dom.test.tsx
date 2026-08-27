// @vitest-environment happy-dom
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { useRennetStore } from "../store";
import { mount, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import type { CodeRef } from "./citations";
import { AnchorReveal, CodeTabs } from "./code-tabs";

const A: CodeRef = { patchsetId: "ps", path: "a/one.ts", side: "head", startLine: 10, endLine: 10 };
const B: CodeRef = { patchsetId: "ps", path: "b/two.ts", side: "head", startLine: 20, endLine: 20 };
// Same absolute line (5), different files — the same-line/different-file leak case.
const A5: CodeRef = { patchsetId: "ps", path: "a/one.ts", side: "head", startLine: 5, endLine: 5 };
const B5: CodeRef = { patchsetId: "ps", path: "b/two.ts", side: "head", startLine: 5, endLine: 5 };
// Same path AND line, different side — distinct legal refs that must not collide.
const HEAD5: CodeRef = {
  patchsetId: "ps",
  path: "a/one.ts",
  side: "head",
  startLine: 5,
  endLine: 5,
};
const BASE5: CodeRef = {
  patchsetId: "ps",
  path: "a/one.ts",
  side: "base",
  startLine: 5,
  endLine: 5,
};

function bridgeCounting(): { bridge: MemoryBridge; calls: () => number } {
  let calls = 0;
  const bridge = new MemoryBridge({
    "patchset.readSpan": (input) => {
      calls += 1;
      return { lines: [`x at ${input.startLine}`], contextBefore: [], contextAfter: [] };
    },
  });
  return { bridge, calls: () => calls };
}

function withBridge(bridge: MemoryBridge, node: ReactElement) {
  return <BridgeProvider bridge={bridge}>{node}</BridgeProvider>;
}

beforeEach(() => useRennetStore.getState().reviewActions.resetReview());

describe("CodeTabs / AnchorReveal — multi-site evidence", () => {
  it("single citation hides the tab strip and shows the one card", async () => {
    const { bridge } = bridgeCounting();
    const { getByText, container } = mount(withBridge(bridge, <CodeTabs citations={[A]} />));
    await waitFor(() => expect(getByText("L10")).toBeTruthy());
    expect(container.querySelectorAll("button[aria-pressed]")).toHaveLength(0);
  });

  it("multiple citations render one card at a time; a tab switches it", async () => {
    const { bridge } = bridgeCounting();
    const { getByText, getByRole, queryByText, user } = mount(
      withBridge(bridge, <CodeTabs citations={[A, B]} />),
    );
    await waitFor(() => expect(getByText("L10")).toBeTruthy());
    expect(queryByText("L20")).toBeNull();
    await user.click(getByRole("button", { name: "two.ts:20" }));
    await waitFor(() => expect(getByText("L20")).toBeTruthy());
    expect(queryByText("L10")).toBeNull();
  });

  it("AnchorReveal fetches on click, folds on re-click, and does NOT refetch on re-open", async () => {
    const { bridge, calls } = bridgeCounting();
    const { getByRole, getByText, queryByText, user } = mount(
      withBridge(bridge, <AnchorReveal citations={[A]} />),
    );
    // Folded: nothing fetched.
    expect(queryByText("L10")).toBeNull();
    expect(calls()).toBe(0);
    // Open → fetch once.
    await user.click(getByRole("button", { name: "one.ts:10" }));
    await waitFor(() => expect(getByText("L10")).toBeTruthy());
    expect(calls()).toBe(1);
    // Fold.
    await user.click(getByRole("button", { name: "one.ts:10" }));
    expect(queryByText("L10")).toBeNull();
    // Re-open → served from the seam's cache, no second invoke.
    await user.click(getByRole("button", { name: "one.ts:10" }));
    await waitFor(() => expect(getByText("L10")).toBeTruthy());
    expect(calls()).toBe(1);
  });

  it("a half-written line comment does NOT leak across a same-line, different-file tab switch", async () => {
    const { bridge } = bridgeCounting();
    const {
      getByLabelText,
      getByPlaceholderText,
      queryByPlaceholderText,
      getByRole,
      getByText,
      user,
    } = mount(withBridge(bridge, <CodeTabs citations={[A5, B5]} />));
    // Open the line-5 comment editor on file A and type a draft (never saved).
    await waitFor(() => expect(getByText("L5")).toBeTruthy());
    await user.click(getByLabelText("Comment on line 5"));
    await user.type(getByPlaceholderText("Leave a comment on this line…"), "draft for file A");
    // Switch to file B, which cites the SAME absolute line 5.
    await user.click(getByRole("button", { name: "two.ts:5" }));
    await waitFor(() => expect(getByText("L5")).toBeTruthy());
    // The surface remounted: no open editor carrying A's draft into B's callbacks.
    expect(queryByPlaceholderText("Leave a comment on this line…")).toBeNull();
    // And nothing was written to either file's comment map.
    expect(useRennetStore.getState().review.codeComments).toEqual({});
  });

  it("tracks the selected tab by ref identity across reordering, not by array index", async () => {
    const { bridge } = bridgeCounting();
    const { getByRole, getByText, queryByText, rerender, user } = mount(
      withBridge(bridge, <CodeTabs citations={[A, B]} />),
    );
    await user.click(getByRole("button", { name: "two.ts:20" }));
    await waitFor(() => expect(getByText("L20")).toBeTruthy());
    // Reorder the list — B now leads. Selection follows the REF, so B stays shown.
    rerender(withBridge(bridge, <CodeTabs citations={[B, A]} />));
    await waitFor(() => expect(getByText("L20")).toBeTruthy());
    expect(queryByText("L10")).toBeNull();
  });

  it("shrinking the list below the active tab falls back to the first citation, never hides the viewer", async () => {
    const { bridge } = bridgeCounting();
    const { getByRole, getByText, rerender, user } = mount(
      withBridge(bridge, <CodeTabs citations={[A, B]} />),
    );
    await user.click(getByRole("button", { name: "two.ts:20" }));
    await waitFor(() => expect(getByText("L20")).toBeTruthy());
    // Drop B (the active tab). The viewer stays visible, showing the surviving citation.
    rerender(withBridge(bridge, <CodeTabs citations={[A]} />));
    await waitFor(() => expect(getByText("L10")).toBeTruthy());
  });

  it("base and head refs at the same path:line are distinct tabs that do not collide", async () => {
    const { bridge } = bridgeCounting();
    const { container } = mount(withBridge(bridge, <CodeTabs citations={[HEAD5, BASE5]} />));
    await waitFor(() => expect(container.querySelectorAll("button[aria-pressed]")).toHaveLength(2));
    // Exactly one is active — the two refs are not treated as the same tab.
    expect(container.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1);
  });

  it("an unreadable citation renders one honest line, never a silent empty block", async () => {
    const bridge = new MemoryBridge({}); // no handler → rejects like unbound dispatch
    const { getByRole, getByText, user } = mount(
      withBridge(bridge, <AnchorReveal citations={[A]} />),
    );
    await user.click(getByRole("button", { name: "one.ts:10" }));
    await waitFor(() =>
      expect(getByText("a/one.ts is not readable from the captured patchset.")).toBeTruthy(),
    );
  });
});
