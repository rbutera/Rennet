// @vitest-environment happy-dom

import type { LensBoard, LensKind, LensLane, Review, SidebarSession } from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  T3ChatSlotProvider,
  type T3NativeChatProps,
  type T3ThreadViewProps,
} from "../chat/t3-chat-slot";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { mount, waitFor } from "../test/dom";
import { FIXTURE_BOARDS } from "../test/fixtures/boards";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";

// ─────────────────────────────────────────────────────────────────────────────
// THE SEAT WIDGET, THE DRAWER, AND THE DOCK RESTORED (lens-board-tools group 6).
//
// #823, in Rai's own words (2026-09-04): "we take over the orchestrator's chat with the
// lens agent's chat thread.. thats a big nono and should be removed or reworked. i'd want
// a right sidebar or something or a drawer or something like that, but the orchestrator
// chat should always be there."
//
// So the load-bearing assertion in half the tests below is a PAIR: the seat's transcript is
// somewhere, AND the chat dock is still on the session's own thread. Either alone is a
// green bar over the bug — "the transcript opened" was true of the old dock arm too, and
// "the dock shows the session" is true of a build where the transcript opens nowhere.
//
// POSITIVE CONTROLS RUN, 2026-09-05 — each mutation applied ALONE to a clean tree, this
// file run, then reverted. The exact failing names are in the PR's control ledger.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = "gen:ps-1";

const REVIEW = {
  id: "rev-1",
  repositoryRoot: "/home/dev/widget",
  status: "current",
  activePatchsetId: "ps-1",
  patchsets: [{ id: "ps-1", source: "local", files: [] }],
} as unknown as Review;

const at = (board: LensBoard | undefined): LensBoard | null =>
  board === undefined ? null : ({ ...board, generation: LIVE } as LensBoard);

const THREAD = (id: string) => ({ environmentId: "env-1", threadId: id });

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
  {
    id: "decisions",
    label: "Decisions",
    status: "running",
    thread: THREAD("seat-decisions"),
    seats: [{ seat: "decisions", provider: "claudeAgent", thread: THREAD("seat-decisions") }],
  },
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
  // `waiting`, the post-kickoff state the daemon publishes for the derived lane (#865):
  // its board is the complement of the four above, so it has no seat and no thread until
  // they settle. `queued` — which this fixture held — only exists before kickoff.
  { id: "noise", label: "Noise", status: "waiting" },
] as LensLane[];

function harness(options: {
  readonly lanes?: LensLane[];
  readonly preparation?: SidebarSession["preparation"];
  readonly boards?: Partial<Record<LensKind, LensBoard | null>>;
}) {
  let preparation: SidebarSession["preparation"] =
    options.preparation ??
    ({ status: "drafting", reviewId: REVIEW.id, lanes: options.lanes ?? DRAFTING } as never);
  const boards = { ...options.boards };
  const row = (): SidebarSession =>
    ({
      id: "sess-live",
      projectId: "proj-1",
      title: "feat/live",
      target: "your-branch",
      createdAt: 0,
      claim: { branch: "feat/live" },
      reviewId: REVIEW.id,
      ...(preparation === undefined ? {} : { preparation }),
    }) as SidebarSession;
  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    "session.list": () => ({ sessions: [row()] }),
    "session.cancelPreparation": () => ({ session: row() }),
    "session.retryPreparation": () => ({ session: row() }),
    "review.load": () => ({ review: REVIEW, repositoryPresent: true }),
    "review.checkFreshness": () => ({ review: REVIEW }),
    "board.read": ({ generation, lens }: { generation: string; lens: LensKind }) => ({
      board: generation === LIVE ? (boards[lens] ?? null) : null,
    }),
    "chat.t3Session": () => ({
      origin: "http://127.0.0.1:1",
      wsUrl: "ws://127.0.0.1:1",
      accessToken: "t",
      environmentId: "env-1",
      thread: {
        status: "bound",
        threadId: "thread-session",
        threadUrl: "http://127.0.0.1:1/env-1/thread-session",
      },
    }),
  } as never);

  /** Both mounts of the T3 slot, each recording what it was handed. */
  const threads: T3ThreadViewProps[] = [];
  const Session = ({ session }: T3NativeChatProps) => (
    <div data-testid="dock-session-thread">
      {session.thread?.status === "bound" ? session.thread.threadId : ""}
    </div>
  );
  const Thread = (props: T3ThreadViewProps) => {
    threads.push(props);
    return <div data-testid="drawer-seat-thread">{props.thread.threadId}</div>;
  };

  return {
    threads,
    setLanes(next: LensLane[]) {
      preparation = { status: "drafting", reviewId: REVIEW.id, lanes: next } as never;
    },
    open(search = "") {
      useRennetStore.setState((s) => ({ ui: { ...s.ui, chatOpen: true, sidebarOpen: false } }));
      return mount(
        <T3ChatSlotProvider session={Session} thread={Thread}>
          <RennetRouterApp bridge={bridge} history={memoryHistory(`/s/sess-live${search}`)} />
        </T3ChatSlotProvider>,
      );
    },
  };
}

