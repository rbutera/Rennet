import type { Review, RoundRecord, SessionModel } from "@rennet/protocol";
import { parseCommandOutput } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createDispatchRuntime, type DispatchDeps } from "./dispatch";
import { sessionHandlers } from "./dispatch/session";
import { buildProjectionContext, projectCommandOutput } from "./projection";
import { resolveRoundSessionId } from "./session/session-entry";

// The B9/B10-deferred SESSION READ seam (session.transcript + session.rounds). Positive
// controls: each read returns the REAL projected shape (not a stub error), is dispatch-
// reachable, session.rounds projects a seeded ledger's real records (and is empty unseeded),
// the slug→session resolution lines up with dispatchRound's mint, and a host path smuggled
// into either output is scrubbed by the R19 projection.

const REVIEW_ID = "review-1";

/** A review whose active patchset carries a branch (an own-branch capture). */
const REVIEW = {
  id: REVIEW_ID,
  repositoryRoot: "/home/dev/acme",
  activePatchsetId: "ps-1",
  patchsets: [{ id: "ps-1", repository: { headRef: "feat/seam" } }],
  dispositions: [],
  status: "current",
} as unknown as Review;

function harness(deps: Partial<DispatchDeps> = {}) {
  const rt = createDispatchRuntime({
    service: { reviewById: (id: string) => (id === REVIEW_ID ? REVIEW : undefined) },
    ...deps,
  } as unknown as DispatchDeps);
  return sessionHandlers(rt);
}

describe("session.transcript — the chat dock read (C07, display read-model)", () => {
  it("honest-EMPTY: an unseeded session returns empty coding rows, no context, an identity trail", async () => {
    const out = (await harness()["session.transcript"]({ reviewId: REVIEW_ID })) as {
      trail: { title: string; target?: string; projectName?: string };
      rows: unknown[];
      contextWindow?: unknown;
    };
    // Honest-empty: capability present, but no captured turns yet ⇒ no fabricated content and no
    // invented context figure — NOT a stub error.
    expect(out.rows).toEqual([]);
    expect(out.contextWindow).toBeUndefined();
    // The identity trail is Rennet's to project (branch title, own-branch target, project name).
    expect(out.trail.title).toBe("feat/seam");
    expect(out.trail.target).toBe("your-branch");
    expect(out.trail.projectName).toBe("acme");
    // The output validates against the registry schema (a real, dispatch-reachable shape).
    expect(() => parseCommandOutput("session.transcript", out)).not.toThrow();
  });

  it("honest-PRESENT: serves the captured coding turns when the transcript store has rows", async () => {
    const rows = [
      {
        kind: "turn" as const,
        id: "turn-1",
        speaker: "orchestrator" as const,
        status: "complete" as const,
        paragraphs: ["Read the file."],
        preface: [
          {
            kind: "action" as const,
            id: "act-c1",
            label: "Read",
            detail: "<acme>/src/a.ts",
            status: "complete" as const,
            toolKind: "read" as const,
          },
        ],
      },
    ];
    const out = (await harness({ transcriptRowsForReview: () => rows })["session.transcript"]({
      reviewId: REVIEW_ID,
    })) as { rows: typeof rows };
    expect(out.rows).toEqual(rows);
    // A real coding turn with its action step round-trips the registry schema.
    expect(() => parseCommandOutput("session.transcript", out)).not.toThrow();
  });

  it("derives a teammate-PR trail from a not-viewer-authored post target", async () => {
    const teammate = {
      ...REVIEW,
      postTarget: { number: 7, viewerDidAuthor: false },
    } as unknown as Review;
    const rt = createDispatchRuntime({
      service: { reviewById: () => teammate },
    } as unknown as DispatchDeps);
    const out = (await sessionHandlers(rt)["session.transcript"]({ reviewId: REVIEW_ID })) as {
      trail: { target?: string };
    };
    expect(out.trail.target).toBe("teammate-pr");
  });

  it("is reachable through the whole dispatch table and rejects an unknown review", async () => {
    await expect(harness()["session.transcript"]({ reviewId: "nope" })).rejects.toThrow();
  });
});

