import type {
  CommandOutput,
  LensDraftEvent,
  LensKind,
  Review,
  SessionPreparation,
} from "@rennet/protocol";
import { LENS_KINDS, REVIEW_CLI_FEATURE } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  buildReviewDocument,
  foldPreparationLines,
  formatElapsed,
  lensDraftLines,
  MIN_REVIEW_CLI_DAEMON_VERSION,
  parseReviewTarget,
  resolvePrTarget,
  reviewCliUnsupportedMessage,
  reviewDocumentPath,
} from "./cli-review";

describe("parseReviewTarget (tasks.md 2.2)", () => {
  it("parses a branch range", () => {
    const target = parseReviewTarget(["main..feat/x"]);
    expect(target).toMatchObject({ kind: "range", base: "main", head: "feat/x", path: undefined });
  });

  it("parses a range with an absent head (filled at run time)", () => {
    const target = parseReviewTarget(["main.."]);
    expect(target).toMatchObject({ kind: "range", base: "main", head: "" });
  });

  it("parses a range plus a path", () => {
    const target = parseReviewTarget(["main..feat", "../other-repo"]);
    expect(target).toMatchObject({
      kind: "range",
      base: "main",
      head: "feat",
      path: "../other-repo",
    });
  });

  it("parses a tag..HEAD range", () => {
    expect(parseReviewTarget(["v1.2.0..HEAD"])).toMatchObject({
      kind: "range",
      base: "v1.2.0",
      head: "HEAD",
    });
  });

  it("parses a --pr number", () => {
    expect(parseReviewTarget(["--pr", "12"])).toMatchObject({ kind: "pr", number: 12 });
  });

  it("carries --out, --data-dir and --timeout", () => {
    const target = parseReviewTarget([
      "main..feat",
      "--out",
      "/tmp/r.json",
      "--data-dir",
      "/data",
      "--timeout",
      "60",
    ]);
    expect(target).toMatchObject({
      kind: "range",
      out: "/tmp/r.json",
      dataDir: "/data",
      timeoutMs: 60_000,
    });
  });

  it.each([
    ["no target", [] as string[]],
    ["a range without ..", ["main"]],
    ["a non-numeric --pr", ["--pr", "abc"]],
    ["a range and --pr together", ["main..feat", "--pr", "12"]],
    ["two paths in range form", ["main..feat", "one", "two"]],
    ["two positionals with --pr", ["--pr", "12", "one", "two"]],
    ["a non-positive --timeout", ["main..feat", "--timeout", "0"]],
    ["an unknown flag", ["main..feat", "--bogus"]],
  ])("refuses %s with a usage message", (_label, argv) => {
    const target = parseReviewTarget(argv);
    expect(target.kind).toBe("usage");
  });
});

describe("formatElapsed", () => {
  it("floors to whole seconds and never goes negative", () => {
    expect(formatElapsed(0)).toBe("[+0s] ");
    expect(formatElapsed(1999)).toBe("[+1s] ");
    expect(formatElapsed(-50)).toBe("[+0s] ");
  });
});

// ── The preparation-record fold (tasks.md 3.1) ───────────────────────────────

function drafting(lanes: unknown[]): SessionPreparation {
  return { status: "drafting", reviewId: "rev-1", lanes } as unknown as SessionPreparation;
}

const flaggedQueued = { id: "flagged", label: "Flagged", status: "queued" } as const;