const drawer = () => document.querySelector('[data-kind="seat-transcript-drawer"]');
const dock = () => document.querySelector('[data-testid="chat-dock-slot"]');
const transcriptButton = (seat: string) =>
  document.querySelector<HTMLButtonElement>(`[data-seat-transcript="${seat}"]`);

beforeEach(() => {
  useRennetStore.setState((s) => ({ ui: { ...s.ui, seatTranscript: null } }));
});

describe("lens activity lives outside the board", () => {
  it("opens meaningful activity separately from selection, pins it, and hides raw calls", async () => {
    const h = harness({ boards: { sequence: at(FIXTURE_BOARDS.gen1?.sequence) } });
    const { user, findByRole, getByRole } = h.open("?lens=sequence");
    await user.click(await findByRole("button", { name: "Sequence activity" }));
    expect(document.querySelector('[data-kind="seat-widget"]')).toBeNull();
    const activity = getByRole("dialog", { name: "Sequence activity details" });
    expect(activity.textContent).toContain("Inspecting the change");
    expect(activity.textContent).toMatch(/Following for \d+:\d\d/);
    expect(activity.textContent).not.toContain("github-auth.ts");
    expect(activity.textContent).not.toContain("elements written");
    await user.click(getByRole("button", { name: "Pin activity" }));
    await user.click(document.body);
    expect(getByRole("dialog", { name: "Sequence activity details" })).toBeTruthy();
    await user.click(getByRole("button", { name: "Close activity" }));
    await waitFor(() =>
      expect(document.querySelector('[aria-label="Sequence activity details"]')).toBeNull(),
    );
  });

  it("offers both Flagged transcripts and retains the settled transcript", async () => {
    const h = harness({ boards: { flagged: at(FIXTURE_BOARDS.gen1?.flagged) } });
    const { user, findByRole, getByRole } = h.open("?lens=flagged");
    await user.click(await findByRole("button", { name: "Flagged activity" }));
    expect(getByRole("button", { name: "Open Claude transcript" })).toBeTruthy();
    expect(getByRole("button", { name: "Open Codex transcript" })).toBeTruthy();
    expect(getByRole("dialog", { name: "Flagged activity details" }).textContent).toContain(
      "The token refresh races the logout.",
    );
  });
});

