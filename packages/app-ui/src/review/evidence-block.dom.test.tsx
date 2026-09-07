// @vitest-environment happy-dom
import type { CodeRef } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { useRennetStore } from "../store";
import { act, mount, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { type AnchoredAskInput, AnchoredAskProvider } from "./anchored-ask";
import { CitationBlock } from "./code-tabs";
import { ProseSelectionLayer } from "./selection-toolbar";

const ref: CodeRef = {
  patchsetId: "ps",
  path: "src/cheese.ts",
  side: "head",
  startLine: 2,
  endLine: 2,
};

describe("inline diff evidence navigation", () => {
  it("renders both signs without selecting code, expands source, opens unchanged tests and returns", async () => {
    const reads: Array<{ path: string; includeSource?: boolean }> = [];
    const bridge = new MemoryBridge({
      "patchset.readSpan": () => ({ lines: ["new"], contextBefore: [], contextAfter: [] }),
      "patchset.readEvidence": ({ ref: input, includeSource, includeCounterparts }) => {
        reads.push({ path: input.path, includeSource });
        const test = input.path === "tests/maturing.test.ts";
        return {
          path: input.path,
          patch: test ? "" : "@@ -1,3 +1,3 @@\n first\n-old\n+new\n third\n",
          ...(includeSource
            ? {
                base: "first\nold\nthird\nlast\n",
                head: test ? "test reviewed source" : "first\nnew\nthird\nlast\n",
              }
            : {}),
          counterparts: includeCounterparts ? [test ? ref.path : "tests/maturing.test.ts"] : [],
        };
      },
    });
    const view = mount(
      <BridgeProvider bridge={bridge}>
        <CitationBlock citation={ref} />
      </BridgeProvider>,
    );
    await waitFor(() =>
      expect(view.container.querySelector('[data-diff-kind="del"]')).toBeTruthy(),
    );
    expect(view.getByText("-")).toBeTruthy();
    expect(view.getByText("+")).toBeTruthy();
    expect(view.container.querySelector('[data-line-state="cited"]')).toBeNull();
    expect(view.container.querySelector('[data-line-state="comment"]')).toBeNull();
    expect(reads.some((read) => read.includeSource)).toBe(false);
    await view.user.click(view.getByText("Expand context"));
    await waitFor(() => expect(view.getByText("last")).toBeTruthy());
    await view.user.click(view.getByText("View test"));
    await waitFor(() => expect(view.getByText("test reviewed source")).toBeTruthy());
    expect(view.getByText("View implementation")).toBeTruthy();
    await view.user.click(view.getByText("View implementation"));
    await waitFor(() => expect(view.getByText("last")).toBeTruthy());
    await view.user.click(view.getByText("View test"));
    await waitFor(() => expect(view.getByText("Back to review")).toBeTruthy());
    await view.user.click(view.getByText("Back to review"));
    await waitFor(() => expect(view.getByText("last")).toBeTruthy());
    await waitFor(() =>
      expect(view.container.querySelector('[data-diff-kind="del"]')).toBeTruthy(),
    );
    expect(view.container.querySelector('[data-evidence-path="src/cheese.ts"]')).toBeTruthy();
  });
  it("offers a chooser instead of picking an arbitrary counterpart", async () => {
    const bridge = new MemoryBridge({
      "patchset.readSpan": () => ({ lines: ["new"], contextBefore: [], contextAfter: [] }),
      "patchset.readEvidence": () => ({
        path: ref.path,
        patch: "@@ -1 +1 @@\n-old\n+new\n",
        counterparts: ["tests/one.test.ts", "tests/two.test.ts"],
      }),
    });
    const view = mount(
      <BridgeProvider bridge={bridge}>
        <CitationBlock citation={ref} />
      </BridgeProvider>,
    );
    await waitFor(() => expect(view.getByText("View tests")).toBeTruthy());
    await view.user.click(view.getByText("View tests"));
    expect(view.getByText("tests/one.test.ts")).toBeTruthy();
    expect(view.getByText("tests/two.test.ts")).toBeTruthy();
  });
});

it("saves a deleted-code selection and preserves its identity when replying", async () => {
  useRennetStore.getState().reviewActions.resetReview();
  const sent: AnchoredAskInput[] = [];
  const bridge = new MemoryBridge({
    "patchset.readSpan": () => ({ lines: ["new"], contextBefore: [], contextAfter: [] }),
    "patchset.readEvidence": () => ({
      path: ref.path,
      patch: "@@ -2 +2 @@\n-old\n+new\n",
      counterparts: [],
    }),
  });
  const view = mount(
    <BridgeProvider bridge={bridge}>
      <AnchoredAskProvider
        value={async (input) => {
          sent.push(input);
        }}
      >
        <ProseSelectionLayer>
          <CitationBlock citation={ref} />
        </ProseSelectionLayer>
      </AnchoredAskProvider>
    </BridgeProvider>,
  );
  await waitFor(() => expect(view.container.querySelector('[data-code-side="base"]')).toBeTruthy());
  const line = view.container.querySelector('[data-code-side="base"]');
  if (!line) throw new Error("Missing deleted line");
  const range = document.createRange();
  range.selectNodeContents(line);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  act(() => line.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
  await view.user.click(view.getByText("Comment"));
  await view.user.type(
    view.getByPlaceholderText("Ask a question or leave a comment…"),
    "Keep this deletion visible",
  );
  await view.user.click(view.getByText("Save"));
  expect(view.getByText("Keep this deletion visible")).toBeTruthy();
  expect(view.getByText("-")).toBeTruthy();
  await view.user.type(view.getByPlaceholderText("Reply…"), "Why remove it?{Enter}");
  expect(sent[0]?.codeRef).toEqual({ ...ref, side: "base" });
});
