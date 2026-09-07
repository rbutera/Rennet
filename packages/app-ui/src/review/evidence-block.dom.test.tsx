// @vitest-environment happy-dom
import type { CodeRef } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { useRennetStore } from "../store";
import { act, mount, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { type AnchoredAskInput, AnchoredAskProvider } from "./anchored-ask";
import { CodeBlock } from "./code-block";
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

it("windows full-file evidence around its cited line and keeps exact identity while scrolling", async () => {
  const rows = Array.from({ length: 20000 }, (_, index) => ({
    type: "context" as const,
    text: `line_${index + 1}`,
    oldLine: index + 1,
    newLine: index + 1,
  }));
  const view = mount(
    <CodeBlock
      code=""
      rows={rows}
      path={ref.path}
      patchsetId={ref.patchsetId}
      focusRef={{ ...ref, startLine: 10000, endLine: 10000 }}
    />,
  );
  expect(view.container.querySelectorAll("[data-code-line]").length).toBeLessThan(40);
  expect(view.container.querySelector('[data-code-line="10000"]')?.textContent).toContain(
    "line_10000",
  );
  const scroll = view.container.querySelector<HTMLElement>("[data-code-scroll]");
  if (!scroll) throw new Error("missing code scroller");
  act(() => {
    scroll.scrollTop = 19980 * 22;
    scroll.dispatchEvent(new Event("scroll"));
  });
  await waitFor(() =>
    expect(view.container.querySelector('[data-code-line="20000"]')?.textContent).toContain(
      "line_20000",
    ),
  );
  expect(view.container.querySelectorAll("[data-code-line]").length).toBeLessThan(40);
});

it("keeps a gutter comment editor outside virtual rows while its deleted line scrolls away", async () => {
  useRennetStore.setState((state) => ({ review: { ...state.review, quoteThreads: {} } }));
  const rows = Array.from({ length: 80 }, (_, index) => ({
    type: "del" as const,
    text: `removed_${index + 1}`,
    oldLine: index + 1,
    newLine: null,
  }));
  const view = mount(<CodeBlock code="" rows={rows} path={ref.path} patchsetId={ref.patchsetId} />);
  await view.user.click(view.getByRole("button", { name: "Comment on line 20" }));
  const editor = view.getByPlaceholderText("Leave a comment on this line…");
  expect(editor.closest("[data-code-scroll]")).toBeNull();
  await view.user.type(editor, "Keep this explanation");
  const scroll = view.container.querySelector<HTMLElement>("[data-code-scroll]");
  if (!scroll) throw new Error("missing code scroller");
  act(() => {
    scroll.scrollTop = 60 * 22;
    scroll.dispatchEvent(new Event("scroll"));
  });
  expect(view.container.querySelector('[data-code-line="20"]')).toBeNull();
  expect(view.getByPlaceholderText("Leave a comment on this line…")).toBe(editor);
  await view.user.click(view.getByRole("button", { name: "Save" }));
  const thread = Object.values(useRennetStore.getState().review.quoteThreads)[0];
  expect(thread?.codeRef).toEqual({ ...ref, side: "base", startLine: 20, endLine: 20 });
  expect(thread?.messages.at(-1)?.text).toBe("Keep this explanation");
});
