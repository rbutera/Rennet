// @vitest-environment happy-dom

import type { LensBoard, LensKind, LensLane, Review, SidebarSession } from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { mount, screen, waitFor } from "../test/dom";
import { FIXTURE_BOARDS } from "../test/fixtures/boards";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";

// ─────────────────────────────────────────────────────────────────────────────
// The bench (t3-lens-threads 3.2) — the surface a reviewer waits on while the boards
// draft. Every test here drives the REAL bridge: the app polls `session.list` every
// 400ms while preparation is active, so "the line updates" is proved by changing what
// the handler answers and letting the app's own poll pick it up, not by re-rendering a
// component with new props.
//
// POSITIVE CONTROLS RUN, 2026-09-03. Five mutations of `preparation-bench.tsx`, each
// run alone against this file and reverted; every test below reddened under exactly one
// of them, and the suite was green again after each revert:
//
//   1. `speechOf`'s `running` arm returns `{ text: "under way", quiet: true }`
//      unconditionally (a bench that never reads `latest`)
//        → 2 failed: the live-line test AND the idle test.
//   2. the reader's `disabled={thread === undefined}` deleted
//        → 1 failed: the no-thread test.
//   3. the reader's `onClick` deleted
//        → 1 failed: the settled-reader test.
//   4. `speechOf`'s failed/absent arm returns `lane.status` instead of `lane.reason`
//        → 1 failed: the failed-reader test.
//   5. `CaptureRail`'s per-beat `state` pinned to `"active"`
//        → 1 failed: the capture test.
//
// What a control does NOT prove is that the poll is what moved the line — 1 reddens
// the live-line test on its FIRST assertion too. The second half of that test is the
// one asking the poll question, and it is written so it cannot be satisfied by the
// first render: the handler's answer is rewritten AFTER mount, with no rerender call.
// ─────────────────────────────────────────────────────────────────────────────

/** The store is a module singleton: a test that opens a lens thread would otherwise leak
 *  it into the next one, and `lensThread` is exactly what two of these assert on. */
beforeEach(() => {
  useRennetStore.setState((s) => ({ ui: { ...s.ui, chatOpen: false, lensThread: null } }));
});

const THREAD = { environmentId: "env-1", threadId: "thread-design" } as const;

const lane = (over: Partial<LensLane> & Pick<LensLane, "id" | "label" | "status">): LensLane =>
  ({ thread: THREAD, ...over }) as LensLane;

/**
 * A bridge whose `session.list` answer can be REWRITTEN between polls — the shape a
 * streaming lane actually has. `set` replaces the row the daemon would return next; the
 * app's own 400ms poll is what brings it to the screen.
 */
function benchBridge(initial: SidebarSession["preparation"], claim?: { branch: string }) {
  let preparation = initial;
  const row = (): SidebarSession => ({
    id: "sess-bench",
    projectId: "proj-1",
    title: "feat/bench",
    target: "your-branch",
    createdAt: 0,
    ...(claim ? { claim } : {}),
    ...(preparation === undefined ? {} : { preparation }),
  });
  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    "session.list": () => ({ sessions: [row()] }),
    "session.cancelPreparation": () => ({ session: row() }),
    "review.load": () => {
      throw new Error("Review not found");
    },
  } as never);
  return {
    bridge,
    set(next: SidebarSession["preparation"]) {
      preparation = next;
    },
  };
}

const open = (bridge: MemoryBridge) =>
  mount(<RennetRouterApp bridge={bridge} history={memoryHistory("/s/sess-bench")} />);

/** One reader's spoken line — the serif line under its name, whatever the state. */
const speechOf = (id: string) =>
  document.querySelector(`[data-row="${id}"] [data-speech]`)?.textContent;

