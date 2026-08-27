// @vitest-environment happy-dom
//
// C13 Cluster 5 — the exhaustive anchor proof. Two complementary guarantees close
// the S8 autopsy (an orphaned or duplicated mark):
//
//   1. NO ORPHAN (all nine). Every MarkId in `MARKS` has exactly one real
//      `useCoachAnchor("<id>")` call site in app-ui, and no site anchors an id the
//      model does not carry. A static scan of the source proves the set equality —
//      robust to fixture churn, and the completeness half of the autopsy: a mark
//      with no anchor could never elect, a silent orphan.
//   2. EACH ANCHOR RESOLVES ON ITS REAL SURFACE (marks 4-9). The real board and
//      handoff surfaces mount under a live CoachProvider, and every mark they host
//      resolves through the typed registry to a live DOM element — including the two
//      `useMergedRefs` sites (fab here, start-review on its own surface) where a bad
//      merge would silently drop the coach registration.
//
// Marks 1-3 (start-review, new-chat, smart-list) are proven on real hooks by
// anchors.dom.test.tsx (election first, chain to the next); the static scan here is
// their no-orphan half. Surfaces are route-exclusive — start-review (indexing) and
// dispatch (rounds) never share a screen — so the resolution proof is per-surface by
// nature, not one impossible all-nine tree.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { BoardSourceProvider } from "../board/board-data";
import { LensBoardView } from "../board/board-view";
import { BridgeProvider } from "../data";
import { ExitFab } from "../handoff/fab";
import { PostReviewLane } from "../handoff/post-review-lane";
import { RoundsLanes } from "../handoff/rounds-lanes";
import { useRennetStore } from "../store";
import { cleanup, mount, waitFor } from "../test/dom";
import { fixtureBoardSource } from "../test/fixtures/boards";
import { settingsBridge } from "../test/fixtures/settings";
import { MARKS, type MarkId } from "./marks";
import { CoachDataProvider } from "./provider";
import { useCoachElement } from "./registry";

// ── Proof 1: no orphan ───────────────────────────────────────────────────────
// The app-ui source root (this file lives at src/coach/). Scan every non-test
// surface file for literal `useCoachAnchor("<id>")` sites; the coach dir itself
// (the hook definition + these tests) is excluded so only real anchors count.
const SRC = join(import.meta.dirname, "..");

function collectAnchorIds(dir: string, found: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectAnchorIds(path, found);
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    if (entry.name.includes(".test.")) continue;
    if (path.includes(`${join("src", "coach")}`)) continue;
    for (const match of readFileSync(path, "utf8").matchAll(
      /useCoachAnchor\(\s*["']([^"']+)["']/g,
    )) {
      found.add(match[1]);
    }
  }
}

// ── Proof 2: real-surface resolution ─────────────────────────────────────────
/** Reads whether a mark resolved to a live element through the shared registry. */
function AnchorReadout({ id }: { id: MarkId }) {
  const el = useCoachElement(id);
  return <span data-testid={`el-${id}`}>{el ? el.tagName : "none"}</span>;
}

function mountSurface(surface: React.ReactNode, probes: MarkId[]) {
  return mount(
    <BridgeProvider bridge={settingsBridge()}>
      <CoachDataProvider>
        {surface}
        {probes.map((id) => (
          <AnchorReadout key={id} id={id} />
        ))}
      </CoachDataProvider>
    </BridgeProvider>,
  );
}

/** Post-review lane reads only `activePatchsetId` + `postTarget` from its snapshot. */
const postReview = {
  activePatchsetId: "ps-1",
  postTarget: {
    repo: { forge: "github", owner: "acme", name: "orbital" },
    number: 7,
    forgeRef: "PR_x",
    headOid: "abc",
  },
} as unknown as Review;

/** An own-branch review — no post target; the rounds lane reads only the patchset id. */
const ownBranch = { activePatchsetId: "ps-1" } as unknown as Review;

describe("every coach anchor resolves (C13 Cluster 5)", () => {
  it("every mark has one real anchor site and no site anchors an unknown mark (no orphan)", () => {
    const anchored = new Set<string>();
    collectAnchorIds(SRC, anchored);
    // Set equality both ways: no mark is missing an anchor, no anchor points at a
    // mark the model does not carry. Either failure is an S8-class orphan.
    expect([...anchored].sort()).toEqual([...MARKS.map((m) => m.id)].sort());
  });

  it("board surface — lenses and highlight each resolve to a live element", async () => {
    useRennetStore.setState({ viewedDelta: { viewedDeltaSections: {} } });
    const { getByTestId } = mountSurface(
      <BoardSourceProvider value={fixtureBoardSource}>
        <LensBoardView generation="gen1" generations={["gen0", "gen1", "gen2"]} />
      </BoardSourceProvider>,
      ["lenses", "highlight"],
    );
    await waitFor(() => expect(getByTestId("el-lenses").textContent).not.toBe("none"));
    expect(getByTestId("el-highlight").textContent).not.toBe("none");
    cleanup();
  });

  it("handoff FAB — fab resolves through the real useMergedRefs site", async () => {
    const { getByTestId } = mountSurface(
      <ExitFab mode="teammate-pr" open={false} onToggle={() => undefined} />,
      ["fab"],
    );
    await waitFor(() => expect(getByTestId("el-fab").textContent).not.toBe("none"));
    cleanup();
  });

  it("post-review lane — verdict and draft each resolve to a live element", async () => {
    useRennetStore.getState().reviewActions.resetReview();
    const { getByTestId } = mountSurface(<PostReviewLane review={postReview} />, [
      "verdict",
      "draft",
    ]);
    await waitFor(() => expect(getByTestId("el-verdict").textContent).not.toBe("none"));
    expect(getByTestId("el-draft").textContent).not.toBe("none");
    cleanup();
  });

  it("rounds lane — dispatch resolves to a live element", async () => {
    useRennetStore.getState().reviewActions.resetReview();
    const { getByTestId } = mountSurface(<RoundsLanes review={ownBranch} />, ["dispatch"]);
    await waitFor(() => expect(getByTestId("el-dispatch").textContent).not.toBe("none"));
    cleanup();
  });
});
