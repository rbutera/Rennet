// @vitest-environment happy-dom

import type {
  DraftElement,
  LensDraftEvent,
  LensDraftSnapshot,
  LensLane,
  Review,
  SidebarSession,
} from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { mount, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import { foldLensDraft } from "./live-draft";

// ─────────────────────────────────────────────────────────────────────────────
// THE ELEMENT STREAM REACHES THE SCREEN (lens-board-tools 5.3, D11).
//
// `onLensDraft` shipped in wave 4 with no caller — the signature defect of this whole
// change is production code nothing calls, so the test that matters here is the END TO
// END one: a frame emitted on the bridge, folded through `board.draft`'s cache entry,
// rendered as a board element the reviewer can read. The pure fold is tested beside it
// because that is where the three ways to be wrong live, but the pure test alone would
// have passed over an unwired stream.
//
// POSITIVE CONTROLS RUN, 2026-09-05 — see the PR's control ledger.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = "gen:ps-1";
const REVIEW = {
  id: "rev-1",
  repositoryRoot: "/home/dev/widget",
  status: "current",
  activePatchsetId: "ps-1",
  patchsets: [{ id: "ps-1", source: "local", files: [] }],
} as unknown as Review;

const LANES: LensLane[] = [
  {
    id: "sequence",
    label: "Sequence",
    status: "running",
    thread: { environmentId: "env-1", threadId: "seat-sequence" },
  },
  { id: "design", label: "Design", status: "running" },
  { id: "decisions", label: "Decisions", status: "running" },
  { id: "flagged", label: "Flagged", status: "running" },
  { id: "noise", label: "Noise", status: "queued" },
] as LensLane[];

const section = (id: string, title: string, children: string[]): DraftElement =>
  ({
    id,
    kind: "section",
    data: { title, gist: `${title} — folded`, children },
  }) as unknown as DraftElement;

const step = (id: string, title: string): DraftElement =>
  ({ id, kind: "order_step", data: { title } }) as unknown as DraftElement;

const frame = (revision: number, update: LensDraftEvent["update"]): LensDraftEvent => ({
  generation: LIVE,
  lens: "sequence",
  revision,
  update,
});

function harness() {
  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    "session.list": () => ({
      sessions: [
        {
          id: "sess-live",
          projectId: "proj-1",
          title: "feat/live",
          target: "your-branch",
          createdAt: 0,
          reviewId: REVIEW.id,
          preparation: { status: "drafting", reviewId: REVIEW.id, lanes: LANES },
        } as SidebarSession,
      ],
    }),
    "review.load": () => ({ review: REVIEW, repositoryPresent: true }),
    "review.checkFreshness": () => ({ review: REVIEW }),
    // The DURABLE read answers nothing: the board on screen can only have come off the
    // stream. That is what makes this an end-to-end proof rather than a coincidence.
    "board.read": () => ({ board: null }),
    "board.draft": () => ({ draft: null }),
    "chat.t3Session": () => ({
      origin: "http://127.0.0.1:1",
      wsUrl: "ws://127.0.0.1:1",
      accessToken: "t",
      environmentId: "env-1",
      threadId: "thread-session",
    }),
  } as never);
  return { bridge };
}

beforeEach(() => {
  useRennetStore.setState((s) => ({ ui: { ...s.ui, chatOpen: false, seatTranscript: null } }));
});

describe("a board written by the stream reaches the screen", () => {
  it("renders an element the daemon published, with no durable board behind it", async () => {
    const { bridge } = harness();
    mount(
      <RennetRouterApp bridge={bridge} history={memoryHistory("/s/sess-live?lens=sequence")} />,
    );

    // The board is empty and drafting, and says so — the placeholder, not a board.
    await waitFor(() => expect(document.querySelector('[data-kind="board-ghost"]')).toBeTruthy());
    expect(document.querySelector("article[data-lens=sequence]")).toBeNull();

    // The lane opens its board, then one accepted call lands a section and a step.
    bridge.emitLensDraft(REVIEW.id, frame(1, { kind: "opened", elements: [] }));
    bridge.emitLensDraft(
      REVIEW.id,
      frame(2, {
        kind: "elements",
        changed: [
          { index: 0, element: section("walk", "The Walk, Ground-Up", ["os-1"]) },
          { index: 1, element: step("os-1", "The shape of an observation") },
        ],
        removed: [],
        document: {
          title: "Observe the GitHub token refresh",
          introMarkdown: "",
          measure: "reading",
        },
      }),
    );

    // The board is on screen, written by the stream and by nothing else.
    await waitFor(() => expect(document.querySelector("article[data-lens=sequence]")).toBeTruthy());
    expect(document.body.textContent).toContain("Observe the GitHub token refresh");
    expect(document.body.textContent).toContain("The Walk, Ground-Up");
    // The fold line the SHARED projection derived — one step, counted as the daemon
    // counts it, which is the point of `projectBoardSections` living in the protocol.
    expect(document.querySelector('[data-kind="board-section"]')?.textContent).toContain("1 step");
    // It is still drafting, so the three signals are still up and the delta marks are not.
    expect(document.querySelector('[data-kind="board-in-progress"]')).toBeTruthy();
    expect(document.querySelector('[data-kind="board-ghost"]')).toBeTruthy();
    // …and the widget counts what is on screen, not the durable read's nothing.
    expect(document.querySelector('[data-testid="seat-written"]')?.textContent).toBe(
      "2 elements written",
    );
  });

  it("keeps rendering the durable board once the lane closes", async () => {
    // The switch between the two sources. A `closed` frame hands the board back to
    // `board.read`, whose copy is the one with the patchset stamps and the delta marks —
    // so a stream that went on winning after settle would show a board with no marks on it.
    const { bridge } = harness();
    mount(
      <RennetRouterApp bridge={bridge} history={memoryHistory("/s/sess-live?lens=sequence")} />,
    );
    await waitFor(() => expect(document.querySelector('[data-kind="board-ghost"]')).toBeTruthy());

    bridge.emitLensDraft(REVIEW.id, frame(1, { kind: "opened", elements: [] }));
    bridge.emitLensDraft(
      REVIEW.id,
      frame(2, {
        kind: "elements",
        changed: [{ index: 0, element: section("walk", "The Walk, Ground-Up", []) }],
        removed: [],
      }),
    );
    await waitFor(() => expect(document.querySelector("article[data-lens=sequence]")).toBeTruthy());

    bridge.emitLensDraft(REVIEW.id, frame(3, { kind: "closed", state: "settled" }));

    // `board.read` still answers nothing in this fixture, so the board falls back to the
    // honest empty account rather than going on showing the live copy under a settled lane.
    await waitFor(() => expect(document.querySelector("article[data-lens=sequence]")).toBeNull());
  });
});

