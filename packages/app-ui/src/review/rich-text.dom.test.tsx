// @vitest-environment happy-dom
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { useRennetStore } from "../store";
import { mount, waitFor } from "../test/dom";
import { MemoryBridge, refusesSpanRead, SPAN_OUTSIDE_CAPTURE } from "../test/memory-bridge";
import { displayToRawRange, RichText } from "./rich-text";

const PS = "ps-1";

function withBridge(bridge: MemoryBridge, node: ReactElement) {
  return <BridgeProvider bridge={bridge}>{node}</BridgeProvider>;
}

function spanBridge() {
  return new MemoryBridge({
    "patchset.readSpan": (input) => ({
      lines: [`content at line ${input.startLine}`],
      contextBefore: [],
      contextAfter: [],
    }),
  });
}

beforeEach(() => useRennetStore.getState().reviewActions.resetReview());

describe("displayToRawRange", () => {
  it("keeps plain and bold display text on exact source characters", () => {
    const raw = "before plain and **bold words** after";
    const plain = displayToRawRange(raw, "plain");
    const bold = displayToRawRange(raw, "bold words");

    expect(plain).toEqual({ start: 7, end: 12 });
    expect(bold).toEqual({ start: 19, end: 29 });
    expect(plain && raw.slice(plain.start, plain.end)).toBe("plain");
    expect(bold && raw.slice(bold.start, bold.end)).toBe("bold words");
  });

  it("snaps a backtick display selection to the full raw token", () => {
    const raw = "call `decompose()` now";
    const range = displayToRawRange(raw, "decompose()");

    expect(range).toEqual({ start: 5, end: 18 });
    expect(range && raw.slice(range.start, range.end)).toBe("`decompose()`");
  });

  it("snaps a shortened citation label to the full raw citation", () => {
    const raw = "see packages/core/worker.ts:42-43 here";
    const range = displayToRawRange(raw, "worker.ts:42-43");

    expect(range).toEqual({ start: 4, end: 33 });
    expect(range && raw.slice(range.start, range.end)).toBe("packages/core/worker.ts:42-43");
  });

  it("returns null for ambiguous display text and absent text", () => {
    expect(displayToRawRange("`same` and same", "same")).toBeNull();
    expect(displayToRawRange("one phrase", "missing")).toBeNull();
    expect(displayToRawRange("one phrase", "")).toBeNull();
  });
});

describe("RichText — R45 markdown subset (base tier)", () => {
  it("renders bold as a real <strong>, never literal asterisks", () => {
    const { container, queryByText } = mount(
      withBridge(spanBridge(), <RichText text="a **bold** word" patchsetId={PS} />),
    );
    const strong = container.querySelector("strong");
    expect(strong?.textContent).toBe("bold");
    expect(queryByText(/\*\*/)).toBeNull();
  });

  it("renders a `- ` block as a bulleted list", () => {
    const { container } = mount(
      withBridge(spanBridge(), <RichText text={"- first\n- second\n- third"} patchsetId={PS} />),
    );
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("renders a single `- item` paragraph as a one-item bulleted list", () => {
    const { container } = mount(
      withBridge(spanBridge(), <RichText text={"- only one"} patchsetId={PS} />),
    );
    expect(container.querySelectorAll("li")).toHaveLength(1);
    expect(container.querySelector("li")?.textContent).toBe("only one");
  });

  it("renders a citation chip INSIDE bold, with no literal asterisks left over", () => {
    const { container, getByRole, queryByText } = mount(
      withBridge(spanBridge(), <RichText text="**packages/a/b.ts:10**" patchsetId={PS} />),
    );
    const strong = container.querySelector("strong");
    expect(getByRole("button", { name: "b.ts:10" })).toBeTruthy();
    expect(strong?.querySelector("button")).toBeTruthy();
    expect(queryByText(/\*\*/)).toBeNull();
  });

  it("renders a backticked term INSIDE bold, with no literal asterisks left over", () => {
    const { container, queryByText } = mount(
      withBridge(spanBridge(), <RichText text={"**`term`**"} patchsetId={PS} />),
    );
    const strong = container.querySelector("strong");
    expect(strong?.querySelector("code")?.textContent).toBe("term");
    expect(queryByText(/\*\*/)).toBeNull();
  });

  it("drops a revealed citation when the prose changes (no stale reveal under new text)", async () => {
    const { getByRole, getByText, queryByText, rerender, user } = mount(
      withBridge(spanBridge(), <RichText text="see packages/core/x.ts:42 here" patchsetId={PS} />),
    );
    await user.click(getByRole("button", { name: "x.ts:42" }));
    await waitFor(() => expect(getByText("L42")).toBeTruthy());
    // Replace the prose entirely; the reveal keyed to the old paragraph must not survive.
    rerender(
      withBridge(spanBridge(), <RichText text="entirely different prose" patchsetId={PS} />),
    );
    expect(queryByText("L42")).toBeNull();
  });

  it("bolds normative-grammar keywords only when keywords is set", () => {
    const on = mount(
      withBridge(spanBridge(), <RichText text="the code MUST hold" patchsetId={PS} keywords />),
    );
    const kw = [...on.container.querySelectorAll("span")].find((s) => s.textContent === "MUST");
    expect(kw?.className).toContain("font-semibold");
    on.unmount();

    const off = mount(
      withBridge(spanBridge(), <RichText text="the code MUST hold" patchsetId={PS} />),
    );
    expect([...off.container.querySelectorAll("span")].some((s) => s.textContent === "MUST")).toBe(
      false,
    );
  });

  it("renders backticked terms as plain monospace <code>", () => {
    const { container } = mount(
      withBridge(spanBridge(), <RichText text="call `decompose()` now" patchsetId={PS} />),
    );
    const code = container.querySelector("code");
    expect(code?.textContent).toBe("decompose()");
  });

  it("renders every token kind together in one paragraph", () => {
    const { container, getByRole } = mount(
      withBridge(
        spanBridge(),
        <RichText
          text="**Bold** and `code` and MUST and packages/a/b.ts:10 done."
          patchsetId={PS}
          keywords
        />,
      ),
    );
    expect(container.querySelector("strong")?.textContent).toBe("Bold");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect([...container.querySelectorAll("span")].some((s) => s.textContent === "MUST")).toBe(
      true,
    );
    expect(getByRole("button", { name: "b.ts:10" })).toBeTruthy();
  });

  it("a citation chip reveals the cited span on click and folds on a second click", async () => {
    const { getByRole, getByText, queryByText, user } = mount(
      withBridge(spanBridge(), <RichText text="see packages/core/x.ts:42 here" patchsetId={PS} />),
    );
    expect(queryByText("L42")).toBeNull();
    await user.click(getByRole("button", { name: "x.ts:42" }));
    await waitFor(() => expect(getByText("L42")).toBeTruthy());
    await user.click(getByRole("button", { name: "x.ts:42" }));
    expect(queryByText("L42")).toBeNull();
  });

  it("relays the daemon's OWN reason for an unreadable citation", async () => {
    const { getByRole, getByText, user } = mount(
      withBridge(
        new MemoryBridge({ "patchset.readSpan": refusesSpanRead }),
        <RichText text="see packages/core/x.ts:42 here" patchsetId={PS} />,
      ),
    );
    await user.click(getByRole("button", { name: "x.ts:42" }));
    await waitFor(() =>
      expect(
        getByText(`packages/core/x.ts lines 42–42 (head) ${SPAN_OUTSIDE_CAPTURE}.`),
      ).toBeTruthy(),
    );
  });
});
