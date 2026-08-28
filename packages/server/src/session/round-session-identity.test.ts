import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardMetaStore, SessionStore, TranscriptStore } from "@rennet/adapters";
import type { CodexExecutor, HarnessPort } from "@rennet/core";
import type { ComposedHandoffBundle, Project, Review, SessionModel } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoundsRuntime, type RoundsRuntime } from "../runtime/rounds";
import {
  projectIdForRepoRoot,
  resolveRoundSessionId,
  SessionEntry,
  type Target,
} from "./session-entry";

// ─────────────────────────────────────────────────────────────────────────────
// #580 (both session mints converge on `Project.id`) + #573 (the detached-HEAD
// phantom), proved as ONE lockstep over the REAL durable stores.
//
// The session id is the primary key for FOUR durable things, and a test that checks
// two of them passes while the product goes half-empty. So every assertion below is
// made against all four at once:
//
//   1. The session record itself — the per-session round lock keys on `session.id`,
//      and the harness cursor the turn loop resumes from lives on the record.
//   2. The rounds ledger (`recordRound`/`readRounds`, keyed by session id).
//   3. The display transcript (`TranscriptStore`, keyed by session id).
//   4. Board idempotency (`BoardMetaStore.listForGeneration(session, generation)`).
//
// The bug class is write-id ≠ read-id: `dispatchRound` minted keyed on the repo ROOT
// while the client's New Chat mint keyed on `Project.id` (a `crypto.randomUUID()`),
// so the two could never coincide — total, not intermittent. Every test here carries
// the pre-fix key as an explicit positive control: read with the old key and all four
// go empty.
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_ID = "3f2a1c94-0000-4000-8000-abcdefabcdef"; // a randomUUID, never a path
const WORKSPACE = "/home/dev/workspace";
const REPO_A = "/home/dev/workspace/repo-a";
const REPO_B = "/home/dev/workspace/repo-b";
const GENERATION = "gen:ps-1";

/** A WORKSPACE project: N repo roots → ONE `Project.id` (many-to-one, not invertible). */
const WORKSPACE_PROJECT: Project = {
  id: PROJECT_ID,
  name: "workspace",
  path: WORKSPACE,
  kind: "workspace",
  repoCount: 2,
  branchCount: 2,
  primaryBranch: "main",
  openPath: REPO_A,
  includedRepoPaths: [REPO_A, REPO_B],
  addedAt: "2026-08-28T00:00:00.000Z",
  source: "local",
};

function reviewFor(id: string, repoRoot: string, headRef?: string): Review {
  return {
    id,
    repositoryRoot: repoRoot,
    activePatchsetId: "ps-1",
    patchsets: [{ id: "ps-1", repository: headRef === undefined ? {} : { headRef } }],
    dispositions: [],
    status: "current",
  } as unknown as Review;
}

const WORK_ORDER = {
  tasks: [{ asks: [{ id: "ask-1" }] }],
} as unknown as ComposedHandoffBundle;

// ── The durable substrate: real stores on temp dirs, one set per test ────────

interface Substrate {
  readonly sessions: SessionStore;
  readonly transcripts: TranscriptStore;
  readonly boardMeta: BoardMetaStore;
  readonly rounds: RoundsRuntime;
  readonly entry: SessionEntry;
}

