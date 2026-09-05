// @vitest-environment happy-dom

import type { LensBoard, LensKind, LensLane, Review, SidebarSession } from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { mount, waitFor } from "../test/dom";
import { FIXTURE_BOARDS } from "../test/fixtures/boards";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";

// ─────────────────────────────────────────────────────────────────────────────
// BOARDS FIRST (lens-board-tools group 5) — what the reviewer meets, from the first
// frame, driven through the REAL app.
//
// Rai, 2026-09-04: "what if we were immediately taken to the main boards views and the
// lens headers would have spinners showing that they're working and each board would
// ultimately be visible as it is getting generated".
//
// Every test here drives `RennetRouterApp` over a MemoryBridge whose answers can be
// REWRITTEN between polls, which is the shape a drafting lane really has: the app's own
// `session.list` poll and its own `board.read` poll are what carry a new frame to the
// screen. Nothing below re-renders the tree by hand, so "the board fills while you watch"
// is proved by the app doing it, not by mounting a component twice with different props.
//
// POSITIVE CONTROLS RUN, 2026-09-05 — each mutation applied ALONE to a clean tree, this
// file run, then reverted. The exact failing names are in the PR's control ledger.
// ─────────────────────────────────────────────────────────────────────────────

/** The generation id the daemon really stamps for a review whose active patchset is `ps-1`. */
const LIVE = "gen:ps-1";

const REVIEW = {
  id: "rev-1",
  repositoryRoot: "/home/dev/widget",
  status: "current",
  activePatchsetId: "ps-1",
  patchsets: [{ id: "ps-1", source: "local", files: [] }],
} as unknown as Review;

/** A fixture board re-stamped onto the live generation — `board-data.ts` rejects a board
 *  whose own `generation` disagrees with the one requested, so the stamp is load-bearing. */
const at = (board: LensBoard | undefined): LensBoard | null =>
  board === undefined ? null : ({ ...board, generation: LIVE } as LensBoard);

const THREAD = (id: string) => ({ environmentId: "env-1", threadId: id });

/** The mid-draft frame: Design settled, Sequence writing, Decisions writing, Flagged on two
 *  voices, Noise queued behind all of them. */
const DRAFTING: LensLane[] = [
  { id: "design", label: "Design", status: "done", verdict: "carrying-forward" },
  {
    id: "sequence",
    label: "Sequence",
    status: "running",
    thread: THREAD("seat-sequence"),
    latest: { kind: "tool", text: "reading packages/adapters/src/github-auth.ts", at: 1 },
    seats: [
      {
        seat: "sequence",
        provider: "claudeAgent",
        thread: THREAD("seat-sequence"),
        latest: { kind: "tool", text: "reading packages/adapters/src/github-auth.ts", at: 1 },
      },
    ],
  },
  { id: "decisions", label: "Decisions", status: "running", thread: THREAD("seat-decisions") },
  {
    id: "flagged",
    label: "Flagged",
    status: "running",
    thread: THREAD("seat-flagged-claude"),
    seats: [
      {
        seat: "flagged-claude",
        provider: "claudeAgent",
        thread: THREAD("seat-flagged-claude"),
        latest: { kind: "tool", text: "grepping withConnectResilience", at: 1 },
      },
      {
        seat: "flagged-codex",
        provider: "codex",
        thread: THREAD("seat-flagged-codex"),
        latest: { kind: "text", text: "The token refresh races the logout.", at: 1 },
      },
    ],
  },
  { id: "noise", label: "Noise", status: "queued" },
] as LensLane[];

/** The same generation, settled. Sequence carries a delta-bearing board here. */
const SETTLED: LensLane[] = [
  { id: "design", label: "Design", status: "done", verdict: "carrying-forward" },
  {
    id: "sequence",
    label: "Sequence",
    status: "done",
    verdict: "reworked",
    thread: THREAD("seat-sequence"),
    seats: [{ seat: "sequence", provider: "claudeAgent", thread: THREAD("seat-sequence") }],
  },
  { id: "decisions", label: "Decisions", status: "done", verdict: "carrying-forward" },
  { id: "flagged", label: "Flagged", status: "done", verdict: "carrying-forward" },
  { id: "noise", label: "Noise", status: "absent", reason: "Every region is on another board." },
] as LensLane[];

interface Live {
  readonly bridge: MemoryBridge;
  setLanes(next: LensLane[] | undefined): void;
  setPreparation(next: SidebarSession["preparation"]): void;
  setBoard(lens: LensKind, board: LensBoard | null): void;
}

