import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardMetaStore, SessionStore } from "@rennet/adapters";
import type {
  CodexExecutor,
  DeltaPacket,
  HarnessPort,
  LintContext,
  LintTarget,
  SessionOutcome,
  SessionSpec,
} from "@rennet/core";
import type { DraftBoard, Generation, SessionModel, SessionThread } from "@rennet/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BoardsRuntime } from "../boards/boards-runtime";
import type { BoardMeta } from "../runtime/lens-pipeline";
import { createRoundsRuntime } from "../runtime/rounds";
import { SessionEntry, type Target } from "./session-entry";
import { SessionTurnLoop, type TurnRow } from "./turn-loop";

// ─────────────────────────────────────────────────────────────────────────────
// B09 packet E2E (cluster 8, task 8.2). The kill-mid-generation → restart →
// reattach proof, composed over the REAL durable stores (`SessionStore`,
// `BoardMetaStore` on temp dirs) and the REAL server units (`SessionEntry`,
// `createRoundsRuntime`/`PipelineStartGuard`, `SessionTurnLoop`). The model is
// the only thing faked — every port is injected, so the gate makes no live call
// while the runtime stays pure over the seams (packet Verification).
//
// What this proves as ONE timeline, not six unit assertions:
//   1. A row-click mints a session + claims the target, persisted to disk.
//   2. A round drafts the boards ONCE — a re-entry resolving to the same
//      (session, generation) does NOT re-draft (the idempotency guard, exercised
//      through the rounds runtime), and each board's coverage/blemish meta is
//      persisted durably.
//   3. KILL + RESTART: fresh stores over the SAME dirs (a new process) reload the
//      session — the cursor, the claim, and the anchored thread survive; a second
//      row-click REATTACHES (same id, no second mint); the boards reconstruct
//      intact from the persisted `BoardMeta`.
//   4. A vanished harness transcript triggers the honest `context_rebuilt` row and
//      re-mints the cursor from turn 1 — while the boards (BoardMeta on disk) and
//      the session's claim/threads stay CANONICAL.
// ─────────────────────────────────────────────────────────────────────────────

// ── Fakes: the injected model + boards ports (no live call) ──────────────────

const ROUND_PACKET = {
  patchset: { id: "ps-1", createdAt: "", truncated: false, files: [] },
  successorAccount: { asks: [] },
} as unknown as DeltaPacket;

const lintContextFor = (lens: LintTarget): LintContext => ({ lens, hunks: [], files: new Map() });
const readPrompt = (file: string): string => `PROMPT_FILE:${file}`;
const lensFromPrompt = (prompt: string): string =>
  /PROMPT_FILE:prompts\/([a-z-]+)\.md/.exec(prompt)?.[1] ?? "unknown";
const cleanBody = (lens: string): DraftBoard =>
  ({
    elements: [
      {
        id: `${lens}-p1`,
        kind: "prose",
        data: { author: { kind: "lens-agent", id: `${lens}-seat` }, markdown: "Reads cleanly." },
      },
    ],
  }) as unknown as DraftBoard;

/** A fake Claude port answering a lens-appropriate clean board every turn. */
function fakeClaudePort(): HarnessPort {
  return {
    createSession: async () => {
      const capture: { prompt?: string } = {};
      return {
        send: async (input: { prompt: string }) => {
          capture.prompt = input.prompt;
        },
        close: async () => {
          /* nothing to release */
        },
        events: (async function* () {
          yield {
            kind: "session.ended",
            native: {},
            outcome: {
              status: "completed",
              structuredOutput: cleanBody(lensFromPrompt(capture.prompt ?? "")),
            },
          };
        })(),
      } as unknown as Awaited<ReturnType<HarnessPort["createSession"]>>;
    },
  } as unknown as HarnessPort;
}

/** A fake boards runtime that mints sequential board ids and counts mints, so the
 *  E2E can prove a re-entry drafts the boards exactly ONCE (no double-start). */
function fakeBoardsRuntimeFor(mints: { count: number }) {
  return (): Pick<BoardsRuntime, "service" | "createRennetBoard"> =>
    ({
      service: { apply: async () => ({ ok: true }) },
      createRennetBoard: async () => `board:${mints.count++}`,
    }) as unknown as Pick<BoardsRuntime, "service" | "createRennetBoard">;
}