describe("the fold, and the three ways it can be wrong", () => {
  const opened: LensDraftSnapshot = {
    generation: LIVE,
    lens: "sequence",
    revision: 1,
    state: "drafting",
    closed: false,
    elements: [section("walk", "The Walk", [])],
  };
  const expected = { generation: LIVE, lens: "sequence" } as const;

  it("drops a frame from another generation rather than merging it", () => {
    const other = { ...frame(9, { kind: "closed", state: "settled" }), generation: "gen:ps-2" };
    expect(foldLensDraft(opened, other, expected)).toBe(opened);
    // The contrast: the same frame stamped with THIS generation does land, so this cannot
    // pass over a fold that ignores every frame.
    expect(
      foldLensDraft(opened, frame(9, { kind: "closed", state: "settled" }), expected)?.closed,
    ).toBe(true);
  });

  it("drops a revision it has already folded", () => {
    const stale = frame(1, {
      kind: "elements",
      changed: [{ index: 0, element: step("os-late", "late") }],
      removed: [],
    });
    expect(foldLensDraft(opened, stale, expected)).toBe(opened);
    // …and the same write at a HIGHER revision lands.
    const fresh = { ...stale, revision: 2 };
    expect(foldLensDraft(opened, fresh, expected)?.elements).toHaveLength(2);
  });

  it("takes an `opened` frame's elements as the board entire, not as an append", () => {
    // The late change that matters: a lane re-opened over a board that already holds
    // elements. Seeding from empty would leave the reader's copy shorter than the board
    // and every later index would point past the end.
    const reopened = foldLensDraft(
      opened,
      frame(5, { kind: "opened", elements: [section("a", "A", []), step("b", "B")] }),
      expected,
    );
    expect(reopened?.elements.map((element) => element.id)).toEqual(["a", "b"]);
    expect(reopened?.revision).toBe(5);
    expect(reopened?.closed).toBe(false);
  });

  it("removes what a call removed and replaces what it changed", () => {
    const withStep = foldLensDraft(
      opened,
      frame(2, {
        kind: "elements",
        changed: [{ index: 1, element: step("os-1", "first") }],
        removed: [],
      }),
      expected,
    );
    expect(withStep?.elements.map((element) => element.id)).toEqual(["walk", "os-1"]);
    const changed = foldLensDraft(
      withStep,
      frame(3, {
        kind: "elements",
        changed: [{ index: 1, element: step("os-1", "second") }],
        removed: [],
      }),
      expected,
    );
    expect(changed?.elements).toHaveLength(2);
    expect((changed?.elements[1]?.data as { title?: string } | undefined)?.title).toBe("second");
    const removed = foldLensDraft(
      changed,
      frame(4, { kind: "elements", changed: [], removed: ["os-1"] }),
      expected,
    );
    expect(removed?.elements.map((element) => element.id)).toEqual(["walk"]);
  });

  it("cannot start a board from anything but an `opened` frame", () => {
    // Every other kind places elements by an index into a board this reader does not have.
    expect(
      foldLensDraft(
        undefined,
        frame(2, {
          kind: "elements",
          changed: [{ index: 0, element: step("x", "x") }],
          removed: [],
        }),
        expected,
      ),
    ).toBeUndefined();
    expect(foldLensDraft(undefined, frame(1, { kind: "opened", elements: [] }), expected)).toEqual({
      generation: LIVE,
      lens: "sequence",
      revision: 1,
      state: "drafting",
      closed: false,
      elements: [],
    });
  });
});
