// @vitest-environment happy-dom
//
// `?view=map` has a renderer (dead-destination audit). The session top-bar has advertised a
// **Map** toggle since C03 §4.3 and the docs say it "opens the project's context map", but
// `ReviewWorkspace` branched on `handoff`, `diff` and `rounds` only — so the toggle lit up,
// the URL gained `?view=map`, and the board the reviewer was already reading stayed on
// screen with no cue that anything had failed.
//
// This drives the WHOLE app (`RennetRouterApp` over a MemoryBridge), not the route in
// isolation, because both halves of the defect are control-flow claims: that clicking the
// real toggle changes the URL, and that the URL change changes the surface. The load-bearing
// assertion is a DIFFERENCE — `?view=map` must not render what the default renders — since a
// fall-through is exactly what "renders the board again" looks like.
import type { Project, Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { mount, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { sessionHandlers } from "../test/fixtures/sessions";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";

const PROJECT: Project = {
  id: "p1",
  name: "atlas",
  path: "/repos/atlas",
  kind: "repo",
  repoCount: 1,
  branchCount: 1,
  primaryBranch: "main",
  openPath: "/repos/atlas",
  addedAt: "2026-08-28T00:00:00.000Z",
  source: "local",
};

/** A pinned-snapshot review, so the route's working-tree freshness ask stays off the path. */
const REVIEW = {
  id: "rv-1",
  repositoryRoot: "/repos/atlas",
  status: "current",
  activePatchsetId: "ps-1",
  patchsets: [{ id: "ps-1", source: "local-branch" }],
} as unknown as Review;

/** Mount the real app at `path`, with `s1` owned by project `p1` and holding `rv-1`. */
function mountApp(path: string, handlers: MemoryBridgeHandlers = {}) {
  const asked: string[] = [];
  const bridge = new MemoryBridge({
    ...frontDoorHandlers([PROJECT]),
    ...sessionHandlers([{ id: "s1", projectId: "p1", title: "Alpha" }]),
    "session.list": () => ({
      sessions: [
        {
          id: "s1",
          projectId: "p1",
          title: "Alpha",
          target: "your-branch" as const,
          reviewId: "rv-1",
          createdAt: 0,
        },
      ],
    }),
    "review.load": () => ({ review: REVIEW, repositoryPresent: true }),
    "project.contextMap": ({ projectId }) => {
      asked.push(projectId);
      // `absent` is a real, typed answer this surface renders in full — enough to prove
      // WHICH surface mounted and WHICH project it asked for, with no map fixture to keep
      // in sync. The map's own content is `components/context-map-view`'s to test.
      return { status: "absent" as const, reason: "No snapshot for this project yet." };
    },
    ...handlers,
  });
  const history = memoryHistory(path);
  const utils = mount(<RennetRouterApp bridge={bridge} history={history} />);
  return { ...utils, history, asked };
}

/** The board branch's own header. Present ⇒ the route fell through to the board. */
const onBoard = () => document.body.textContent?.includes("REVIEW · atlas") === true;
/** The context-map surface's own title. */
const onMap = () => document.body.textContent?.includes("Context Map") === true;

describe("?view=map renders the session project's context map (dead-destination audit)", () => {
  it("shows the context map for the session's OWN project, not the board again", async () => {
    const { asked } = mountApp("/s/s1?view=map");

    await waitFor(() => expect(onMap()).toBe(true));
    // The difference is the whole point: a missing branch renders the board, and a board
    // that is still on screen under `?view=map` is the defect this test exists to catch.
    expect(onBoard()).toBe(false);
    // It asked for the project the SESSION ROW names — never one derived from the review's
    // repository root, which a workspace project shares across repositories.
    expect(asked).toEqual(["p1"]);
  });

  it("positive control: the same mount WITHOUT ?view=map shows the board and no map", async () => {
    mountApp("/s/s1");

    await waitFor(() => expect(onBoard()).toBe(true));
    expect(onMap()).toBe(false);
  });

  it("clicking the top bar's Map toggle actually arrives — URL and surface both move", async () => {
    const { findByText, history } = mountApp("/s/s1");
    await waitFor(() => expect(onBoard()).toBe(true));

    const toggle = await findByText("Map");
    await waitFor(() => expect(toggle.closest("button")).toBeTruthy());
    (toggle.closest("button") as HTMLButtonElement).click();

    // Position, not membership: the toggle's navigation is the latest one.
    await waitFor(() => expect(history.history.at(-1)).toBe("/s/s1?view=map"));
    await waitFor(() => expect(onMap()).toBe(true));
    expect(onBoard()).toBe(false);
  });

  it("states why there is no map for a slug no session row owns — never the board again", async () => {
    // `/s/rv-1` is the legacy review-id link: it resolves a review, but no session row names
    // it, so nothing can say which project it belongs to. The failure mode this whole file
    // exists for is "renders the board and looks like nothing happened", so the unresolvable
    // case has to be visibly distinct too.
    const { findByTestId, asked } = mountApp("/s/rv-1?view=map");

    expect(await findByTestId("map-unavailable")).toBeTruthy();
    expect(onBoard()).toBe(false);
    // It did NOT fall back to some other project's map — with no project named, none is read.
    expect(asked).toEqual([]);
  });
});