describe("foldPreparationLines (tasks.md 3.1)", () => {
  it("prints the first capture step", () => {
    const next: SessionPreparation = { status: "capturing", step: "resolving-repository" };
    expect(foldPreparationLines(undefined, next, 0)).toEqual([
      "[+0s] capturing  resolving repository",
    ]);
  });

  it("prints a changed capture step and nothing when it is unchanged", () => {
    const first: SessionPreparation = { status: "capturing", step: "resolving-repository" };
    const second: SessionPreparation = { status: "capturing", step: "capturing-change" };
    expect(foldPreparationLines(first, second, 1000)).toEqual([
      "[+1s] capturing  capturing change",
    ]);
    expect(foldPreparationLines(second, second, 2000)).toEqual([]);
  });

  it("prints a lane status line and its seat line on a queued→running transition", () => {
    const previous = drafting([flaggedQueued] as never);
    const next = drafting([
      {
        id: "flagged",
        label: "Flagged",
        status: "running",
        seats: [
          {
            seat: "codex-leg",
            provider: "codex",
            latest: { kind: "tool", text: "reading packages/server/src/cli.ts", at: 1 },
          },
        ],
      },
    ] as never);
    expect(foldPreparationLines(previous, next, 3000)).toEqual([
      "[+3s] flagged  running",
      "[+3s] flagged  codex-leg (codex): reading packages/server/src/cli.ts",
    ]);
  });

  it("prints nothing for an unchanged record", () => {
    const record = drafting([flaggedQueued] as never);
    expect(foldPreparationLines(record, record, 5000)).toEqual([]);
  });

  it("prints all three Flagged seats under the one lane name", () => {
    const seatless = drafting([
      { id: "flagged", label: "Flagged", status: "running", seats: [] },
    ] as never);
    const three = drafting([
      {
        id: "flagged",
        label: "Flagged",
        status: "running",
        seats: [
          {
            seat: "claude-leg",
            provider: "claudeAgent",
            latest: { kind: "text", text: "one", at: 1 },
          },
          { seat: "codex-leg", provider: "codex", latest: { kind: "text", text: "two", at: 1 } },
          {
            seat: "compiler",
            provider: "claudeAgent",
            latest: { kind: "text", text: "three", at: 1 },
          },
        ],
      },
    ] as never);
    const lines = foldPreparationLines(seatless, three, 4000);
    expect(lines).toEqual([
      "[+4s] flagged  claude-leg (claudeAgent): one",
      "[+4s] flagged  codex-leg (codex): two",
      "[+4s] flagged  compiler (claudeAgent): three",
    ]);
  });

  it("prints a failed lane's reason once", () => {
    const running = drafting([{ id: "design", label: "Design", status: "running" }] as never);
    const failed = drafting([
      { id: "design", label: "Design", status: "failed", reason: "seat timed out" },
    ] as never);
    expect(foldPreparationLines(running, failed, 6000)).toEqual([
      "[+6s] design  failed  seat timed out",
    ]);
    expect(foldPreparationLines(failed, failed, 7000)).toEqual([]);
  });

  it("prints a done lane with its verdict and an absent lane with its reason", () => {
    const running = drafting([
      { id: "flagged", label: "Flagged", status: "running" },
      { id: "noise", label: "Noise", status: "running" },
    ] as never);
    const settled = drafting([
      { id: "flagged", label: "Flagged", status: "done", verdict: "reworked" },
      { id: "noise", label: "Noise", status: "absent", reason: "no-noise" },
    ] as never);
    expect(foldPreparationLines(running, settled, 8000)).toEqual([
      "[+8s] flagged  done  reworked",
      "[+8s] noise  absent  no-noise",
    ]);
  });
});

// ── The lensDraft-frame fold (tasks.md 3.2) ──────────────────────────────────

function draftEvent(update: unknown): LensDraftEvent {
  return { generation: "g-1", lens: "sequence", revision: 0, update } as unknown as LensDraftEvent;
}

describe("lensDraftLines (tasks.md 3.2)", () => {
  it("prints an element count for an `elements` write", () => {
    const event = draftEvent({
      kind: "elements",
      changed: [{ index: 0 }, { index: 1 }, { index: 2 }],
      removed: [],
    });
    expect(lensDraftLines(event, 2000)).toEqual(["[+2s] sequence  wrote 3 elements"]);
  });

  it("prints the singular for a single element", () => {
    const event = draftEvent({ kind: "elements", changed: [{ index: 0 }], removed: [] });
    expect(lensDraftLines(event, 0)).toEqual(["[+0s] sequence  wrote 1 element"]);
  });

  it("prints the count for a non-empty opened board and nothing for an empty one", () => {
    expect(
      lensDraftLines(draftEvent({ kind: "opened", elements: [{ id: "a" }, { id: "b" }] }), 0),
    ).toEqual(["[+0s] sequence  wrote 2 elements"]);
    expect(lensDraftLines(draftEvent({ kind: "opened", elements: [] }), 0)).toEqual([]);
  });

  it("prints nothing for a state or closed frame", () => {
    expect(lensDraftLines(draftEvent({ kind: "state", state: "settled" }), 0)).toEqual([]);
    expect(lensDraftLines(draftEvent({ kind: "closed", state: "settled" }), 0)).toEqual([]);
  });
});