function liveBridge(options: {
  readonly preparation?: SidebarSession["preparation"];
  readonly boards?: Partial<Record<LensKind, LensBoard | null>>;
  readonly review?: boolean;
}): Live {
  let preparation = options.preparation;
  const boards: Partial<Record<LensKind, LensBoard | null>> = { ...options.boards };
  const row = (): SidebarSession =>
    ({
      id: "sess-live",
      projectId: "proj-1",
      title: "feat/live",
      target: "your-branch",
      createdAt: 0,
      claim: { branch: "feat/live" },
      ...(options.review === false ? {} : { reviewId: REVIEW.id }),
      ...(preparation === undefined ? {} : { preparation }),
    }) as SidebarSession;
  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    "session.list": () => ({ sessions: [row()] }),
    "session.cancelPreparation": () => ({ session: row() }),
    "session.retryPreparation": () => ({ session: row() }),
    "review.load": () => {
      if (options.review === false) throw new Error("Review not found");
      return { review: REVIEW, repositoryPresent: true };
    },
    "review.checkFreshness": () => ({ review: REVIEW }),
    "board.read": ({ generation, lens }: { generation: string; lens: LensKind }) => {
      if (generation !== LIVE) return { board: null };
      return { board: boards[lens] ?? null };
    },
    "chat.t3Session": () => ({
      origin: "http://127.0.0.1:1",
      wsUrl: "ws://127.0.0.1:1",
      accessToken: "t",
      environmentId: "env-1",
      threadId: "thread-session",
    }),
  } as never);
  return {
    bridge,
    setLanes(next) {
      preparation =
        next === undefined ? undefined : { status: "drafting", reviewId: REVIEW.id, lanes: next };
    },
    setPreparation(next) {
      preparation = next;
    },
    setBoard(lens, board) {
      boards[lens] = board;
    },
  };
}

const open = (live: Live, search = "") =>
  mount(<RennetRouterApp bridge={live.bridge} history={memoryHistory(`/s/sess-live${search}`)} />);

const tabOf = (lens: string) => document.querySelector(`[data-lens="${lens}"]`);

/**
 * The three independent ways an unsettled board says so (D13), read in ONE object so the
 * assertion below is a single claim about all three. A test that checked them one after
 * another would still pass with two of the three present and a diff nobody reads.
 */
function provisionalSignals(lens: LensKind) {
  return {
    railIndicator: tabOf(lens)?.getAttribute("data-register") ?? null,
    railCut:
      tabOf(lens)?.querySelector('[data-testid="lens-stop"]')?.getAttribute("data-cut") ?? null,
    inProgressMark: document.querySelector('[data-kind="board-in-progress"]') !== null,
    stillBeingWritten: /still being written/i.test(document.body.textContent ?? ""),
    placeholderRow: document.querySelector('[data-kind="board-ghost"]') !== null,
  };
}

beforeEach(() => {
  // The store is a module singleton: a transcript left open leaks into the next test.
  useRennetStore.setState((s) => ({ ui: { ...s.ui, chatOpen: false, seatTranscript: null } }));
});