describe("the transcript opens in its own surface and never displaces the conversation", () => {
  it("streams the seat's thread in the drawer while the dock keeps the session's thread", async () => {
    // #823 AND 6.2, as one pair. Either half alone is a green bar over the bug.
    const h = harness({ boards: { sequence: at(FIXTURE_BOARDS.gen1?.sequence) } });
    const { user, findByRole } = h.open("?lens=sequence");
    await user.click(await findByRole("button", { name: "Sequence activity" }));

    await waitFor(() => expect(transcriptButton("sequence")).toBeTruthy());
    // Before: the dock has the session's thread and nothing has a seat's.
    await waitFor(() =>
      expect(dock()?.querySelector('[data-testid="dock-session-thread"]')?.textContent).toBe(
        "thread-session",
      ),
    );
    expect(drawer()).toBeNull();

    await user.click(transcriptButton("sequence") as HTMLButtonElement);

    await waitFor(() => expect(drawer()).toBeTruthy());
    // The seat's thread, read-only, in the board region's OWN surface.
    expect(drawer()?.querySelector('[data-testid="drawer-seat-thread"]')?.textContent).toBe(
      "seat-sequence",
    );
    expect(h.threads.at(-1)?.readOnly).toBe(true);
    expect(drawer()?.getAttribute("data-lens")).toBe("sequence");
    expect(document.querySelector('[data-region="board"]')?.contains(drawer() as Node)).toBe(true);
    // AND the reviewer's own conversation is exactly where it was.
    expect(dock()?.querySelector('[data-testid="dock-session-thread"]')?.textContent).toBe(
      "thread-session",
    );
    expect(dock()?.querySelector('[data-testid="drawer-seat-thread"]')).toBeNull();
    // The dock is not inside the board region, so no state of the drawer can reach it.
    expect(document.querySelector('[data-region="board"]')?.contains(dock() as Node)).toBe(false);
  });

  it("moves the board, the widget and the transcript together when the lens changes", async () => {
    const h = harness({
      boards: {
        sequence: at(FIXTURE_BOARDS.gen1?.sequence),
        decisions: at(FIXTURE_BOARDS.gen1?.decisions),
      },
    });
    const { user, findByRole } = h.open("?lens=sequence");
    await user.click(await findByRole("button", { name: "Sequence activity" }));

    await waitFor(() => expect(transcriptButton("sequence")).toBeTruthy());
    await user.click(transcriptButton("sequence") as HTMLButtonElement);
    await waitFor(() => expect(drawer()?.getAttribute("data-lens")).toBe("sequence"));

    await user.click(document.querySelector('[data-lens="decisions"]') as HTMLButtonElement);

    // All three, in one assertion, because the defect is them DISAGREEING: a drawer left
    // on the Sequence seat above the Decisions board reads as the Decisions seat's work.
    await waitFor(() =>
      expect({
        board: document.querySelector("article[data-lens]")?.getAttribute("data-lens"),
        activity: document.querySelector('[aria-label="Decisions activity"]') !== null,
        transcript: drawer()?.getAttribute("data-lens"),
      }).toEqual({ board: "decisions", activity: true, transcript: "decisions" }),
    );
    expect(drawer()?.querySelector('[data-testid="drawer-seat-thread"]')?.textContent).toBe(
      "seat-decisions",
    );
  });

  it("shares one slot with the diff view: opening the diff closes the transcript", async () => {
    const h = harness({ boards: { sequence: at(FIXTURE_BOARDS.gen1?.sequence) } });
    const { user, findByRole } = h.open("?lens=sequence");
    await user.click(await findByRole("button", { name: "Sequence activity" }));

    await waitFor(() => expect(transcriptButton("sequence")).toBeTruthy());
    await user.click(transcriptButton("sequence") as HTMLButtonElement);
    await waitFor(() => expect(drawer()).toBeTruthy());

    const diffPill = document.querySelector<HTMLButtonElement>('[title="Diff"]');
    expect(diffPill).toBeTruthy();
    await user.click(diffPill as HTMLButtonElement);

    // The transcript is gone, the diff is showing, and the CONTROL says which: the pill
    // is pressed. (Position, not membership: the drawer must be absent, not merely
    // out-ranked by a diff rendered over it.)
    await waitFor(() => expect(drawer()).toBeNull());
    expect(diffPill?.getAttribute("aria-pressed")).toBe("true");
    expect(useRennetStore.getState().ui.seatTranscript).toBeNull();
    // …and the dock never moved through any of it.
    expect(dock()?.querySelector('[data-testid="dock-session-thread"]')?.textContent).toBe(
      "thread-session",
    );
  });
});
