// @vitest-environment happy-dom
import type { PatchFile, Review } from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { ReviewWorkspace } from "../app/review-workspace-route";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, mount } from "../test/dom";
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
  const result = mount(
    <BridgeProvider bridge={new MemoryBridge({ "board.read": () => ({ board: null }) })}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <ReviewWorkspace review={review(files)} />
      </Router>
    </BridgeProvider>,
  );
  return { ...result, history };
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

  // The context map died with the knowledge layer, so `?view=map` is an unknown
  // view again and parses back to the board default — a stale deep link lands on
  // the board rather than a dead screen.
  it("a stale ?view=map deep link falls back to the board document", async () => {
    const { queryByTestId } = mountWorkspace("/s/x?view=map", [FILE_A]);
    expect(queryByTestId("map-unavailable")).toBeNull();
  });

  it("an empty active patchset shows the honest one-line state, never a blank frame", () => {
    const { getByText } = mountWorkspace("/s/x?view=diff", []);
    expect(getByText("This patchset has no changed files to show.")).toBeTruthy();
  });
});

describe("diff deep-link ?file= (C6 task 4.1)", () => {
  it("a cold ?view=diff&file=<path> renders the surface and positions the virtual window", () => {
    const target = FILE_B.path;
    const { container } = mountWorkspace(`/s/x?view=diff&file=${encodeURIComponent(target)}`, [
      FILE_A,
      FILE_B,
    ]);
    expect(container.querySelector(`[id="diff-${target}"]`)).toBeTruthy();
    expect(
      (container.querySelector("[data-diff-scroll]") as HTMLElement).scrollTop,
    ).toBeGreaterThan(0);
  });

  it("does not scroll when no ?file is present", () => {
    const { container } = mountWorkspace("/s/x?view=diff", [FILE_A, FILE_B]);
    expect((container.querySelector("[data-diff-scroll]") as HTMLElement).scrollTop).toBe(0);
  });

  it("positions again when an already-mounted Diff receives a different ?file", () => {
    const { container, history } = mountWorkspace(
      `/s/x?view=diff&file=${encodeURIComponent(FILE_A.path)}`,
      [FILE_A, FILE_B],
    );
    const scroll = container.querySelector("[data-diff-scroll]") as HTMLElement;
    expect(scroll.scrollTop).toBeGreaterThan(0);
    const firstTop = scroll.scrollTop;
    act(() =>
      history.navigate(`/s/x?view=diff&file=${encodeURIComponent(FILE_B.path)}`, {
        replace: true,
      }),
    );

    expect(scroll.scrollTop).toBeGreaterThan(firstTop);
    expect(container.querySelector(`[id="diff-${FILE_B.path}"]`)).toBeTruthy();
  });
});