describe("the review opens on its boards, with no waiting stage in front of them", () => {
  it("puts the board view on screen while capture is still running", async () => {
    // 5.2. The review does not exist yet — capture is resolving the repository — and the
    // board view is ALREADY the surface, with the capture step named in the workspace's
    // own header. Before this there was a whole separate screen here.
    const live = liveBridge({
      review: false,
      preparation: { status: "capturing", step: "resolving-repository" },
    });
    open(live);

    await waitFor(() =>
      expect(document.querySelector('[data-kind="lens-board-view"]')).toBeTruthy(),
    );
    // The two named beats, in the workspace header, over the boards.
    const header = document.querySelector('[data-testid="workspace-header"]');
    expect(header?.getAttribute("data-status")).toBe("capturing");
    expect(
      header?.querySelector('[data-beat="resolving-repository"]')?.getAttribute("data-state"),
    ).toBe("active");
    expect(
      header?.querySelector('[data-beat="capturing-change"]')?.getAttribute("data-state"),
    ).toBe("waiting");
    expect(header?.textContent).toContain("Cancel");
    // POSITION, not membership: the header comes BEFORE the board region in the document,
    // and the board region is not inside it — that is what "over the boards" means, and a
    // pair of `toContain` checks would be satisfied by a header that swallowed the board.
    const region = document.querySelector('[data-region="board"]');
    if (!header || !region) throw new Error("the workspace has no header or no board region");
    expect(header.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(header.contains(region)).toBe(false);
    // No preparation SCREEN survives anywhere.
    expect(document.querySelector('[data-screen="session-preparation"]')).toBeNull();
  });

  it("lists all five lenses from the first frame, each carrying its seat's state", async () => {
    // 5.1. Two settled, three running, and every one of them present and selectable.
    const live = liveBridge({
      preparation: { status: "drafting", reviewId: REVIEW.id, lanes: DRAFTING },
      boards: { sequence: at(FIXTURE_BOARDS.gen1?.sequence) },
    });
    open(live);

    await waitFor(() => expect(tabOf("noise")).toBeTruthy());
    const rail = document.querySelector('[data-kind="lens-switcher"]');
    expect(
      [...(rail?.querySelectorAll("[data-lens]") ?? [])].map((t) => t.getAttribute("data-lens")),
    ).toEqual(["design", "sequence", "decisions", "flagged", "noise"]);
    expect(tabOf("design")?.getAttribute("data-register")).toBe("settled");
    expect(tabOf("sequence")?.getAttribute("data-register")).toBe("working");
    expect(tabOf("decisions")?.getAttribute("data-register")).toBe("working");
    expect(tabOf("flagged")?.getAttribute("data-register")).toBe("working");
    // A running lens is SELECTABLE and is never a disabled segment.
    for (const lens of ["design", "sequence", "decisions", "flagged", "noise"]) {
      expect(document.querySelector<HTMLButtonElement>(`[data-lens="${lens}"]`)?.disabled).toBe(
        false,
      );
    }
    // Flagged carries ONE INDICATOR PER VOICE, because it runs two seats. The contrast is
    // the assertion: Sequence is running too and carries one.
    expect(
      tabOf("flagged")?.querySelector('[data-testid="lens-working"]')?.getAttribute("data-voices"),
    ).toBe("2");
    expect(
      tabOf("sequence")?.querySelector('[data-testid="lens-working"]')?.getAttribute("data-voices"),
    ).toBe("1");
  });
});

describe("a drafting board says so three ways, and they clear together", () => {
  it("shows the rail indicator, the in-progress mark and the placeholder row at once", async () => {
    // 5.3/D13. THE CONTROL for this is a mutation that removes ONE of the three; the
    // single `toEqual` below is what makes any one removal redden it.
    const live = liveBridge({
      preparation: { status: "drafting", reviewId: REVIEW.id, lanes: DRAFTING },
      boards: { sequence: at(FIXTURE_BOARDS.gen1?.sequence) },
    });
    open(live, "?lens=sequence");

    await waitFor(() => expect(document.querySelector("article[data-lens=sequence]")).toBeTruthy());
    // The elements the seat has written so far are READABLE — the board is not held back
    // until its lane settles, which is the half of #819 this closes.
    expect(document.body.textContent).toContain("The Shape of an Observation");
    expect(provisionalSignals("sequence")).toEqual({
      railIndicator: "working",
      railCut: "open",
      inProgressMark: true,
      stillBeingWritten: true,
      placeholderRow: true,
    });
  });

  it("clears all three the moment the lane settles, and nothing navigates", async () => {
    const live = liveBridge({
      preparation: { status: "drafting", reviewId: REVIEW.id, lanes: DRAFTING },
      boards: { sequence: at(FIXTURE_BOARDS.gen1?.sequence) },
    });
    const { history } = { history: memoryHistory("/s/sess-live?lens=sequence") };
    mount(<RennetRouterApp bridge={live.bridge} history={history} />);

    // Wait for the BOARD first. Before the read resolves, the empty-board placeholder
    // carries a chip and a ghost of its own, so a whole-object assertion made too early is
    // satisfied by a frame that has no board on it at all — which is exactly how a control
    // that removed the board header's chip stayed green here on the first attempt.
    await waitFor(() => expect(document.querySelector("article[data-lens=sequence]")).toBeTruthy());
    // The same whole-object claim on the way IN, so this test controls all three signals
    // too rather than only their disappearance.
    await waitFor(() =>
      expect(provisionalSignals("sequence")).toEqual({
        railIndicator: "working",
        railCut: "open",
        inProgressMark: true,
        stillBeingWritten: true,
        placeholderRow: true,
      }),
    );
    const before = history.history.at(-1);

    // The daemon settles the generation. Nothing here re-renders the tree — the app's own
    // `session.list` poll is what carries the new frame, which is why this is a TRANSITION.
    live.setLanes(SETTLED);

    await waitFor(
      () =>
        expect(provisionalSignals("sequence")).toEqual({
          railIndicator: "settled",
          railCut: "seamed",
          inProgressMark: false,
          stillBeingWritten: false,
          placeholderRow: false,
        }),
      { timeout: 4_000 },
    );
    // The board the reviewer was watching is the board they are still reading, at the same
    // route: the drafting view and the finished view are one view.
    expect(document.querySelector("article[data-lens=sequence]")).toBeTruthy();
    expect(history.history.at(-1)).toBe(before);
  });

  it("withholds the round-delta marks while the board is unsettled and shows them at settle", async () => {
    // 5.4/D13. A partial board would mark every section new, which is a lie the reviewer
    // acts on by re-reading a whole board. The Flagged gen2 fixture carries real deltas,
    // so this is the marks being withheld — not a board that never had any.
    const flagged = at(FIXTURE_BOARDS.gen2?.flagged);
    expect(flagged?.sections.some((s) => s.delta !== undefined)).toBe(true);
    const live = liveBridge({
      preparation: { status: "drafting", reviewId: REVIEW.id, lanes: DRAFTING },
      boards: { flagged },
    });
    mount(
      <RennetRouterApp bridge={live.bridge} history={memoryHistory("/s/sess-live?lens=flagged")} />,
    );

    await waitFor(() => expect(document.querySelector("article[data-lens=flagged]")).toBeTruthy());
    expect(document.querySelectorAll("[data-kind=board-section][data-delta]")).toHaveLength(0);
    expect(document.querySelector('[data-testid="delta-dot"]')).toBeNull();
    expect(document.querySelector('[data-testid="lens-delta-pip"]')).toBeNull();

    live.setLanes(SETTLED);

    await waitFor(
      () =>
        expect(
          document.querySelectorAll("[data-kind=board-section][data-delta]").length,
        ).toBeGreaterThan(0),
      { timeout: 4_000 },
    );
    expect(document.querySelector('[data-testid="delta-dot"]')).toBeTruthy();
  });
});

describe("a run that is over never says a seat is still writing", () => {
  // THE REGRESSION, driven through the real app and read off the rendered text — which is
  // how it was found and the only way it is visible. Both screens below shipped in this
  // wave's first commit: `useGenerationLanes` answered `[]` for any preparation with no
  // `lanes` key, `lens-seats.ts` read `[]` as "in flight, lanes not opened yet", and that
  // `drafting` reached the board's own copy.
  //
  // The assertion is on the WHOLE rendered text rather than on one element, because the
  // defect was several surfaces agreeing with each other and disagreeing with the header:
  // a chip, a sentence, a ghost row and an animating rail lamp, over a screen that said
  // the run was cancelled.

  const noStillWriting = () => {
    const text = document.body.textContent ?? "";
    return {
      inProgressMark: document.querySelector('[data-kind="board-in-progress"]') !== null,
      stillBeingWritten: /still being written/i.test(text),
      placeholderRow: document.querySelector('[data-kind="board-ghost"]') !== null,
      seatWidget: document.querySelector('[data-kind="seat-widget"]') !== null,
      workingLens: document.querySelector('[data-register="working"]') !== null,
      openCut: document.querySelector('[data-cut="open"]') !== null,
    };
  };

  it("says nothing is being written after the reviewer cancels a drafting generation", async () => {
    // A cancel keeps the lanes exactly as they stood — Design frozen mid-run.
    const live = liveBridge({
      preparation: { status: "drafting", reviewId: REVIEW.id, lanes: DRAFTING },
      boards: { sequence: at(FIXTURE_BOARDS.gen1?.sequence) },
    });
    open(live, "?lens=design");

    // The control half: while it IS drafting, the board says so. Without this the test
    // would pass over a build that never shows the signals at all.
    await waitFor(() => expect(noStillWriting().stillBeingWritten).toBe(true));

    live.setPreparation({
      status: "cancelled",
      stage: "boards",
      reviewId: REVIEW.id,
      lanes: DRAFTING,
    });

    await waitFor(
      () =>
        expect(noStillWriting()).toEqual({
          inProgressMark: false,
          stillBeingWritten: false,
          placeholderRow: false,
          // The widget survives: the lane ran, so its transcript is still worth reaching.
          seatWidget: true,
          workingLens: false,
          openCut: false,
        }),
      { timeout: 4_000 },
    );
    // …and the screen still says what happened, in one voice rather than two.
    expect(document.querySelector('[data-testid="workspace-header"]')?.textContent).toContain(
      "cancelled",
    );
  });

  it("says nothing is being written when capture failed before any lane opened", async () => {
    // The worse of the two, because it needs no lanes at all: a failed CAPTURE has no
    // `lanes` key, which the old reading turned into five queued seats — and into a Noise
    // tab claiming to wait on four lanes that were not running.
    const live = liveBridge({
      review: false,
      preparation: {
        status: "failed",
        stage: "capture",
        reason: "Could not resolve the repository.",
      },
    });
    open(live, "?lens=design");

    await waitFor(() =>
      expect(document.querySelector('[data-kind="lens-board-view"]')).toBeTruthy(),
    );
    expect(noStillWriting()).toEqual({
      inProgressMark: false,
      stillBeingWritten: false,
      placeholderRow: false,
      // No lane was ever opened, so there is no seat to name.
      seatWidget: false,
      workingLens: false,
      openCut: false,
    });
    // Noise waits on nobody. The rail still LISTS all five (5.1) — that part was right.
    expect(tabOf("noise")?.getAttribute("data-waiting-on")).toBeNull();
    expect(document.querySelectorAll('[data-kind="lens-switcher"] [data-lens]')).toHaveLength(5);
    expect(document.querySelector('[data-testid="workspace-header"]')?.textContent).toContain(
      "Could not resolve the repository.",
    );
  });

  it("draws no board being written while capture is still running", async () => {
    // The explicit decision D13 left open: during capture nothing is being written, so no
    // board carries the in-progress copy. The rail is where the five lenses are listed.
    const live = liveBridge({
      review: false,
      preparation: { status: "capturing", step: "capturing-change" },
    });
    open(live, "?lens=design");

    await waitFor(() =>
      expect(document.querySelector('[data-kind="lens-board-view"]')).toBeTruthy(),
    );
    expect(noStillWriting()).toEqual({
      inProgressMark: false,
      stillBeingWritten: false,
      placeholderRow: false,
      seatWidget: false,
      workingLens: false,
      openCut: false,
    });
    // Five lenses, all honestly waiting — and none of them claiming a board.
    expect(document.querySelectorAll('[data-kind="lens-switcher"] [data-lens]')).toHaveLength(5);
    expect(tabOf("design")?.getAttribute("data-register")).toBe("waiting");
    expect(tabOf("noise")?.getAttribute("data-waiting-on")).toBeNull();
  });
});

describe("Noise waits on its siblings, and the coverage surface is gone", () => {
  it("reads as waiting on the lanes it needs — not working, not failed — and reports no coverage", async () => {
    // 5.7/D16c. Noise is the COMPLEMENT of the other four, so it cannot start until they
    // settle. The fixture has two lanes still running, which is the shape the task names.
    const live = liveBridge({
      preparation: { status: "drafting", reviewId: REVIEW.id, lanes: DRAFTING },
      boards: { sequence: at(FIXTURE_BOARDS.gen1?.sequence) },
    });
    open(live, "?lens=noise");

    await waitFor(() => expect(tabOf("noise")).toBeTruthy());
    const noise = tabOf("noise");
    expect(noise?.getAttribute("data-register")).toBe("waiting");
    // It NAMES what it is waiting for — the three lanes that have not settled, and not
    // Design, which has.
    expect(noise?.getAttribute("data-waiting-on")).toBe("sequence,decisions,flagged");
    expect(noise?.getAttribute("aria-label")).toBe(
      "Noise, waiting on Sequence, Decisions and Flagged",
    );
    // Not working: no per-voice working indicator, and the stop is unstarted, not open.
    expect(noise?.querySelector('[data-testid="lens-working"]')).toBeNull();
    expect(noise?.querySelector('[data-testid="lens-stop"]')?.getAttribute("data-cut")).toBe(
      "unstarted",
    );
    // Not failed.
    expect(noise?.getAttribute("data-failed")).toBeNull();

    // THE SWEEP (D16a): the uncited regions have exactly one home, the Noise board, and no
    // second surface reports a coverage state or an uncovered count. The literal is
    // hard-coded — deriving the patterns from the code under test would be satisfied by an
    // empty set on both sides.
    const forbidden = [/uncovered/i, /coverage/i, /\bhunks? (?:uncovered|not covered)\b/i];
    expect(forbidden).toHaveLength(3);
    const text = document.body.textContent ?? "";
    expect(text.length).toBeGreaterThan(200);
    for (const pattern of forbidden) {
      expect(text, `the workspace reports no ${pattern}`).not.toMatch(pattern);
    }
    // And the sweep swept a real workspace, not an empty one: all five lenses were on it.
    expect(document.querySelectorAll('[data-kind="lens-switcher"] [data-lens]')).toHaveLength(5);
  });
});