describe("reviewDocumentPath", () => {
  it("keys the document by review id under reviews/", () => {
    expect(reviewDocumentPath("/data", "rev-9")).toBe("/data/reviews/rev-9.json");
  });
});

// ── The document (tasks.md 3.3) ──────────────────────────────────────────────

function fakeReview(): Review {
  return {
    id: "rev-1",
    repositoryRoot: "/repo",
    activePatchsetId: "ps-1",
    patchsets: [
      {
        id: "ps-1",
        source: "local-branch",
        repository: { baseRef: "main", baseOid: "base000", headOid: "head111", headRef: "feat/x" },
      },
    ],
  } as unknown as Review;
}

function boardRead(over: Partial<CommandOutput<"board.read">>): CommandOutput<"board.read"> {
  return { board: null, ...over } as unknown as CommandOutput<"board.read">;
}

describe("buildReviewDocument (tasks.md 3.3)", () => {
  function boardsWith(
    noise: CommandOutput<"board.read">,
  ): Record<LensKind, CommandOutput<"board.read">> {
    const boards = {} as Record<LensKind, CommandOutput<"board.read">>;
    for (const lens of LENS_KINDS) {
      boards[lens] = lens === "noise" ? noise : boardRead({ board: { generation: "g" } as never });
    }
    return boards;
  }

  it("reads the range off the active patchset and keeps an absent lens absent", () => {
    const document = buildReviewDocument({
      review: fakeReview(),
      sessionId: "sess-1",
      projectId: "proj-1",
      requestedHead: "feat/x",
      rounds: [],
      boards: boardsWith(boardRead({ board: null, absence: "no-noise" })),
      outcome: "settled",
      startedAtMs: 1_700_000_000_000,
      settledAtMs: 1_700_000_030_000,
    });

    expect(document.schemaVersion).toBe(1);
    expect(document.reviewId).toBe("rev-1");
    expect(document.range).toEqual({
      base: "main",
      head: "feat/x",
      baseOid: "base000",
      headOid: "head111",
      source: "local-branch",
    });
    expect(Object.keys(document.boards).sort()).toEqual([...LENS_KINDS].sort());
    // The absent lens carries its typed absence and NO board key (never a fabricated board).
    expect(document.boards.noise).toEqual({ absence: "no-noise" });
    expect(document.boards.noise).not.toHaveProperty("board");
    expect(document.lanes.find((lane) => lane.id === "noise")).toEqual({
      id: "noise",
      status: "absent",
      reason: "no-noise",
    });
    expect(document.outcome).toBe("settled");
  });

  it("records a failure lens as a failed lane with its reason", () => {
    const document = buildReviewDocument({
      review: fakeReview(),
      sessionId: "sess-1",
      projectId: "proj-1",
      requestedHead: "feat/x",
      rounds: [],
      boards: boardsWith(boardRead({ board: null, failure: "seat crashed" })),
      outcome: "failed",
      reason: "seat crashed",
      startedAtMs: 1,
      settledAtMs: 2,
    });
    expect(document.boards.noise).toEqual({ failure: "seat crashed" });
    expect(document.lanes.find((lane) => lane.id === "noise")).toEqual({
      id: "noise",
      status: "failed",
      reason: "seat crashed",
    });
    expect(document.reason).toBe("seat crashed");
  });
});

