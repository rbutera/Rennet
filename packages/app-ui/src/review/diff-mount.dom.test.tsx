// @vitest-environment happy-dom
import type { PatchFile, Review } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { ReviewWorkspace } from "../app/review-workspace-route";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { mount } from "../test/dom";

beforeEach(() => useRennetStore.getState().reviewActions.resetReview());

const FILE_A: PatchFile = {
  path: "packages/core/src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  binary: false,
  patch: ["@@ -1,1 +1,1 @@", "-const y = 2", "+const y = 3"].join("\n"),
};
const FILE_B: PatchFile = {
  path: "packages/ui/src/b.tsx",
  status: "added",
  additions: 1,
  deletions: 0,
  binary: false,
  patch: ["@@ -0,0 +1,1 @@", "+export const b = 1"].join("\n"),
};

// ReviewWorkspace / DiffViewContainer read only patchsets + activePatchsetId + the
// repositoryRoot the placeholder shows; the rest of Review is irrelevant here.
function review(files: PatchFile[]): Review {
  return {
    id: "r1",
    repositoryRoot: "/repos/atlas",
    patchsets: [{ id: "ps1", files }],
    activePatchsetId: "ps1",
  } as unknown as Review;
}

function mountWorkspace(path: string, files: PatchFile[]) {
  const history = memoryHistory(path);
  return mount(
    <Router hook={history.hook} searchHook={history.searchHook}>
      <ReviewWorkspace review={review(files)} />
    </Router>,
  );
}

describe("ReviewWorkspace ?view mount (C6 task 4.3)", () => {
  it("renders the diff surface at ?view=diff", () => {
    const { getByText } = mountWorkspace("/s/x?view=diff", [FILE_A, FILE_B]);
    expect(getByText("2 files changed")).toBeTruthy();
    expect(getByText("packages/core/src/a.ts")).toBeTruthy();
  });

  it("keeps the honest placeholder on the default (board) view", () => {
    const { getByText, queryByText } = mountWorkspace("/s/x", [FILE_A]);
    expect(getByText(/being rebuilt/i)).toBeTruthy();
    expect(queryByText("1 files changed")).toBeNull();
  });

  it("keeps the placeholder for a non-diff explicit view (map)", () => {
    const { getByText } = mountWorkspace("/s/x?view=map", [FILE_A]);
    expect(getByText(/being rebuilt/i)).toBeTruthy();
  });

  it("an empty active patchset shows the honest one-line state, never a blank frame", () => {
    const { getByText } = mountWorkspace("/s/x?view=diff", []);
    expect(getByText("This patchset has no changed files to show.")).toBeTruthy();
  });
});

describe("diff deep-link ?file= (C6 task 4.1)", () => {
  let scrollSpy: ReturnType<typeof vi.fn>;
  let original: typeof Element.prototype.scrollIntoView;

  beforeEach(() => {
    original = Element.prototype.scrollIntoView;
    // vi.fn records each call's `this` in `mock.contexts`, so the test can prove the scroll
    // fired on the named card element itself, not merely on some element on the page.
    scrollSpy = vi.fn();
    Element.prototype.scrollIntoView =
      scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it("a cold ?view=diff&file=<path> renders the surface and scrolls the named card", () => {
    const target = FILE_B.path;
    const { container } = mountWorkspace(`/s/x?view=diff&file=${encodeURIComponent(target)}`, [
      FILE_A,
      FILE_B,
    ]);
    // The named card is in the DOM…
    const section = container.querySelector(`[id="diff-${target}"]`);
    expect(section).toBeTruthy();
    // …and the mount-only effect scrolled THAT section into view (not merely some element).
    expect(scrollSpy).toHaveBeenCalled();
    expect(scrollSpy.mock.contexts[0]).toBe(section);
  });

  it("does not scroll when no ?file is present", () => {
    mountWorkspace("/s/x?view=diff", [FILE_A, FILE_B]);
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});