const PREV_GEN: Generation = { id: "gen:ps-0", patchsetId: "ps-0", lensBoards: {}, status: "live" };

const TARGET: Target = { branch: "feat/session-rounds", prNumber: 466 };

// An anchored ask thread — canonical session state that must survive the restart
// AND the resume-vanished rebuild (the fallback drops only the harness cursor).
const ANCHORED_THREAD: SessionThread = {
  threadId: "t-1",
  anchor: {
    type: "code",
    ref: {
      patchsetId: "ps-1",
      path: "packages/core/src/session/state.ts",
      side: "head",
      startLine: 42,
      endLine: 42,
    },
  },
  ask: {
    intent: "rework",
    exitLane: "dispatch-round",
    provenance: "board:flagged",
    lifecycle: "dispatched",
  },
} as unknown as SessionThread;

describe("B09 packet E2E — kill mid-generation, restart, reattach, boards canonical", () => {
  let root: string;
  let sessionDir: string;
  let metaDir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "b09-e2e-"));
    sessionDir = join(root, "sessions");
    metaDir = join(root, "board-meta");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("resumes from the persisted cursor, does not double-start the pipeline, and reconstructs boards intact", async () => {
    // ── HOST 1 boots ──────────────────────────────────────────────────────────
    const store1 = new SessionStore(sessionDir);
    const metaStore1 = new BoardMetaStore(metaDir);

    // 1. A row-click mints a session AND claims the target in one act (persisted).
    const entry1 = new SessionEntry({ list: () => store1.list(), save: (s) => store1.save(s) });
    const { session, reattached } = entry1.enter("proj", TARGET);
    expect(reattached).toBe(false);
    expect(session.claim).toEqual({ branch: "feat/session-rounds", prNumber: 466 });

    // Attach a mid-review harness cursor + an anchored ask thread, then persist —
    // the durable state a kill must not lose.
    const live: SessionModel = {
      ...session,
      harnessCursor: {
        harnessSessionId: "harness-live-77",
        lastAssistantMessageAnchor: "anchor-9",
        turnCount: 9,
      },
      threads: [ANCHORED_THREAD],
    };
    store1.save(live);

    // 2. A round drafts the boards and persists each board's meta durably. A
    //    RE-ENTRY resolving to the SAME patchset generation must NOT re-draft: the
    //    rounds runtime routes the drafting through the PipelineStartGuard keyed on
    //    (session, generation), so the second round reuses the first run's boards.
    const mints = { count: 0 };
    const runtime = createRoundsRuntime({
      resolveClaudePort: async () => fakeClaudePort(),
      resolveCodexExecutor: async () => null as CodexExecutor | null,
      boardsRuntimeFor: fakeBoardsRuntimeFor(mints),
      readPrompt,
      persistBoardMeta: (_repo, meta: BoardMeta) => metaStore1.save(meta),
    });

    const roundInput = {
      session: live,
      repoRoot: root,
      previousGeneration: PREV_GEN,
      asksDispatched: ["t-1"],
      // Both rounds land the SAME patchset ps-1 ⇒ the same board generation gen:ps-1.
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-1" }),
      deltaPacket: ROUND_PACKET,
      hunks: [],
      lintContextFor,
    };

    const first = await runtime.runRound(roundInput);
    const mintsAfterFirst = mints.count;
    expect(mintsAfterFirst).toBe(6); // report + five lenses, minted once
    expect(first.record.boardGeneration).toBe("gen:ps-1");

    // Re-entry mid-generation: a second round resolving to the same generation.
    // POSITIVE-CONTROL SURFACE: with the guard removed this re-drafts (mints jump
    // to 12) and the assertion below reddens.
    const second = await runtime.runRound(roundInput);
    expect(mints.count).toBe(mintsAfterFirst); // no re-draft — the guard deduped
    expect(second.record.boardGeneration).toBe("gen:ps-1");
    expect(runtime.ledger(live.id)).toHaveLength(2);

    // Each of the six boards persisted its coverage/blemish meta durably.
    expect(metaStore1.list()).toHaveLength(6);

    // ── KILL + RESTART: fresh stores over the SAME dirs (a new process) ─────────
    const store2 = new SessionStore(sessionDir);
    const metaStore2 = new BoardMetaStore(metaDir);

    // 3. Reattach: the very same row-click reattaches to the persisted session —
    //    no second mint. The cursor, the claim, and the anchored thread survived.
    const entry2 = new SessionEntry({ list: () => store2.list(), save: (s) => store2.save(s) });
    const rejoin = entry2.enter("proj", TARGET);
    expect(rejoin.reattached).toBe(true);
    expect(rejoin.session.id).toBe(session.id);
    expect(rejoin.session.harnessCursor?.harnessSessionId).toBe("harness-live-77");
    expect(rejoin.session.harnessCursor?.turnCount).toBe(9);
    expect(rejoin.session.claim).toEqual({ branch: "feat/session-rounds", prNumber: 466 });
    expect(rejoin.session.threads).toHaveLength(1);

    // The boards reconstruct intact from the persisted meta — coverage survived.
    expect(metaStore2.list()).toHaveLength(6);
  });

  it("a vanished harness transcript triggers the context_rebuilt fallback with boards canonical", async () => {
    // A fresh restart reloads the same on-disk session (cursor + claim + thread).
    const store = new SessionStore(sessionDir);
    const metaStore = new BoardMetaStore(metaDir);
    const reloaded = store.list().find((s) => s.archivedAt === undefined);
    if (reloaded === undefined) throw new Error("E2E: no session on disk to reload");
    expect(reloaded.harnessCursor?.harnessSessionId).toBe("harness-live-77");

    // Boards on disk BEFORE the rebuild — the canonical set the fallback must keep.
    const boardsBefore = metaStore
      .list()
      .map((m) => m.boardId)
      .sort();
    expect(boardsBefore).toHaveLength(6);

    // A turn that RESUMES the persisted (now-vanished) transcript fails
    // invalid-request; the fresh turn (no resume) succeeds and re-mints the cursor.
    const resumeRefused: SessionOutcome = {
      status: "failed",
      error: {
        class: "invalid-request",
        origin: "harness",
        message: "resume rejected: no conversation found",
        retryable: false,
        retryableSource: "inferred",
        // The SDK's terminal resume-refusal subtype, preserved by the real adapter (F4).
        nativeCode: "error_during_execution",
      },
    };
    const port: HarnessPort = {
      createSession: async (spec: SessionSpec) => {
        const outcome: SessionOutcome =
          spec.resume !== undefined
            ? resumeRefused
            : {
                status: "completed",
                finalText: "rebuilt",
                harnessSessionId: "harness-fresh",
                lastAssistantMessageAnchor: "anchor-fresh",
              };
        return {
          send: async () => {
            /* prompt ignored — the outcome is fixed by resume presence */
          },
          close: async () => {
            /* nothing to release */
          },
          events: (async function* () {
            yield { kind: "session.ended", outcome } as unknown;
          })(),
        } as unknown as Awaited<ReturnType<HarnessPort["createSession"]>>;
      },
    } as unknown as HarnessPort;

    const rows: TurnRow[] = [];
    const loop = new SessionTurnLoop({
      port,
      store: { load: (id) => store.load(id), save: (s) => store.save(s) },
      buildSpec: (s) => ({ cwd: `/repo/${s.id}` }),
      emit: (r) => rows.push(r),
    });

    const { session: after, outcome, contextRebuilt } = await loop.runTurn(reloaded.id, "continue");

    // The honest fallback fired: one context_rebuilt row, cursor re-minted turn 1.
    expect(contextRebuilt).toBe(true);
    expect(outcome.status).toBe("completed");
    expect(rows).toEqual([
      {
        kind: "context_rebuilt",
        reason: "the harness no longer has this conversation's transcript",
      },
    ]);
    expect(after.harnessCursor).toEqual({
      harnessSessionId: "harness-fresh",
      lastAssistantMessageAnchor: "anchor-fresh",
      turnCount: 1,
    });

    // BOARDS CANONICAL: the fallback dropped only the cursor. The board meta on
    // disk is untouched, and the session's claim + anchored thread survived.
    // POSITIVE-CONTROL SURFACE: a fallback that dropped the boards reddens here.
    expect(
      metaStore
        .list()
        .map((m) => m.boardId)
        .sort(),
    ).toEqual(boardsBefore);
    expect(after.claim).toEqual({ branch: "feat/session-rounds", prNumber: 466 });
    expect(after.threads).toHaveLength(1);
  });
});