describe("resolvePrTarget: scope --pr <n> to the standing repo (headless-review-cli D11)", () => {
  const A = { number: 7, repository: "owner/repo-a", branch: "feat/x" };
  const B = { number: 7, repository: "owner/repo-b", branch: "feat/x" };
  const inRepoA = { repository: "owner/repo-a" };
  const inRepoB = { repository: "owner/repo-b" };

  it("finds the standing repo's row when the number is unique within it", () => {
    // The single-repo case: one row, and it is the standing repo's. Byte-identical to the
    // pre-D11 `prs.find(number === n)` for a lone repo.
    expect(resolvePrTarget([A], 7, inRepoA)).toEqual({ kind: "found", row: A });
  });

  it("picks the standing repo's row out of a cross-repo number collision", () => {
    // Two repos both carry #7. The pre-D11 `prs.find` would have taken whichever came first;
    // scoping takes the standing one.
    expect(resolvePrTarget([B, A], 7, inRepoA)).toEqual({ kind: "found", row: A });
    expect(resolvePrTarget([A, B], 7, inRepoB)).toEqual({ kind: "found", row: B });
  });

  it("breaks a same-slug cross-forge collision by forge, never by name", () => {
    // Both rows are `acme/widget#7`, one on GitHub and one on GitLab. Slug alone would scope
    // both (ambiguous); the standing forge identity picks the one the checkout is actually in.
    const gh = {
      number: 7,
      repository: "acme/widget",
      forgeRepository: { forge: "github", owner: "acme", name: "widget" },
    };
    const gl = {
      number: 7,
      repository: "acme/widget",
      forgeRepository: { forge: "gitlab", owner: "acme", name: "widget" },
    };
    expect(
      resolvePrTarget([gh, gl], 7, {
        repository: "acme/widget",
        forgeRepository: { forge: "gitlab", owner: "acme", name: "widget" },
      }),
    ).toEqual({ kind: "found", row: gl });
    // Slug-only comparison would have matched both and refused; forge disambiguation finds one.
    expect(resolvePrTarget([gh, gl], 7, { repository: "acme/widget" })).toEqual({
      kind: "ambiguous",
      candidates: ["acme/widget#7", "acme/widget#7"],
    });
  });

  it("refuses a collision where NONE of the rows is the standing repo, listing every candidate", () => {
    // The exact bug D11 names: `prs.find(number === n)` would have returned repo-a's #7 while
    // the reviewer stands in a THIRD repo. Refuse, and name both real candidates.
    expect(resolvePrTarget([A, B], 7, { repository: "owner/repo-c" })).toEqual({
      kind: "ambiguous",
      candidates: ["owner/repo-a#7", "owner/repo-b#7"],
    });
  });

  it("refuses a single #n that lives only in a sibling repo, not the standing one", () => {
    // A lone #7, but in repo-b, while the reviewer stands in repo-a: `prs.find` would have
    // opened the sibling's PR silently. Scoping refuses and names the one candidate.
    expect(resolvePrTarget([B], 7, inRepoA)).toEqual({
      kind: "ambiguous",
      candidates: ["owner/repo-b#7"],
    });
  });

  it("reports not-listed when no row anywhere carries that number", () => {
    expect(resolvePrTarget([A, B], 9, inRepoA)).toEqual({ kind: "not-listed" });
    expect(resolvePrTarget([], 7, inRepoA)).toEqual({ kind: "not-listed" });
  });
});

describe("reviewCliUnsupportedMessage: connect-time capability gate (headless-review-cli D11)", () => {
  it("passes a daemon that advertises the review-cli feature (returns undefined)", () => {
    expect(reviewCliUnsupportedMessage({ [REVIEW_CLI_FEATURE]: true }, "0.1.5")).toBeUndefined();
    expect(
      reviewCliUnsupportedMessage({ serverRequests: true, [REVIEW_CLI_FEATURE]: true }, "9.9.9"),
    ).toBeUndefined();
  });

  it("refuses a daemon missing the flag, naming the minimum version and the daemon's own version", () => {
    const message = reviewCliUnsupportedMessage({ serverRequests: true }, "0.1.4");
    expect(message).toBeDefined();
    expect(message).toContain(MIN_REVIEW_CLI_DAEMON_VERSION);
    expect(message).toContain("v0.1.4");
  });

  it("refuses a daemon that advertises the flag as false (a deliberate opt-down)", () => {
    expect(reviewCliUnsupportedMessage({ [REVIEW_CLI_FEATURE]: false }, "0.1.5")).toBeDefined();
  });

  it("names an older build when the handshake carried no version", () => {
    const noVersion = reviewCliUnsupportedMessage({ serverRequests: true }, "");
    expect(noVersion).toContain(MIN_REVIEW_CLI_DAEMON_VERSION);
    expect(noVersion).toContain("an older build");
    expect(reviewCliUnsupportedMessage(undefined, undefined)).toContain(
      MIN_REVIEW_CLI_DAEMON_VERSION,
    );
  });
});
