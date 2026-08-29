import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore } from "@rennet/adapters";
import type { HarnessEvent } from "@rennet/core";
import type {
  Review,
  RoundLedgerRecord,
  RoundRecord,
  SessionModel,
  SessionTranscript,
} from "@rennet/protocol";
import { parseCommandOutput, ROUND_NO_REGEN, RoundReportBoardSchema } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createDispatchRuntime, type DispatchDeps } from "./dispatch";
import { sessionHandlers } from "./dispatch/session";
import { buildProjectionContext, projectCommandOutput } from "./projection";
import { resolveRoundSessionId } from "./session/session-entry";
import { createTranscriptCapture } from "./session/turn-capture";

// The SESSION READ seam (session.transcript + session.rounds). Positive
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
  const REPORT = RoundReportBoardSchema.parse({
    lens: "report",
    generation: RECORD.boardGeneration,
    boardId: RECORD.reportBoard,
    document: {
      title: "The retry boundary now settles",
      introMarkdown: "The staged request was addressed.",
      measure: "reading",
    },
    sections: [{ ref: "outcomes", gist: "One ask addressed.", counts: { outcomes: 1 } }],
    elements: [
      {
        id: "outcomes",
        kind: "section",
        data: {
          author: { kind: "lens-agent", id: "report-seat" },
          title: "Outcomes",
          children: ["outcome-1"],
        },
      },
      {
        id: "outcome-1",
        kind: "round_outcome",
        data: {
          author: { kind: "lens-agent", id: "report-seat" },
          status: "addressed",
          ask: { ref: "ask-1", text: "Cap the retry loop." },
          note: "The loop now stops at the configured cap.",
        },
      },
    ],
    skippedHunks: [],
  });

  it("projects the live runtime's REAL records when the ledger is seeded", async () => {
    const out = (await harness({ roundRecordsForReview: () => [RECORD] })["session.rounds"]({
      reviewId: REVIEW_ID,
    })) as { records: RoundRecord[] };
    expect(out.records).toEqual([RECORD]);
    expect(() => parseCommandOutput("session.rounds", out)).not.toThrow();
  });

  it("enriches each row from the exact report board id named by that row", async () => {
    const lookups: [string, string][] = [];
    const out = (await harness({
      roundRecordsForReview: () => [RECORD],
      reportBoardForReview: async (reviewId, reportBoardId) => {
        lookups.push([reviewId, reportBoardId]);
        return REPORT;
      },
    })["session.rounds"]({ reviewId: REVIEW_ID })) as { records: RoundLedgerRecord[] };

    expect(lookups).toEqual([[REVIEW_ID, RECORD.reportBoard]]);
    expect(out.records[0]?.report).toEqual(REPORT);
    expect(() => parseCommandOutput("session.rounds", out)).not.toThrow();
  });

  it("does not attempt a report lookup for an honest no-report row", async () => {
    let lookedUp = false;
    const noReport = {
      ...RECORD,
      boardGeneration: ROUND_NO_REGEN,
      reportBoard: ROUND_NO_REGEN,
    };
    const out = (await harness({
      roundRecordsForReview: () => [noReport],
      reportBoardForReview: async () => {
        lookedUp = true;
        return REPORT;
      },
    })["session.rounds"]({ reviewId: REVIEW_ID })) as { records: RoundLedgerRecord[] };

    expect(lookedUp).toBe(false);
    expect(out.records[0]?.report).toBeUndefined();
  });

  it("returns an honest empty ledger when nothing recorded (empty-until-runRound)", async () => {
    const out = (await harness({ roundRecordsForReview: () => [] })["session.rounds"]({
      reviewId: REVIEW_ID,
    })) as { records: RoundRecord[] };
    expect(out.records).toEqual([]);
  });

  // ── The ROUND DIFF the ledger's control needs (#571) ────────────────────────
  //
  // The defect this replaces: the ledger rendered a live "Round diff" button that landed on
  // "isn't wired yet", blaming a per-round patchset projection that does not exist. It never
  // needed one. `RoundRecord.diff` is the checkpoint-measured diff of the round's own coding
  // turn, written by the dispatch path and PRESERVED by `RoundRecordStore.record` when the
  // regeneration record supersedes the placeholder — so it is already stored, already durable,
  // and already on this read. All the read had to do was split it per file.
  const ROUND_DIFF = [
    "diff --git a/packages/core/src/rennet.ts b/packages/core/src/rennet.ts",
    "index 1111111..2222222 100644",
    "--- a/packages/core/src/rennet.ts",
    "+++ b/packages/core/src/rennet.ts",
    "@@ -1,2 +1,2 @@",
    " const curd = true;",
    "-const whey = 1;",
    "+const whey = 2;",
    "diff --git a/packages/core/src/added.ts b/packages/core/src/added.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/packages/core/src/added.ts",
    "@@ -0,0 +1,1 @@",
    "+export const added = true;",
    "",
  ].join("\n");

  it("splits the round's captured diff into per-file patches the diff surface renders", async () => {
    const dispatched: RoundRecord = { ...RECORD, outcome: "completed", diff: ROUND_DIFF };
    const out = (await harness({ roundRecordsForReview: () => [dispatched] })["session.rounds"]({
      reviewId: REVIEW_ID,
    })) as { records: RoundRecord[] };
    const files = out.records[0]?.diffFiles;
    // Both files, code-unit sorted, with their status and counts read off the diff itself.
    expect(files?.map((f) => f.path)).toEqual([
      "packages/core/src/added.ts",
      "packages/core/src/rennet.ts",
    ]);
    expect(files?.[0]?.status).toBe("added");
    expect(files?.[1]?.status).toBe("modified");
    expect(files?.[1]?.additions).toBe(1);
    expect(files?.[1]?.deletions).toBe(1);
    // The patch text is the file's own block — what `parsePatch` turns into hunks.
    expect(files?.[1]?.patch).toContain("+const whey = 2;");
    expect(files?.[1]?.patch).not.toContain("added.ts");
    // …and the whole thing still validates as the registered output shape.
    expect(() => parseCommandOutput("session.rounds", out)).not.toThrow();
  });

  it("leaves the raw diff on the record — the split is additive, not a swap", async () => {
    const dispatched: RoundRecord = { ...RECORD, diff: ROUND_DIFF };
    const out = (await harness({ roundRecordsForReview: () => [dispatched] })["session.rounds"]({
      reviewId: REVIEW_ID,
    })) as { records: RoundRecord[] };
    expect(out.records[0]?.diff).toBe(ROUND_DIFF);
  });

  // Absent-not-empty: a regeneration-only round captured no diff, and the read says so by
  // omission rather than by an empty array that reads as "this round changed nothing". The
  // ledger keys its control off exactly this, so an empty array here would put the dead
  // button back — with a diff surface showing zero files behind it.
  it("a round that captured NO diff gets no diffFiles at all", async () => {
    const out = (await harness({ roundRecordsForReview: () => [RECORD] })["session.rounds"]({
      reviewId: REVIEW_ID,
    })) as { records: RoundRecord[] };
    expect(out.records[0]?.diff).toBeUndefined();
    expect(out.records[0]).not.toHaveProperty("diffFiles");
  });

  it("an empty-string diff is not a file list — it gets no diffFiles either", async () => {
    const empty: RoundRecord = { ...RECORD, diff: "" };
    const out = (await harness({ roundRecordsForReview: () => [empty] })["session.rounds"]({
      reviewId: REVIEW_ID,
    })) as { records: RoundRecord[] };
    expect(out.records[0]).not.toHaveProperty("diffFiles");
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

describe("the captured transcript, end to end: capture sink → durable store → dispatch read", () => {
  // The defect this covers: turns were captured, fsynced, and read by NOBODY, so nothing
  // downstream of the sink was ever exercised past a hand-built row array. This drives the
  // REAL sink into the REAL `TranscriptStore` on disk and reads it back through the REAL
  // `session.transcript` handler — no stub sink, no injected row fixture.
  const HOST_PATH = "/Volumes/nimbus/dev/acme/src/a.ts";

  async function capturedTranscript(): Promise<SessionTranscript> {
    const store = new TranscriptStore(mkdtempSync(join(tmpdir(), "rennet-transcript-read-")));
    const capture = createTranscriptCapture(store);
    capture({
      sessionId: "sess-1",
      cwd: "/Volumes/nimbus/dev/acme",
      events: [
        {
          seq: 0,
          harness: "claude-code",
          sessionId: "h1",
          turnId: "t1",
          receivedAt: 0,
          native: null,
          kind: "tool.started",
          call: {
            id: "c1",
            name: "Read",
            input: { file_path: HOST_PATH },
            parentToolCallId: null,
            kind: "read",
          },
        },
        {
          seq: 1,
          harness: "claude-code",
          sessionId: "h1",
          turnId: "t1",
          receivedAt: 0,
          native: null,
          kind: "text.message",
          text: "Renamed the export.",
          parentToolCallId: null,
        },
      ] as unknown as HarnessEvent[],
    });
    // The dispatch runtime resolves the session for the review; this fixture's review maps to
    // the one session the capture wrote under.
    const handlers = harness({ transcriptRowsForReview: () => store.read("sess-1") });
    return (await handlers["session.transcript"]({ reviewId: REVIEW_ID })) as SessionTranscript;
  }

  it("serves the coding turn the sink wrote — the read a client can actually render", async () => {
    const out = await capturedTranscript();
    expect(() => parseCommandOutput("session.transcript", out)).not.toThrow();
    const turn = out.rows.find((row) => row.kind === "turn");
    if (turn?.kind !== "turn") throw new Error("expected a captured turn row");
    expect(turn.paragraphs).toEqual(["Renamed the export."]);
    const action = turn.preface?.find((step) => step.kind === "action");
    if (action?.kind !== "action") throw new Error("expected an action step");
    expect(action.label).toBe("Read");
  });

  it("keeps the host path on disk, and the SAME row loses it on the way to a remote client", async () => {
    const out = await capturedTranscript();
    // At rest / to a loopback client: verbatim. This is what the write-time scrub destroyed.
    expect(JSON.stringify(out)).toContain(HOST_PATH);

    // To a PROJECTED client: gone. Same bytes, one boundary later.
    const projectedCtx = buildProjectionContext(["/Volumes/nimbus/dev/acme"], "/Volumes/nimbus");
    const projected = JSON.stringify(projectCommandOutput("session.transcript", out, projectedCtx));
    expect(projected).not.toContain(HOST_PATH);
    expect(projected).not.toContain("/Volumes/nimbus");
    expect(projected).toContain("<acme>/src/a.ts");
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