let root: string;
let sub: Substrate;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "session-identity-"));
  const sessions = new SessionStore(join(root, "sessions"));
  const transcripts = new TranscriptStore(join(root, "transcripts"));
  const boardMeta = new BoardMetaStore(join(root, "board-meta"));
  // The durable rounds ledger, wired exactly as `create-server` wires it: the write keys
  // on `input.session.id`, the read keys on whatever `resolveRoundSessionId` answers.
  const ledger = new Map<string, unknown[]>();
  const rounds = createRoundsRuntime({
    // Only the regeneration path (`runRound`) touches these; the dispatch path never does.
    resolveClaudePort: async () => null as HarnessPort | null,
    resolveCodexExecutor: async () => null as CodexExecutor | null,
    boardsRuntimeFor: () => {
      throw new Error("the dispatch path must not reach the boards runtime");
    },
    readPrompt: () => {
      throw new Error("the dispatch path must not read a prompt");
    },
    recordRound: (sessionId, record) => {
      ledger.set(sessionId, [...(ledger.get(sessionId) ?? []), record]);
    },
    readRounds: (sessionId) =>
      (ledger.get(sessionId) ?? []) as ReturnType<RoundsRuntime["ledger"]>[number][],
  });
  sub = {
    sessions,
    transcripts,
    boardMeta,
    rounds,
    entry: new SessionEntry({ list: () => sessions.list(), save: (s) => sessions.save(s) }),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Write all four durable artifacts under one session id — what a round really persists. */
async function recordARound(session: SessionModel): Promise<void> {
  sub.sessions.save({
    ...session,
    harnessCursor: {
      harnessSessionId: "harness-1",
      lastAssistantMessageAnchor: "anchor-1",
      turnCount: 3,
    },
  });
  await sub.rounds.dispatchRound({
    session,
    workOrder: WORK_ORDER,
    runWorkers: async () => ({
      outcome: "completed" as const,
      diff: "diff --git a/a b/a",
      changedPaths: ["a"],
      workerCommitRange: { from: "c0", to: "c1" },
    }),
  });
  sub.transcripts.append(session.id, [
    {
      kind: "turn",
      id: "turn-1",
      speaker: "orchestrator",
      status: "complete",
      paragraphs: ["Ran the work order."],
    },
  ]);
  sub.boardMeta.save({
    lens: "design",
    boardId: `board-${session.id}`,
    skippedHunks: [],
    blemishes: [],
    omissions: [],
    immutability: [],
    session: session.id,
    generation: GENERATION,
  });
}

/** The FOUR durable reads, all keyed on one session id. All four, or the surface lies. */
function fourReads(sessionId: string): {
  session: SessionModel | undefined;
  rounds: number;
  transcript: number;
  boards: number;
} {
  return {
    session: sub.sessions.load(sessionId),
    rounds: sub.rounds.ledger(sessionId).length,
    transcript: sub.transcripts.read(sessionId).length,
    boards: sub.boardMeta.listForGeneration(sessionId, GENERATION).length,
  };
}

function expectAllFourAnswer(sessionId: string): void {
  const read = fourReads(sessionId);
  expect(read.session?.id).toBe(sessionId); // the lock's key + the harness cursor's home
  expect(read.session?.harnessCursor?.turnCount).toBe(3);
  expect(read.rounds).toBe(1);
  expect(read.transcript).toBe(1);
  expect(read.boards).toBe(1);
}

function expectAllFourEmpty(sessionId: string): void {
  const read = fourReads(sessionId);
  expect(read.session).toBeUndefined();
  expect(read.rounds).toBe(0);
  expect(read.transcript).toBe(0);
  expect(read.boards).toBe(0);
}

// ── projectIdForRepoRoot — the ONE key ───────────────────────────────────────

describe("projectIdForRepoRoot — the key both mints converge on (#580)", () => {
  it("answers the SAME Project.id for every repo of a workspace (N roots → one id)", () => {
    expect(projectIdForRepoRoot(REPO_A, [WORKSPACE_PROJECT])).toBe(PROJECT_ID);
    expect(projectIdForRepoRoot(REPO_B, [WORKSPACE_PROJECT])).toBe(PROJECT_ID);
    expect(projectIdForRepoRoot(WORKSPACE, [WORKSPACE_PROJECT])).toBe(PROJECT_ID);
  });

  it("falls back to the root itself when NO stored project covers it (honestly ungrouped)", () => {
    expect(projectIdForRepoRoot("/home/dev/loose-repo", [WORKSPACE_PROJECT])).toBe(
      "/home/dev/loose-repo",
    );
  });

  it("is SOURCE-SCOPED: a remote project carrying the same path never answers for a local review", () => {
    const onWsl: Project = { ...WORKSPACE_PROJECT, id: "wsl-project", source: "wsl:Ubuntu" };
    expect(projectIdForRepoRoot(REPO_A, [onWsl])).toBe(REPO_A);
    // With both stored, the LOCAL one wins — the review's path is on this host.
    expect(projectIdForRepoRoot(REPO_A, [onWsl, WORKSPACE_PROJECT])).toBe(PROJECT_ID);
  });
});

// ── The convergence + the four-key lockstep ──────────────────────────────────

describe("both mints converge on one session, and all four durable reads answer (#580)", () => {
  const TARGET: Target = { branch: "feat/seam" };

  it("the New Chat mint and the round mint reach the SAME session, and it groups under the project", async () => {
    // The CLIENT mint: a `Project.id` and a branch — the row carries no host path (R19),
    // so the session is minted UNSTAMPED.
    const fromClient = sub.entry.enter(PROJECT_ID, TARGET);
    expect(fromClient.reattached).toBe(false);
    expect(fromClient.session.projectId).toBe(PROJECT_ID);
    expect(fromClient.session.repositoryRoot).toBeUndefined();

    // The ROUND mint, on the same target: same project key, and it KNOWS the repo root.
    // It must reattach — never mint a second session — and stamp the root in place.
    const fromRound = sub.entry.enter(PROJECT_ID, TARGET, REPO_A);
    expect(fromRound.reattached).toBe(true);
    expect(fromRound.session.id).toBe(fromClient.session.id);
    expect(fromRound.session.repositoryRoot).toBe(REPO_A);
    expect(sub.sessions.list()).toHaveLength(1);
    // Grouping: the sidebar keys on `projectId`, so this session now has a home.
    expect(sub.sessions.load(fromRound.session.id)?.projectId).toBe(PROJECT_ID);

    // The read side resolves the very same id...
    const review = reviewFor("review-1", REPO_A, "feat/seam");
    const readId = resolveRoundSessionId(review, sub.sessions.list(), PROJECT_ID);
    expect(readId).toBe(fromRound.session.id);

    // ...and ALL FOUR durable reads answer under it.
    await recordARound(fromRound.session);
    expectAllFourAnswer(readId);

    // POSITIVE CONTROL — the pre-fix key. Read with the repo ROOT as the project key (what
    // `dispatchRound` used to mint with) and the resolution falls through to the review id,
    // under which all four are simultaneously empty. That is the reported bug, exactly.
    const preFixId = resolveRoundSessionId(review, sub.sessions.list(), REPO_A);
    expect(preFixId).toBe("review-1");
    expectAllFourEmpty(preFixId);
  });

  it("a session claimed on branch X still resolves for a review whose head is X (#587's binding)", () => {
    // The property #587 rides on, held for BOTH an unstamped (New Chat) session and a
    // stamped (round-dispatched) one: claim-matching semantics are untouched by the key change.
    const unstamped = sub.entry.enter(PROJECT_ID, { branch: "feat/x", prNumber: 7 }).session;
    const review = reviewFor("review-x", REPO_A, "feat/x");
    expect(resolveRoundSessionId(review, sub.sessions.list(), PROJECT_ID)).toBe(unstamped.id);

    // And by PR number alone — a branch and its PR are ONE claimed thing.
    const byPr = reviewFor("review-pr", REPO_A, "some-other-ref");
    const withPostTarget = { ...byPr, postTarget: { number: 7 } } as unknown as Review;
    expect(resolveRoundSessionId(withPostTarget, sub.sessions.list(), PROJECT_ID)).toBe(
      unstamped.id,
    );
  });
});

// ── The cardinality trap ─────────────────────────────────────────────────────

describe("a workspace's per-repo rounds never collapse into one ledger (#580 cardinality)", () => {
  it("two repos in ONE project sharing a branch name keep separate sessions and separate ledgers", async () => {
    // Both repos are in the same workspace ⇒ the SAME Project.id. Only the repo root
    // separates them, which is why the session has to keep it.
    const inA = sub.entry.enter(PROJECT_ID, { branch: "main" }, REPO_A).session;
    const inB = sub.entry.enter(PROJECT_ID, { branch: "main" }, REPO_B).session;
    expect(inB.id).not.toBe(inA.id);
    expect(sub.sessions.list()).toHaveLength(2);

    await recordARound(inA);

    // The read stays REPO-PRECISE in both directions.
    const reviewA = reviewFor("review-a", REPO_A, "main");
    const reviewB = reviewFor("review-b", REPO_B, "main");
    expect(resolveRoundSessionId(reviewA, sub.sessions.list(), PROJECT_ID)).toBe(inA.id);
    expect(resolveRoundSessionId(reviewB, sub.sessions.list(), PROJECT_ID)).toBe(inB.id);

    // Repo B's round is honestly empty — it never ran one. It does NOT inherit A's.
    expect(sub.rounds.ledger(inB.id)).toHaveLength(0);
    expect(sub.rounds.ledger(inA.id)).toHaveLength(1);
  });

  it("two same-named branches in one workspace are two targets, not one (the row's owner/name)", () => {
    // The New Chat mint knows the row's `owner/name` and cannot know a host path. Without that
    // identity both clicks collapse onto ONE session and the second row opens the first's chat.
    const inA = sub.entry.enter(PROJECT_ID, { branch: "main", repository: "acme/repo-a" });
    const inB = sub.entry.enter(PROJECT_ID, { branch: "main", repository: "acme/repo-b" });
    expect(inB.reattached).toBe(false);
    expect(inB.session.id).not.toBe(inA.session.id);
    expect(sub.sessions.list()).toHaveLength(2);
    // Re-clicking repo A's row still reattaches — discrimination is not amnesia.
    const again = sub.entry.enter(PROJECT_ID, { branch: "main", repository: "acme/repo-a" });
    expect(again.reattached).toBe(true);
    expect(again.session.id).toBe(inA.session.id);
    expect(sub.sessions.list()).toHaveLength(2);
  });

  it("the repository tiebreak excludes ONLY on a positive contradiction (never on silence)", () => {
    // Over-tightening is the worse failure: it stops existing sessions resolving, which is the
    // four-empty-reads bug. So neither side's silence may exclude.
    const silentSession = sub.entry.enter(PROJECT_ID, { branch: "main" }).session;
    expect(silentSession.repository).toBeUndefined();

    // A caller that NAMES a repository still reattaches to a session that carries none...
    const named = sub.entry.enter(PROJECT_ID, { branch: "main", repository: "acme/repo-a" });
    expect(named.reattached).toBe(true);
    expect(named.session.id).toBe(silentSession.id);
    // ...and stamps it in place, so the session stops being ambiguous from here on.
    expect(named.session.repository).toBe("acme/repo-a");

    // A caller that names NOTHING still reattaches to a session that carries one.
    const silentCaller = sub.entry.enter(PROJECT_ID, { branch: "main" });
    expect(silentCaller.reattached).toBe(true);
    expect(silentCaller.session.id).toBe(silentSession.id);

    // Only a positive contradiction excludes.
    const other = sub.entry.enter(PROJECT_ID, { branch: "main", repository: "acme/repo-b" });
    expect(other.reattached).toBe(false);
    expect(sub.sessions.list()).toHaveLength(2);
  });

  it("the read path still resolves a repository-stamped session (it names no repository)", async () => {
    // `resolveRoundSessionId` has a path, not an `owner/name`, so it names no repository — and
    // by the silence rule that must never exclude. A stamped session still answers all four.
    const minted = sub.entry.enter(PROJECT_ID, { branch: "main", repository: "acme/repo-a" });
    const stamped = sub.entry.enter(
      PROJECT_ID,
      { branch: "main", repository: "acme/repo-a" },
      REPO_A,
    ).session;
    expect(stamped.id).toBe(minted.session.id);

    const readId = resolveRoundSessionId(
      reviewFor("review-a", REPO_A, "main"),
      sub.sessions.list(),
      PROJECT_ID,
    );
    expect(readId).toBe(stamped.id);
    await recordARound(stamped);
    expectAllFourAnswer(readId);
  });

  it("prefers the exact repo over an UNSTAMPED session, and never over another repo's", () => {
    const stampedForB = sub.entry.enter(PROJECT_ID, { branch: "main" }, REPO_B).session;
    // A second session on the same claim, unstamped (a New Chat click before any round).
    const unstamped: SessionModel = {
      id: "unstamped-1",
      projectId: PROJECT_ID,
      claim: { branch: "main" },
      threads: [],
      createdAt: 2,
    };
    sub.sessions.save(unstamped);

    // A review in repo A must take the unstamped one, never the one stamped for repo B.
    const readA = resolveRoundSessionId(
      reviewFor("review-a", REPO_A, "main"),
      sub.sessions.list(),
      PROJECT_ID,
    );
    expect(readA).toBe("unstamped-1");
    // A review in repo B takes its EXACT match, not the unstamped one.
    const readB = resolveRoundSessionId(
      reviewFor("review-b", REPO_B, "main"),
      sub.sessions.list(),
      PROJECT_ID,
    );
    expect(readB).toBe(stampedForB.id);
  });

  it("an AMBIGUOUS unstamped fallback is declined, never guessed", async () => {
    // The path the `owner/name` tiebreak alone does not cover, and it is the same bug one step
    // later. Two New Chat clicks name two repos, so two rootless sessions exist; the round
    // dispatch that follows has a PATH and no `owner/name`, so it excludes neither of them.
    // Taking `live[0]` there is a coin flip that files repo B's rounds under repo A's session
    // AND stamps repo B's root onto it — a wrong-project ledger, which is worse than an empty
    // one, plus a session permanently claiming to be both repos at once.
    const inA = sub.entry.enter(PROJECT_ID, { branch: "main", repository: "acme/repo-a" }).session;
    const inB = sub.entry.enter(PROJECT_ID, { branch: "main", repository: "acme/repo-b" }).session;
    expect(inA.repositoryRoot).toBeUndefined();
    expect(inB.repositoryRoot).toBeUndefined();

    // The read declines rather than guessing. Before the guard this answered whichever of the
    // two the store happened to list first — the answer was decided by store order, which is
    // the definition of a coin flip. Now it is honestly the review's own id.
    const readB = resolveRoundSessionId(
      reviewFor("review-b", REPO_B, "main"),
      sub.sessions.list(),
      PROJECT_ID,
    );
    expect(readB).not.toBe(inA.id);
    expect(readB).not.toBe(inB.id);
    expect(readB).toBe("review-b");

    // The dispatch mints its OWN session rather than hijacking repo A's, and repo A's session
    // is left exactly as it was — not silently re-stamped for a repo it does not live in.
    const dispatched = sub.entry.enter(PROJECT_ID, { branch: "main" }, REPO_B);
    expect(dispatched.reattached).toBe(false);
    expect(dispatched.session.id).not.toBe(inA.id);
    expect(dispatched.session.repositoryRoot).toBe(REPO_B);
    expect(sub.sessions.load(inA.id)?.repositoryRoot).toBeUndefined();

    // And it is self-healing: now root-stamped, it resolves EXACTLY from here on, and all four
    // durable reads answer under that one id.
    const readAgain = resolveRoundSessionId(
      reviewFor("review-b", REPO_B, "main"),
      sub.sessions.list(),
      PROJECT_ID,
    );
    expect(readAgain).toBe(dispatched.session.id);
    await recordARound(dispatched.session);
    expectAllFourAnswer(readAgain);
  });

  it("a SINGLE unstamped session is still the fallback — declining is not amnesia", () => {
    // The over-tightening control. One unstamped candidate is unambiguous, so it must still
    // resolve; if this ever flips to the review id, that is the four-empty-reads bug returning.
    const only = sub.entry.enter(PROJECT_ID, { branch: "main", repository: "acme/repo-a" }).session;
    const readA = resolveRoundSessionId(
      reviewFor("review-a", REPO_A, "main"),
      sub.sessions.list(),
      PROJECT_ID,
    );
    expect(readA).toBe(only.id);
  });
});

// ── #573: the detached-HEAD phantom ──────────────────────────────────────────

describe("the detached-HEAD round's session is REAL, not a phantom (#573)", () => {
  it("persists a session under the review id, resolves it back, and answers all four reads", async () => {
    const review = reviewFor("review-detached", REPO_A); // no headRef ⇒ detached HEAD
    const entered = sub.entry.enterDetached(PROJECT_ID, review.id, REPO_A);
    expect(entered.reattached).toBe(false);

    // The phantom's whole defect: the session was never SAVED. It is now.
    expect(sub.sessions.load(review.id)).toBeDefined();
    expect(sub.sessions.list().map((s) => s.id)).toContain(review.id);
    // And it groups under the sidebar's project row, like every other session.
    expect(entered.session.projectId).toBe(PROJECT_ID);
    expect(entered.session.repositoryRoot).toBe(REPO_A);
    // No claim: there is no branch to claim, and none is invented.
    expect(entered.session.claim).toBeUndefined();

    // The no-branch read path resolves the same id, and all four artifacts answer.
    const readId = resolveRoundSessionId(review, sub.sessions.list(), PROJECT_ID);
    expect(readId).toBe(review.id);
    await recordARound(entered.session);
    expectAllFourAnswer(readId);
  });

  it("a second dispatch reattaches — one session per detached review, so rounds serialize", () => {
    const review = reviewFor("review-detached", REPO_A);
    const first = sub.entry.enterDetached(PROJECT_ID, review.id, REPO_A);
    const again = sub.entry.enterDetached(PROJECT_ID, review.id, REPO_A);
    expect(again.reattached).toBe(true);
    expect(again.session.id).toBe(first.session.id);
    expect(sub.sessions.list()).toHaveLength(1);
  });
});