describe("the bench — five readers at work on the change", () => {
  it("shows a running reader's latest line, and follows it to the next one the daemon publishes", async () => {
    const drafting = (latest: { kind: "tool" | "text"; text: string }) => ({
      status: "drafting" as const,
      reviewId: "rev-1",
      lanes: [
        lane({ id: "design", label: "Design", status: "running", latest: { ...latest, at: 1 } }),
      ] as LensLane[],
    });
    const live = benchBridge(drafting({ kind: "tool", text: "reading src/foo.ts" }));
    open(live.bridge);

    // The tool call in flight, in the daemon's plain words.
    await waitFor(() => expect(speechOf("design")).toBe("reading src/foo.ts"));
    expect(document.querySelector('[data-row="design"]')?.getAttribute("data-register")).toBe(
      "working",
    );

    // The seat moves on. The app's own `session.list` poll is what carries it — nothing
    // in the test re-renders the tree.
    live.set(drafting({ kind: "text", text: "The parser now owns its own budget." }));
    await waitFor(() => expect(speechOf("design")).toBe("The parser now owns its own budget."), {
      timeout: 4_000,
    });
  });

  it("says a quiet seat is quiet, in the daemon's words, instead of freezing on a stale line", async () => {
    const { bridge } = benchBridge({
      status: "drafting",
      reviewId: "rev-1",
      lanes: [
        lane({
          id: "sequence",
          label: "Sequence",
          status: "running",
          latest: { kind: "idle", text: "quiet for 40s", at: 1 },
        }),
      ] as LensLane[],
    });
    open(bridge);

    await waitFor(() => expect(speechOf("sequence")).toBe("quiet for 40s"));
    // The QUIET register is a second, non-colour statement: an idle line must not read as
    // work in progress. A running-but-idle lane still reads `working` on the lane itself —
    // it has not settled — which is why the distinction lives on the speech.
    expect(
      document.querySelector('[data-row="sequence"] [data-speech]')?.getAttribute("data-speech"),
    ).toBe("quiet");
  });

  it("a failed reader speaks its reason and is marked failed, not left spinning", async () => {
    const { bridge } = benchBridge({
      status: "drafting",
      reviewId: "rev-1",
      lanes: [
        lane({
          id: "flagged",
          label: "Flagged",
          status: "failed",
          reason: "The seat thread settled with no structured output.",
        }),
      ] as LensLane[],
    });
    open(bridge);

    await waitFor(() =>
      expect(speechOf("flagged")).toBe("The seat thread settled with no structured output."),
    );
    const reader = document.querySelector('[data-row="flagged"]');
    expect(reader?.getAttribute("data-register")).toBe("failed");
    expect(reader?.getAttribute("data-status")).toBe("failed");
  });

  it("a settled reader is still a control: activating it points the chat slot at its thread", async () => {
    const { bridge } = benchBridge({
      status: "drafting",
      reviewId: "rev-1",
      lanes: [
        lane({
          id: "decisions",
          label: "Decisions",
          status: "done",
          verdict: "reworked",
          thread: { environmentId: "env-1", threadId: "thread-decisions" },
        }),
      ] as LensLane[],
    });
    const { user } = open(bridge);

    await waitFor(() => expect(speechOf("decisions")).toBe("reworked"));
    expect(useRennetStore.getState().ui.lensThread).toBeNull();

    const reader = document.querySelector('[data-row="decisions"] button') as HTMLButtonElement;
    expect(reader.disabled).toBe(false);
    await user.click(reader);

    // The exact thread the LANE named — not the session's, and not another lane's.
    expect(useRennetStore.getState().ui.lensThread).toEqual({
      environmentId: "env-1",
      threadId: "thread-decisions",
    });
    // And the slot it points at is open, because a transcript nobody can see is not opened.
    expect(useRennetStore.getState().ui.chatOpen).toBe(true);
  });

  it("a reader whose seat has no thread yet is not a control", async () => {
    const { bridge } = benchBridge({
      status: "drafting",
      reviewId: "rev-1",
      lanes: [
        { id: "noise", label: "Noise", status: "queued" },
        lane({ id: "design", label: "Design", status: "queued" }),
      ] as LensLane[],
    });
    const { user } = open(bridge);

    await waitFor(() => expect(speechOf("noise")).toBe("queued"));
    const withoutThread = document.querySelector('[data-row="noise"] button') as HTMLButtonElement;
    const withThread = document.querySelector('[data-row="design"] button') as HTMLButtonElement;
    // The CONTRAST is the assertion: both lanes are `queued`, so what separates them is
    // the thread and nothing else. Without the second row this test would pass against a
    // bench that disabled every queued reader for the wrong reason.
    expect(withoutThread.disabled).toBe(true);
    expect(withThread.disabled).toBe(false);

    await user.click(withoutThread);
    expect(useRennetStore.getState().ui.lensThread).toBeNull();
  });

  it("a two-seat lane speaks with both voices, and each opens its own transcript", async () => {
    const claude = { environmentId: "env-1", threadId: "thread-flagged-claude" };
    const codex = { environmentId: "env-1", threadId: "thread-flagged-codex" };
    const { bridge } = benchBridge({
      status: "drafting",
      reviewId: "rev-1",
      lanes: [
        {
          id: "flagged",
          label: "Flagged",
          status: "running",
          // The lane-level mirror of the primary seat — what a pre-seats reader sees.
          thread: claude,
          latest: { kind: "tool", text: "reading src/auth.ts", at: 1 },
          seats: [
            {
              seat: "flagged-claude",
              provider: "claudeAgent",
              thread: claude,
              latest: { kind: "tool", text: "reading src/auth.ts", at: 1 },
            },
            {
              seat: "flagged-codex",
              provider: "codex",
              thread: codex,
              latest: { kind: "text", text: "The token refresh races the logout.", at: 1 },
            },
          ],
        },
      ] as LensLane[],
    });
    const { user } = open(bridge);

    const voice = (seat: string) =>
      document.querySelector(`[data-row="flagged"] [data-seat="${seat}"]`) as HTMLButtonElement;
    await waitFor(() => expect(voice("flagged-codex")).toBeTruthy());
    // BOTH lines, each under its speaker's name — not the primary's line alone, and not
    // one line flipping between the two.
    expect(voice("flagged-claude").querySelector("[data-speech]")?.textContent).toBe(
      "reading src/auth.ts",
    );
    expect(voice("flagged-codex").querySelector("[data-speech]")?.textContent).toBe(
      "The token refresh races the logout.",
    );
    expect(voice("flagged-claude").textContent).toContain("Claude");
    expect(voice("flagged-codex").textContent).toContain("Codex");

    // Each voice is its own control, pointing the slot at ITS thread.
    await user.click(voice("flagged-codex"));
    expect(useRennetStore.getState().ui.lensThread).toEqual(codex);
    await user.click(voice("flagged-claude"));
    expect(useRennetStore.getState().ui.lensThread).toEqual(claude);
  });

  it("reveals each settled lens's board in place while the other readers keep working", async () => {
    // Two lanes settled, three still running. The bench must show the two boards NOW —
    // not after every sibling finishes and the workspace replaces the bench.
    const LIVE = "gen:ps-1";
    const review = {
      id: "rev-1",
      activePatchsetId: "ps-1",
      patchsets: [{ id: "ps-1", files: [] }],
    } as unknown as Review;
    const boardsAtLive = Object.fromEntries(
      Object.entries(FIXTURE_BOARDS.gen1 ?? {}).map(([lens, board]) => [
        lens,
        { ...board, generation: LIVE },
      ]),
    ) as Partial<Record<LensKind, LensBoard>>;
    const row: SidebarSession = {
      id: "sess-bench",
      projectId: "proj-1",
      title: "feat/bench",
      target: "your-branch",
      createdAt: 0,
      reviewId: "rev-1",
      preparation: {
        status: "drafting",
        reviewId: "rev-1",
        lanes: [
          lane({ id: "design", label: "Design", status: "done", verdict: "reworked" }),
          lane({ id: "sequence", label: "Sequence", status: "running" }),
          lane({ id: "decisions", label: "Decisions", status: "drafted" }),
          lane({ id: "flagged", label: "Flagged", status: "running" }),
          lane({ id: "noise", label: "Noise", status: "running" }),
        ] as LensLane[],
      },
    };
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      "session.list": () => ({ sessions: [row] }),
      "review.load": () => ({ review, repositoryPresent: true }),
      // The daemon's own behaviour: the exact generation, honest `null` otherwise.
      "board.read": ({ generation, lens }: { generation: string; lens: LensKind }) => ({
        board: generation === LIVE ? (boardsAtLive[lens] ?? null) : null,
      }),
    } as never);
    open(bridge);

    const boardOf = (lens: string) =>
      document.querySelector(`[data-bench-board="${lens}"] article[data-lens="${lens}"]`);
    await waitFor(() => expect(boardOf("design")).toBeTruthy());
    await waitFor(() => expect(boardOf("decisions")).toBeTruthy());
    // Exactly the two settled boards, at the live generation, and none for a running lane
    // — even though the fixture HAS a board for every lens, so a bench that revealed on
    // "board exists" rather than "lane settled" would show five here.
    expect(document.querySelectorAll("[data-bench-board]")).toHaveLength(2);
    expect(boardOf("design")?.getAttribute("data-generation")).toBe(LIVE);
    for (const lens of ["sequence", "flagged", "noise"]) {
      expect(boardOf(lens)).toBeNull();
      expect(document.querySelector(`[data-row="${lens}"]`)?.getAttribute("data-register")).toBe(
        "working",
      );
    }
    // The bench is still the bench: the readers stay as the way to each transcript.
    expect(document.querySelector('[data-row="design"] button')).toBeTruthy();
    expect(document.querySelector('[data-screen="session-preparation"]')).toBeTruthy();
  });

  it("capture is the first beat of the same scene — both steps, on the bench, with cancel", async () => {
    const capture = benchBridge(
      { status: "capturing", step: "resolving-repository" },
      {
        branch: "feat/bench",
      },
    );
    open(capture.bridge);

    // Beat one. The workspace is ALREADY open around it — this is the bench, not a
    // separate capture page, so the chat slot the layout mounts is on screen too.
    await waitFor(() =>
      expect(
        document.querySelector('[data-beat="resolving-repository"]')?.getAttribute("data-state"),
      ).toBe("active"),
    );
    expect(
      document.querySelector('[data-beat="capturing-change"]')?.getAttribute("data-state"),
    ).toBe("waiting");
    expect(document.querySelector('[data-testid="chat-dock-slot"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();

    // Beat two, carried by the same poll the running lanes ride.
    capture.set({ status: "capturing", step: "capturing-change" });
    await waitFor(
      () =>
        expect(
          document.querySelector('[data-beat="capturing-change"]')?.getAttribute("data-state"),
        ).toBe("active"),
      { timeout: 4_000 },
    );
    expect(
      document.querySelector('[data-beat="resolving-repository"]')?.getAttribute("data-state"),
    ).toBe("done");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});
