// @vitest-environment happy-dom
import type { PatchFile, Review } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { ReviewWorkspace } from "../app/review-workspace-route";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { mount } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";

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
  // This review drafted no boards, so `board.read` answers the honest missing board —
  // the state the default view is expected to render.
  return mount(
    <BridgeProvider bridge={new MemoryBridge({ "board.read": () => ({ board: null }) })}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <ReviewWorkspace review={review(files)} />
      </Router>
    </BridgeProvider>,
  );
}

describe("ReviewWorkspace ?view mount (C6 task 4.3)", () => {
  it("renders the diff surface at ?view=diff", () => {
    const { getByText } = mountWorkspace("/s/x?view=diff", [FILE_A, FILE_B]);
    expect(getByText("2 files changed")).toBeTruthy();
    expect(getByText("packages/core/src/a.ts")).toBeTruthy();
  });

  it("mounts the board document on the default view, not the diff", async () => {
    const { findByText, queryByText } = mountWorkspace("/s/x", [FILE_A]);
    // This review drafted no boards, so the board's honest empty state shows.
    expect(await findByText(/no board for this generation yet/i)).toBeTruthy();
    expect(queryByText("1 files changed")).toBeNull();
  });

  // This test used to be titled "a non-diff explicit view (map) falls back to the board
  // document" and asserted exactly that — it PINNED the dead `?view=map` destination as
  // intended behaviour. `?view=map` has a branch now, and the thing worth asserting here is
  // that an explicit view never silently renders the default: this bridge answers no
  // `session.list`, so no project is named and the map says so instead of showing the board.
  it("an explicit ?view=map never renders the board document instead", async () => {
    const { findByTestId, queryByText } = mountWorkspace("/s/x?view=map", [FILE_A]);
    expect(await findByTestId("map-unavailable")).toBeTruthy();
    expect(queryByText(/no board for this generation yet/i)).toBeNull();
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
