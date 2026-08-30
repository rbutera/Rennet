// @vitest-environment happy-dom
import type { PatchFile } from "@rennet/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount } from "../test/dom";
import { DiffView } from "./diff-view";

// The diff surface reads/writes the singleton review slice directly (like CodeBlock).
// Reset it between tests so viewed/comment state never leaks across cases.
beforeEach(() => useRennetStore.getState().reviewActions.resetReview());

const FILE_A: PatchFile = {
  path: "packages/core/src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  binary: false,
  patch: ["@@ -1,2 +1,2 @@", " const x = 1", "-const y = 2", "+const y = 3"].join("\n"),
};

const FILE_B: PatchFile = {
  path: "packages/ui/src/b.tsx",
  status: "added",
  additions: 2,
  deletions: 0,
  binary: false,
  patch: ["@@ -0,0 +1,2 @@", "+export const b = 1", "+export const c = 2"].join("\n"),
};

function largeFile(index: number, lineCount = 500): PatchFile {
  const path = `packages/large/src/file-${index}.ts`;
  return {
    path,
    status: "modified",
    additions: lineCount,
    deletions: 0,
    binary: false,
    patch: [
      `@@ -0,0 +1,${lineCount} @@`,
      ...Array.from({ length: lineCount }, (_, line) => `+export const value${line} = ${line};`),
    ].join("\n"),
  };
}

function mountDiff(files: readonly PatchFile[], path = "/s/x?view=diff") {
  const history = memoryHistory(path);
  return mount(
    <Router hook={history.hook} searchHook={history.searchHook}>
      <DiffView files={files} />
    </Router>,
  );
}

