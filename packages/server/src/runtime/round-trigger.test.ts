import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexExecutor, HarnessPort } from "@rennet/core";
import type {
  DraftBoard,
  Generation,
  PatchFile,
  Patchset,
  SessionModel,
  SuccessorAccount,
} from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BoardsRuntime, createBoardsRuntime } from "../boards/boards-runtime";
import { assembleRoundCollation } from "./round-collation";
import { createRoundsRuntime, mintGeneration } from "./rounds";

// ─────────────────────────────────────────────────────────────────────────────
// C15 task 1.5 — the runRound TRIGGER, integration-tested with FAKE ports (no live
// call). Proves the collation bridge assembled by `assembleRoundCollation` drives
// `runRound` to a minted generation with the round-report drafting BEFORE the
// lenses, and that a trigger with no prior generation still mints gen-1 without
// error (the honest first-generation degrade). The model is the only fake — every
// other seam (boards runtime, generation lifecycle, the round serializer) is real.
// ─────────────────────────────────────────────────────────────────────────────

const PATCH = ["@@ -1,2 +1,2 @@", " const a = 1;", "-const b = 2;", "+const b = 3;"].join("\n");

function patchset(): Patchset {
  const file: PatchFile = {
    path: "src/a.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    patch: PATCH,
  };
  return {
    id: "ps-trigger",
    createdAt: "2026-01-01T00:00:00.000Z",
    repository: {
      id: "repo",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "origin/main",
      baseOid: "0".repeat(40),
      headOid: "1".repeat(40),
    },
    files: [file],
    rawDiff: "",
    byteLength: 0,
    truncated: false,
  };
}

// Records the ORDER seats are asked to draft, and answers a clean board per lens —
// so the test can assert the round-report drafts before any lens (R58/D3).
function orderedFakeClaudePort(order: string[]): HarnessPort {
  const lensFromPrompt = (p: string): string =>
    /PROMPT_FILE:prompts\/([a-z-]+)\.md/.exec(p)?.[1] ?? "unknown";
  const board = (lens: string): DraftBoard =>
    ({
      elements: [
        {
          id: `${lens}-p1`,
          kind: "prose",
          data: { author: { kind: "lens-agent", id: `${lens}-seat` }, markdown: "Reads cleanly." },
        },
      ],
    }) as unknown as DraftBoard;
  return {
    createSession: async () => {
      const cap: { prompt?: string } = {};
      return {
        send: async (input: { prompt: string }) => {
          cap.prompt = input.prompt;
        },
        close: async () => {
          /* nothing to release */
        },
        events: (async function* () {
          const lens = lensFromPrompt(cap.prompt ?? "");
          order.push(lens);
          yield {
            kind: "session.ended",
            native: {},
            outcome: { status: "completed", structuredOutput: board(lens) },
          };
        })(),
      } as unknown as Awaited<ReturnType<HarnessPort["createSession"]>>;
    },
  } as unknown as HarnessPort;
}

const readPrompt = (file: string): string => `PROMPT_FILE:${file}`;
const session: SessionModel = {
  id: "trigger-session",
  projectId: "/repo",
  threads: [],
  createdAt: Date.now(),
} as unknown as SessionModel;

describe("C15 1.5 — runRound trigger over the assembled collation (fake ports)", () => {
  let root: string;
  let boards: BoardsRuntime;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "c15-trigger-"));
    boards = createBoardsRuntime(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function runtimeWith(order: string[]) {
    return createRoundsRuntime({
      resolveClaudePort: async () => orderedFakeClaudePort(order),
      resolveCodexExecutor: async () => null as CodexExecutor | null,
      boardsRuntimeFor: () => ({
        service: boards.service,
        createRennetBoard: boards.createRennetBoard,
      }),
      readPrompt,
    });
  }

  it("mints a new generation with the report drafting before the lenses (a landed round)", async () => {
    const order: string[] = [];
    const successorAccount: SuccessorAccount = { asks: [], beyondAsks: [] };
    const collation = assembleRoundCollation({
      patchset: patchset(),
      knowledge: {
        schemaVersion: 1,
        repoKey: "repo",
        baseOid: "0".repeat(40),
        snapshotFingerprint: "fp",
        generator: "t",
        statements: [],
      },
      dossier: [],
      successorAccount,
    });
    const previousGeneration = mintGeneration("gen:ps-prior", "ps-prior");

    const outcome = await runtimeWith(order).runRound({
      session,
      repoRoot: root,
      previousGeneration,
      asksDispatched: ["t-1"],
      // The worker moved code (a new patchset landed) ⇒ a successor generation mints.
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-landed" }),
      ...collation,
    });

    // A real successor generation minted; the prior froze because the code moved.
    expect(outcome.boardGeneration.id).toBe("gen:ps-landed");
    expect(outcome.frozenPrevious?.id).toBe("gen:ps-prior");
    // The round-report drafted FIRST — before any lens (it gates the regeneration).
    expect(order[0]).toBe("report");
    expect(outcome.pipeline.report?.board).toBeDefined();
    // The lens boards came back too.
    expect(outcome.pipeline.boards.filter((b) => b.board !== undefined).length).toBeGreaterThan(0);
  });

  it("degrades to a first-generation draft when no successor account, without error", async () => {
    const order: string[] = [];
    const collation = assembleRoundCollation({
      patchset: patchset(),
      knowledge: {
        schemaVersion: 1,
        repoKey: "repo",
        baseOid: "0".repeat(40),
        snapshotFingerprint: "fp",
        generator: "t",
        statements: [],
      },
      dossier: [],
      // no successorAccount ⇒ first-generation (non-round): the report does NOT draft first.
    });
    const previousGeneration: Generation = mintGeneration("gen:ps-first", "ps-first");

    const outcome = await runtimeWith(order).runRound({
      session: { ...session, id: "first-gen-session" } as SessionModel,
      repoRoot: root,
      previousGeneration,
      asksDispatched: [],
      // Nothing landed ⇒ re-report against the existing generation, no successor mint.
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c0" } }),
      ...collation,
    });

    // No crash; the existing generation is re-used (nothing landed), no report seat ran.
    expect(outcome.boardGeneration.id).toBe("gen:ps-first");
    expect(outcome.frozenPrevious).toBeUndefined();
    expect(order).not.toContain("report"); // non-round ⇒ report does not gate
  });
});
