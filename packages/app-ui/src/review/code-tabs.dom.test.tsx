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
