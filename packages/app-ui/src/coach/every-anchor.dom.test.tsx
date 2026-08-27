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
// Marks 1-3 (start-review, new-chat, smart-list) resolve on their REAL surfaces here
// too: the New Chat view hosts new-chat + smart-list, and the indexing view's completion
// CTA hosts start-review through a `useMergedRefs` merge (a bad merge would silently drop
// the registration). anchors.dom.test.tsx separately drives their election/chain behaviour
// with synthetic anchors. Surfaces are route-exclusive — start-review (indexing) and
// dispatch (rounds) never share a screen — so the resolution proof is per-surface by
// nature, not one impossible all-nine tree.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessedRepoSummary, Project, ProjectDetail, Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BoardSourceProvider } from "../board/board-data";
import { LensBoardView } from "../board/board-view";
import { BridgeProvider } from "../data";
import { ExitFab } from "../handoff/fab";
import { PostReviewLane } from "../handoff/post-review-lane";
import { RoundsLanes } from "../handoff/rounds-lanes";
import { IndexingView } from "../project/indexing/indexing-view";
import { NewChatView } from "../project/new-chat-view";
import { memoryHistory } from "../routes/history";
import { projectIndexingPath } from "../routes/url";
import { useRennetStore } from "../store";
import { act, cleanup, mount, waitFor } from "../test/dom";
import { fixtureBoardSource } from "../test/fixtures/boards";
import { SettingsStore, settingsBridge } from "../test/fixtures/settings";
import { MemoryBridge } from "../test/memory-bridge";
import { MARKS, type MarkId } from "./marks";
import { CoachDataProvider } from "./provider";
import { useCoachElement } from "./registry";

// ── Proof 1: no orphan ───────────────────────────────────────────────────────
// The app-ui source root (this file lives at src/coach/). Scan every non-test
// surface file for literal `useCoachAnchor("<id>")` sites; the coach dir itself
// (the hook definition + these tests) is excluded so only real anchors count.
const SRC = join(import.meta.dirname, "..");

// COUNT per id, not a Set: a Set collapses two call sites for one id before the
// "exactly one" assertion, so the very duplicate-anchor regression this suite exists
// to catch (the spike declared `data-tour="new-chat"` twice) would slip through. The
// count keeps each site distinct so a duplicated anchor fails loudly.
function collectAnchorCounts(dir: string, counts: Map<string, number>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectAnchorCounts(path, counts);
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    if (entry.name.includes(".test.")) continue;
    if (path.includes(`${join("src", "coach")}`)) continue;
    for (const match of readFileSync(path, "utf8").matchAll(
      /useCoachAnchor\(\s*["']([^"']+)["']/g,
    )) {
      if (match[1]) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
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

// ── Marks 1-3: their real project surfaces ───────────────────────────────────
/** A minimal project + empty detail — enough for New Chat and indexing to render their chrome. */
const p1: Project = {
  id: "p1",
  name: "rennet",
  path: "/code/rennet",
  kind: "repo",
  repoCount: 1,
  branchCount: 1,
  primaryBranch: "main",
  openPath: "/code/rennet",
  addedAt: "2026-08-27T00:00:00.000Z",
  source: "local",
};
const emptyDetail: ProjectDetail = {
  viewer: { login: "rai" },
  truncated: false,
  locals: [],
  prs: [],
} as unknown as ProjectDetail;

/** A promise with exposed resolve, to hold `project.process` in flight then finish it. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Merge the settings handlers (for CoachDataProvider) with a surface's own commands. */
function bridgeWith(handlers: ConstructorParameters<typeof MemoryBridge>[0]): MemoryBridge {
  return new MemoryBridge({ ...new SettingsStore().handlers(), ...handlers });
}

describe("every coach anchor resolves (C13 Cluster 5)", () => {
  it("every mark has EXACTLY ONE real anchor site and no site anchors an unknown mark (no orphan, no dupe)", () => {
    const counts = new Map<string, number>();
    collectAnchorCounts(SRC, counts);
    // Set equality both ways: no mark is missing an anchor, no anchor points at a
    // mark the model does not carry. Either failure is an S8-class orphan.
    expect([...counts.keys()].sort()).toEqual([...MARKS.map((m) => m.id)].sort());
    // And exactly one call site per id — two live anchors for one mark is the S8
    // duplicate the rewrite makes impossible; occurrence-counting is what proves it.
    expect([...counts.entries()].filter(([, n]) => n > 1)).toEqual([]);
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

  it("New Chat view — new-chat and smart-list resolve on the real chrome", async () => {
    const history = memoryHistory();
    const bridge = bridgeWith({
      "projects.list": () => ({ projects: [p1] }),
      "project.detail": () => emptyDetail,
    });
    const { getByTestId } = mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <CoachDataProvider>
            <NewChatView projectId="p1" />
            <AnchorReadout id="new-chat" />
            <AnchorReadout id="smart-list" />
          </CoachDataProvider>
        </Router>
      </BridgeProvider>,
    );
    await waitFor(() => expect(getByTestId("el-new-chat").textContent).not.toBe("none"));
    expect(getByTestId("el-smart-list").textContent).not.toBe("none");
    cleanup();
  });

  it("indexing view — start-review resolves through the real useMergedRefs CTA", async () => {
    const history = memoryHistory(projectIndexingPath("p1"));
    const process = deferred<{ repos: ProcessedRepoSummary[] }>();
    let commandId = "";
    const bridge = bridgeWith({
      "projects.list": () => ({ projects: [p1] }),
      "project.process": (input) => {
        commandId = input.commandId;
        return process.promise;
      },
    });
    const { getByTestId } = mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <CoachDataProvider>
            <IndexingView projectId="p1" />
            <AnchorReadout id="start-review" />
          </CoachDataProvider>
        </Router>
      </BridgeProvider>,
    );
    // The Start-a-Review CTA (and its start-review anchor) mounts only once the run
    // resolves — wait for the view to launch the process, then resolve it so the
    // merged-ref site actually registers.
    await waitFor(() => expect(commandId).not.toBe(""));
    act(() => process.resolve({ repos: [] }));
    await waitFor(() => expect(getByTestId("el-start-review").textContent).not.toBe("none"));
    cleanup();
  });
});