describe("session.rounds — the rounds ledger read (C09)", () => {
  const RECORD: RoundRecord = {
    asksDispatched: ["t1"],
    workerCommitRange: { from: "aaa", to: "bbb" },
    boardGeneration: "gen:ps-2",
    reportBoard: "board-9",
  };

  it("projects the live runtime's REAL records when the ledger is seeded", async () => {
    const out = (await harness({ roundRecordsForReview: () => [RECORD] })["session.rounds"]({
      reviewId: REVIEW_ID,
    })) as { records: RoundRecord[] };
    expect(out.records).toEqual([RECORD]);
    expect(() => parseCommandOutput("session.rounds", out)).not.toThrow();
  });

  it("returns an honest empty ledger when nothing recorded (empty-until-runRound)", async () => {
    const out = (await harness({ roundRecordsForReview: () => [] })["session.rounds"]({
      reviewId: REVIEW_ID,
    })) as { records: RoundRecord[] };
    expect(out.records).toEqual([]);
  });
});

describe("resolveRoundSessionId — slug→session resolution (read side of dispatchRound's mint)", () => {
  // The project key both mints converge on (#580) — a `Project.id`, never a path.
  const PROJECT_ID = "3f2a1c94-0000-4000-8000-abcdefabcdef";
  const claim = { branch: "feat/seam" };
  const claimingSession = {
    id: "session-abc",
    projectId: PROJECT_ID,
    claim,
    threads: [],
    createdAt: 1,
  } as unknown as SessionModel;

  it("resolves the session claiming the review's target (branch)", () => {
    expect(resolveRoundSessionId(REVIEW, [claimingSession], PROJECT_ID)).toBe("session-abc");
  });

  it("falls back to the review id when no session claims the target yet", () => {
    expect(resolveRoundSessionId(REVIEW, [], PROJECT_ID)).toBe(REVIEW_ID);
  });

  it("falls back to the review id for a detached HEAD (no branch to claim)", () => {
    const detached = {
      ...REVIEW,
      patchsets: [{ id: "ps-1", repository: {} }],
    } as unknown as Review;
    expect(resolveRoundSessionId(detached, [claimingSession], PROJECT_ID)).toBe(REVIEW_ID);
  });

  it("does not cross-attach a claiming session in another project", () => {
    const otherProject = { ...claimingSession, projectId: "other-project-id" } as SessionModel;
    expect(resolveRoundSessionId(REVIEW, [otherProject], PROJECT_ID)).toBe(REVIEW_ID);
  });

  it("does not cross-attach a session stamped for a DIFFERENT repo in the same project", () => {
    // The cardinality trap: a workspace maps N repo roots to ONE `Project.id`, so the
    // project key alone cannot separate repo-a's rounds from repo-b's.
    const elsewhere = {
      ...claimingSession,
      repositoryRoot: "/home/dev/other-repo",
    } as unknown as SessionModel;
    expect(resolveRoundSessionId(REVIEW, [elsewhere], PROJECT_ID)).toBe(REVIEW_ID);
  });
});

describe("R19 — a host path in either output is scrubbed by the projection", () => {
  const ctx = buildProjectionContext([], "/home/dev");

  it("scrubs a host path smuggled into a session.rounds record", () => {
    const leaked = {
      records: [
        {
          ...{ asksDispatched: [], workerCommitRange: { from: "a", to: "b" } },
          boardGeneration: "g",
          reportBoard: "/home/dev/secret/board",
        },
      ],
    };
    const projected = projectCommandOutput("session.rounds", leaked, ctx) as {
      records: [{ reportBoard: string }];
    };
    expect(projected.records[0].reportBoard).toBe("~/secret/board");
    expect(JSON.stringify(projected)).not.toContain("/home/dev/secret");
  });

  it("scrubs a host path smuggled into the session.transcript trail", () => {
    const leaked = { trail: { title: "/home/dev/secret/repo" }, rows: [] };
    const projected = projectCommandOutput("session.transcript", leaked, ctx) as {
      trail: { title: string };
    };
    expect(projected.trail.title).toBe("~/secret/repo");
  });
});
