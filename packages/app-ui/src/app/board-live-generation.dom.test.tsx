// @vitest-environment happy-dom
//
// The LIVE generation the review workspace reads its boards at.
//
// The route used to pass the literal `"live"` to `board.read`. No board is ever stamped
// `"live"` — the daemon files every board under `gen:<patchsetId>` and the read matches the
// string EXACTLY — so the default path answered `null` for every review that had boards, and
// the reviewer's drafted board was unreachable. The board surface said "No board for this
// generation yet", which read as "nothing has been drafted" and was in fact "I asked for a
// generation that does not exist".
//
// So this drives the REAL route over a bridge that behaves like the daemon does: it serves
// boards for `gen:ps-1` and honestly nothing for any other generation. The wire string is
// written out literally rather than built from `generationIdForPatchset`, because the point
// is the CONTRACT between the two ends — a test that derives the expectation from the same
// helper the route calls would still pass if the helper and the daemon disagreed.
import type { LensBoard, LensKind, Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { Route, Router, Switch } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { ROUTES } from "../routes/url";
import { mount, waitFor } from "../test/dom";
import { FIXTURE_BOARDS } from "../test/fixtures/boards";
import { MemoryBridge } from "../test/memory-bridge";
import { ReviewWorkspace } from "./review-workspace-route";

/** The generation id the daemon really stamps for a review whose active patchset is `ps-1`. */
const LIVE = "gen:ps-1";

const review = {
  id: "rv-1",
  repositoryRoot: "/home/dev/widget",
  status: "current",
  activePatchsetId: "ps-1",
  patchsets: [{ id: "ps-1", source: "local" }],
} as unknown as Review;

/** The five-lens fixture set, re-stamped onto the live generation — `board-data.ts` rejects a
 *  board whose own `generation` disagrees with the one requested, so the stamp is load-bearing. */
const boardsAtLive: Partial<Record<LensKind, LensBoard>> = Object.fromEntries(
  Object.entries(FIXTURE_BOARDS.gen1 ?? {}).map(([lens, board]) => [
    lens,
    { ...board, generation: LIVE },
  ]),
);

function mountWorkspace() {
  const asked: string[] = [];
  const bridge = new MemoryBridge({
    "review.checkFreshness": () => ({ review }),
    // The daemon's own behaviour: an exact generation match, and an honest `null` otherwise.
    "board.read": (input) => {
      const { generation, lens } = input as { generation: string; lens: LensKind };
      asked.push(generation);
      return { board: generation === LIVE ? (boardsAtLive[lens] ?? null) : null };
    },
  });
  const history = memoryHistory("/s/rv-1");
  return {
    asked,
    r: mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <Switch>
            <Route path={ROUTES.session}>{() => <ReviewWorkspace review={review} />}</Route>
          </Switch>
        </Router>
      </BridgeProvider>,
    ),
  };
}

describe("the review workspace reads its boards at the review's live generation", () => {
  it("renders the drafted board instead of an honest-empty it caused itself", async () => {
    const { r } = mountWorkspace();

    // The board the daemon drafted is on screen. Before the fix this was `board-empty`,
    // with the boards sitting on disk under a generation nobody asked for.
    const article = await waitFor(() => {
      const found = r.container.querySelector("article[data-lens]");
      if (!found) throw new Error("no board rendered");
      return found;
    });
    expect(article.getAttribute("data-generation")).toBe(LIVE);
    expect(r.container.querySelector("[data-kind=board-empty]")).toBeNull();
    expect(r.container.querySelector("[data-kind=board-error]")).toBeNull();
  });

  it("never asks for a generation the daemon does not stamp", async () => {
    const { asked, r } = mountWorkspace();
    await waitFor(() => {
      if (!r.container.querySelector("article[data-lens]")) throw new Error("no board rendered");
    });
    expect(asked.length).toBeGreaterThan(0);
    // The placeholder that caused this, named so a reintroduction reddens here.
    expect(asked).not.toContain("live");
    expect(new Set(asked)).toEqual(new Set([LIVE]));
  });
});