describe("DiffView — the raw-diff surface", () => {
  it("renders the header in Files-changed shape and a card + tree entry per file", () => {
    const { getByText, getByLabelText } = mountDiff([FILE_A, FILE_B]);
    expect(getByText("2 files changed")).toBeTruthy();
    expect(getByText("+3")).toBeTruthy();
    expect(getByText("0 / 2 viewed")).toBeTruthy();
    // Both file cards render (full path in the card header).
    expect(getByText("packages/core/src/a.ts")).toBeTruthy();
    expect(getByText("packages/ui/src/b.tsx")).toBeTruthy();
    // The tree lists both basenames under their folders.
    const tree = getByLabelText("Changed files");
    expect(tree.textContent).toContain("a.ts");
    expect(tree.textContent).toContain("b.tsx");
    // The added file carries its status badge.
    expect(getByText("added")).toBeTruthy();
  });

  it("renders the diff body with dual gutters and tokenized content", () => {
    const { getByText, container } = mountDiff([FILE_A]);
    expect(getByText("@@ -1,2 +1,2 @@")).toBeTruthy();
    // The changed lines render, tokenized into rtok spans.
    expect(container.querySelector(".rtok")).toBeTruthy();
    expect(container.textContent).toContain("const y = 3");
  });

  it("keeps file cards and diff rows bounded while the file tree remains complete", () => {
    const files = Array.from({ length: 12 }, (_, index) => largeFile(index));
    const { getByLabelText, container } = mountDiff(files);

    expect(getByLabelText("Changed files").querySelectorAll("button")).toHaveLength(12);
    expect(container.querySelectorAll("[data-line]").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("[data-line]").length).toBeLessThan(160);
    expect(container.querySelectorAll('[id^="diff-"]').length).toBeLessThan(6);
  });

  it("jumps the virtual window to an unmounted file from the complete file tree", () => {
    const files = Array.from({ length: 12 }, (_, index) => largeFile(index));
    const { getByLabelText, container } = mountDiff(files);
    const treeButtons = getByLabelText("Changed files").querySelectorAll("button");
    const last = treeButtons.item(treeButtons.length - 1);

    expect(container.querySelector(`[id="diff-${files[11]?.path}"]`)).toBeNull();
    fireEvent.click(last);
    expect(
      (container.querySelector("[data-diff-scroll]") as HTMLElement).scrollTop,
    ).toBeGreaterThan(100_000);
    expect(container.querySelector(`[id="diff-${files[11]?.path}"]`)).toBeTruthy();
  });

  it("recycles a large file onto the exact line identity", () => {
    const { container } = mountDiff([largeFile(0)]);
    const scroll = container.querySelector("[data-diff-scroll]") as HTMLElement;

    scroll.scrollTop = 7_200;
    fireEvent.scroll(scroll);

    expect(container.querySelector('[data-line="300"][data-side="RIGHT"]')).toBeTruthy();
    expect(container.querySelector('[data-line="1"][data-side="RIGHT"]')).toBeNull();
    expect(container.querySelectorAll("[data-line]").length).toBeLessThan(160);
  });

  it("the filter narrows both the cards and the tree", async () => {
    const { getByLabelText, queryByText, user } = mountDiff([FILE_A, FILE_B]);
    await user.type(getByLabelText("Filter changed files"), "b.tsx");
    // FILE_A drops out of the card list…
    expect(queryByText("packages/core/src/a.ts")).toBeNull();
    // …and the surviving file is still shown.
    expect(queryByText("packages/ui/src/b.tsx")).toBeTruthy();
  });

  it("an empty filter match shows the ported no-match message", async () => {
    const { getByLabelText, getByText, user } = mountDiff([FILE_A]);
    await user.type(getByLabelText("Filter changed files"), "zzz");
    expect(getByText(/No files match/)).toBeTruthy();
  });

  it("marking a file Viewed collapses its card, moves the count, and strikes the tree row", () => {
    const { getAllByRole, getByText, getByLabelText, getAllByLabelText, container } = mountDiff([
      FILE_A,
      FILE_B,
    ]);
    // Both cards start expanded (two collapse controls).
    expect(getAllByLabelText("Collapse file")).toHaveLength(2);
    // Check the first file's Viewed box.
    const viewedBoxes = getAllByRole("checkbox");
    fireEvent.click(viewedBoxes[0] as HTMLElement);
    // The count advances and the card is now collapsed (its control flips to "Expand").
    expect(getByText("1 / 2 viewed")).toBeTruthy();
    expect(getByLabelText("Expand file")).toBeTruthy();
    // The tree row for the viewed file is struck through.
    const struck = container.querySelector(".line-through");
    expect(struck?.textContent).toBe("a.ts");
  });

  it("un-viewing reveals the card even after a chevron click while viewed (no latch)", () => {
    const { getByLabelText, getByRole } = mountDiff([FILE_A]);
    // Open to start.
    expect(getByLabelText("Collapse file")).toBeTruthy();
    // View it → collapses.
    const viewedBox = getByRole("checkbox");
    fireEvent.click(viewedBox);
    expect(getByLabelText("Expand file")).toBeTruthy();
    // Click the chevron WHILE viewed — this used to latch collapsed=true.
    fireEvent.click(getByLabelText("Expand file"));
    expect(getByLabelText("Expand file")).toBeTruthy();
    // Un-view → the card reveals with no stray extra click.
    fireEvent.click(viewedBox);
    expect(getByLabelText("Collapse file")).toBeTruthy();
  });

  it("copy-path writes the path, shows its confirmation, and clears it after 1.5s", async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
      const { getAllByLabelText } = mountDiff([FILE_A]);
      const copyButton = getAllByLabelText("Copy file path")[0] as HTMLElement;
      await act(async () => {
        fireEvent.click(copyButton);
      });
      expect(writeText).toHaveBeenCalledWith("packages/core/src/a.ts");
      // The confirmation swaps the copy glyph for the check glyph…
      expect(copyButton.querySelector("svg")?.getAttribute("class")).toContain("lucide-check");
      // …and reverts after the 1.5s timeout.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(copyButton.querySelector("svg")?.getAttribute("class")).toContain("lucide-copy");
    } finally {
      vi.useRealTimers();
    }
  });

  it("copy-path no-ops silently when the clipboard API is absent", () => {
    const original = navigator.clipboard;
    // Simulate an insecure context where navigator.clipboard is undefined.
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    try {
      const { getAllByLabelText } = mountDiff([FILE_A]);
      const copyButton = getAllByLabelText("Copy file path")[0] as HTMLElement;
      // No throw, and the glyph stays the copy icon.
      expect(() => fireEvent.click(copyButton)).not.toThrow();
      expect(copyButton.querySelector("svg")?.getAttribute("class")).toContain("lucide-copy");
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: original });
      cleanup();
    }
  });
});
