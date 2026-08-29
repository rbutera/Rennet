import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createClaudeHarness,
  createCodexExecutor,
  defaultCodexDiscoveryDeps,
  defaultCodexExecEffects,
  discoverCodex,
} from "@rennet/adapters";
import {
  assertCoverage,
  buildDeltaPacket,
  type CodexExecutor,
  type LintContext,
  type LintHunk,
  type LintTarget,
  selectPacketKnowledge,
} from "@rennet/core";
import {
  type DossierItem,
  type DraftBoard,
  type Generation,
  type Patchset,
  parseDraft,
  type SessionModel,
  type SuccessorAccount,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createBoardsRuntime } from "../boards/boards-runtime";
import { DELTA_DIGEST_OUTPUT_SCHEMA } from "../delta-digest-live";
import { createNodePromptReader } from "./lens-pipeline";
import { createRoundsRuntime } from "./rounds";

// ─────────────────────────────────────────────────────────────────────────────
// C15 task 1.1 — the SMOKE-RUN. The first production exercise of the whole
// model-drafting pipeline: `runRound` → `runLensPipeline` over the REAL Claude +
// Codex ports and the REAL on-disk `@rennet/prompts`. Until C15 nothing in prod
// ever called `runRound` (the live board surface is deterministic
// `buildReviewCanvases`, `canvases: {}`), so the six drafters had NEVER run.
//
// This is intentionally NOT part of the gate: it makes live model calls (six
// drafters + post-process). It runs ONLY under RENNET_SMOKE=1, invoked by hand
// (`RENNET_SMOKE=1 pnpm vitest run rounds-smoke` inside the worktree). The gate
// sees it skipped — zero live calls — while the harness stays committed as the
// evidence that the drafting pipeline executes end to end (task 1.1).
//
// What it proves: runRound completes without crash/hang/auth-wall/shape-mismatch,
// mints a real Generation, and the drafters emit real boards — non-empty elements,
// honest per-lens failures where a seat could not run, and a coverage picture that
// CAN fail. The coverage control runs through the ROUND ITSELF: the round's hunk universe
// carries one hunk no board can teach, so `runRound`'s own verdict must name it, and a
// pipeline that stopped asserting coverage fails here instead of sailing past a
// side-bound `assertCoverage` call that only proved the helper works.
//
// TWO harness-compat fixes were exercised FIRST by this run (both landed as
// discrete adapter commits): (1) strip the draft-2020-12 `$schema` meta the
// installed claude's `--json-schema` ajv rejects; (2) map the council's versioned
// model aliases (`opus-4.8`/`sonnet-5`) to the binary's full ids. Before them,
// every seat failed identically; after, the drafters run.
//
// OBSERVED SEAT BEHAVIOR (characterization, task 1.1, two live runs): with both
// fixes, each run mints the generation and returns FOUR valid boards — report(4),
// design(1), decisions(1), flagged(1-2). Two seats fail the SAME way on BOTH runs,
// so these are SYSTEMATIC per-lens DRAFTING-QUALITY issues, not transient and not
// infra (and not caused by the fixes):
//   • sequence — board write rejected `bad-ref` every run: the sequence drafter
//     emits a board citing an element id that does not exist in the board (a
//     dangling reference the sequence prompt/shape tends to produce). The pipeline
//     correctly REJECTS it (honest, not a swallowed empty). Follow-up: the sequence
//     lens prompt / board shape, not the collation bridge.
//   • noise — the noise seat's initial turn does not emit a board every run. The
//     noise route (`lens-draft-noise`) consistently fails to produce structured
//     output. Follow-up: the noise seat's model route / prompt.
// Both are handled HONESTLY (rejected / recorded, never fabricated) — the doctrine
// working — and are drafting-QUALITY follow-ups tracked OUTSIDE c15 (they do not
// block the collation bridge: the pipeline executes and regeneration data exists).
// This is why the assertion below is the HONEST bar (generation + report + ≥1 valid
// lens board + no swallowed empties), not a brittle all-6-green.
// ─────────────────────────────────────────────────────────────────────────────

const SMOKE = process.env.RENNET_SMOKE === "1";

// A real small one-file patchset — a single edited line, enough for the drafters
// to have a coherent change to reason over.
const PATCH = [
  "@@ -1,3 +1,3 @@",
  " export function greet(name: string): string {",
  "-  return `Hi ${name}`;",
  "+  return `Hello, ${name}!`;",
  " }",
].join("\n");

function smallPatchset(): Patchset {
  return {
    id: "ps-c15-smoke",
    createdAt: "2026-01-01T00:00:00.000Z",
    repository: {
      id: "repo",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "origin/main",
      baseOid: "0".repeat(40),
      headOid: "1".repeat(40),
    },
    files: [
      {
        path: "src/greet.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        binary: false,
        patch: PATCH,
      },
    ],
    rawDiff: "",
    byteLength: 0,
    truncated: false,
  };
}

const KNOWLEDGE = selectPacketKnowledge({
  set: {
    schemaVersion: 1,
    repoKey: "repo",
    baseOid: "0".repeat(40),
    snapshotFingerprint: "fp",
    generator: "c15-smoke",
    statements: [],
  },
  snapshot: null,
  changedPaths: [],
});

const DOSSIER: readonly DossierItem[] = [];

// A successor account makes the packet a ROUND (`isRound`), so the round-report
// drafts FIRST and all six seats run (report + five lenses).
const SUCCESSOR: SuccessorAccount = { asks: [], beyondAsks: [] };

const PREV_GEN: Generation = {
  id: "gen:ps-c15-smoke-0",
  patchsetId: "ps-c15-smoke-0",
  lensBoards: {},
  status: "live",
};

describe.skipIf(!SMOKE)("C15 1.1 — rounds pipeline smoke-run (LIVE ports, RENNET_SMOKE=1)", () => {
  it("runRound mints a generation and the six drafters emit real boards over live Claude/Codex", async () => {
    // Board storage lives in a throwaway temp dir; the drafter TURNS run at the real
    // worktree root as cwd. A live claude turn in a bare temp dir completes WITHOUT
    // structured output (proven: the same board schema + prompt emits at the worktree
    // cwd but not at a fresh temp dir), and prod drafters run in the real PR worktree
    // anyway — so the two roots are decoupled: `boardsRoot` for storage, `repoRoot` for cwd.
    const boardsRoot = mkdtempSync(join(tmpdir(), "c15-smoke-"));
    const repoRoot = process.cwd();
    try {
      // REAL ports — the user's installed claude/codex, subscription auth.
      const { adapter: claudePort, discovery } = await createClaudeHarness({
        env: process.env,
      });
      console.log("[smoke] claude discovery:", JSON.stringify(discovery.health));
      const codexProbe = await discoverCodex(defaultCodexDiscoveryDeps(), {});
      const codexExecutor: CodexExecutor | null = codexProbe.chosen
        ? createCodexExecutor(defaultCodexExecEffects, {
            bin: codexProbe.chosen.path,
            harnessVersion: codexProbe.chosen.version,
            ...(codexProbe.chosen.runtimePath === undefined
              ? {}
              : { runtimePath: codexProbe.chosen.runtimePath }),
            repoRoot,
          })
        : null;
      console.log(
        "[smoke] ports:",
        JSON.stringify({ claude: claudePort !== null, codex: codexExecutor !== null }),
      );
      expect(claudePort, "no claude harness resolved — cannot smoke the drafters").not.toBeNull();

      // REAL prompt files (packages/prompts/src) and a REAL file-backed boards runtime.
      const promptsSrcDir = join(dirname(fileURLToPath(import.meta.url)), "../../../prompts/src");
      const boards = createBoardsRuntime(boardsRoot);

      const deltaPacket = buildDeltaPacket(smallPatchset(), KNOWLEDGE, DOSSIER, SUCCESSOR);
      expect(deltaPacket.successorAccount).not.toBeUndefined(); // isRound fires

      // The COVERAGE CONTROL, driven through the real path (review finding 11's shape).
      // The round's hunk universe carries one hunk in a file that does not exist and that
      // no drafter can possibly teach, so `runRound`'s OWN cross-lens coverage assert must
      // come back naming it. Binding `assertCoverage` on the side (as this used to) only
      // ever proved the helper works — a pipeline that stopped asserting coverage at all
      // would have sailed past it. The per-lens lint context keeps `hunks: []`, so the
      // drafters carry no coverage obligation and their boards are judged exactly as before:
      // this control costs zero extra model turns.
      const UNTEACHABLE: LintHunk = {
        id: "smoke-uncovered",
        path: "src/nowhere.ts",
        newStart: 999,
        newLines: 3,
      };
      const hunks: readonly LintHunk[] = [UNTEACHABLE];
      const lintContextFor = (lens: LintTarget): LintContext => ({
        lens,
        hunks: [],
        files: new Map([["src/greet.ts", 3]]),
        patchsetId: "ps-c15-smoke",
      });

      const session: SessionModel = {
        id: "smoke-session",
        projectId: repoRoot,
        threads: [],
        createdAt: Date.now(),
      } as unknown as SessionModel;

      const runtime = createRoundsRuntime({
        resolveClaudePort: async () => claudePort,
        resolveCodexExecutor: async () => codexExecutor,
        boardsRuntimeFor: () => ({
          service: boards.service,
          createRennetBoard: boards.createRennetBoard,
        }),
        readPrompt: createNodePromptReader(promptsSrcDir),
      });

      const started = Date.now();
      const outcome = await runtime.runRound({
        session,
        repoRoot,
        previousGeneration: PREV_GEN,
        asksDispatched: [],
        runWorkers: async () => ({
          commitRange: { from: "c0", to: "c1" },
          patchsetId: "ps-c15-smoke",
        }),
        deltaPacket,
        hunks,
        lintContextFor,
        reviewDraftLintCtx: { files: new Map([["src/greet.ts", 3]]) },
      });
      const elapsedMs = Date.now() - started;

      // ── EVIDENCE ─────────────────────────────────────────────────────────────
      const report = outcome.pipeline.report;
      const lensRows = outcome.pipeline.boards.map((b) => ({
        lens: b.lens,
        boardId: b.boardId ?? null,
        elements: b.board?.elements.length ?? 0,
        failure: b.failure ?? null,
      }));
      const realBoards: DraftBoard[] = outcome.pipeline.boards
        .map((b) => b.board)
        .filter((b): b is DraftBoard => b !== undefined);
      console.log(
        "[smoke] RESULT:",
        JSON.stringify(
          {
            elapsedMs,
            boardGeneration: outcome.boardGeneration.id,
            frozenPrevious: outcome.frozenPrevious?.id ?? null,
            report: report
              ? {
                  boardId: report.boardId ?? null,
                  elements: report.board?.elements.length ?? 0,
                  failure: report.failure ?? null,
                }
              : null,
            lenses: lensRows,
            coverageViolations: outcome.pipeline.coverage?.length ?? "unknown",
          },
          null,
          2,
        ),
      );

      // ── The HONEST pass bar (Rai's ruling): task 1.1 proves the pipeline EXECUTES
      // end to end, not that every model turn is perfect. Real drafters occasionally
      // emit a dangling-ref board or a flaky turn; demanding 6/6 on one live draw would
      // fight model nondeterminism and make the smoke itself flaky. The bar is: a real
      // generation is minted, the report drafts, at least one lens board comes back VALID,
      // and — crucially — any per-seat failure surfaces as a REAL error, never a swallowed
      // empty or a fabricated board. (Observed failure modes, TRANSIENT/model-content, not
      // infra: a lens board rejected `bad-ref` for citing a non-existent element id; a lens
      // turn that did not emit. Both are the honest-degradation doctrine working. Per-seat
      // draft quality is a drafting-quality concern orthogonal to the collation bridge.) ──
      const allOutcomes = [...(report ? [report] : []), ...outcome.pipeline.boards];

      // A real generation was minted (isRound + landed patchset ⇒ successor generation).
      expect(outcome.boardGeneration.id).toBe("gen:ps-c15-smoke");
      expect(outcome.frozenPrevious?.id).toBe(PREV_GEN.id);
      expect(allOutcomes.length, "report seat did not run").toBe(6);

      // No swallowed empties: every seat is EITHER a valid non-empty board OR an honest
      // failure string. A seat with no board and no failure would be a swallowed empty.
      for (const o of allOutcomes) {
        const hasBoard = o.board !== undefined && o.board.elements.length > 0;
        const hasFailure = typeof o.failure === "string" && o.failure.length > 0;
        expect(hasBoard || hasFailure, `${o.lens}: swallowed empty — no board and no failure`).toBe(
          true,
        );
        if (o.board !== undefined) {
          expect(parseDraft(o.board).ok, `${o.lens}: emitted board is not a valid DraftBoard`).toBe(
            true,
          );
        }
      }

      // The report drafts (its own seat, first) and carries content — it is the reviewer's
      // greeting and the lens drafters' input.
      expect(report?.failure ?? null, `round-report seat failed: ${report?.failure}`).toBeNull();
      expect(report?.board?.elements.length ?? 0, "round-report board is empty").toBeGreaterThan(0);

      // At least one LENS board came back valid + non-empty (the drafters produced real
      // regeneration data, not just a report).
      const validLensBoards = outcome.pipeline.boards.filter(
        (o) => o.board !== undefined && o.board.elements.length > 0 && parseDraft(o.board).ok,
      );
      expect(
        validLensBoards.length,
        "no lens board came back valid — the drafters produced no regeneration data",
      ).toBeGreaterThan(0);

      // POSITIVE CONTROL: coverage is not a swallow, asserted on the ROUND's own verdict.
      // The unteachable hunk went into the round's hunk universe above, so this reads what
      // `runLensPipeline` really concluded about it — a pipeline that stopped asserting
      // coverage fails here, which is the failure that matters.
      const coverage = outcome.pipeline.coverage;
      expect(coverage, "the round reported no coverage picture at all").toBeDefined();
      expect(
        (coverage ?? []).map((v) => v.elementRef),
        "the round swallowed an uncovered hunk",
      ).toContain(`/hunks/${UNTEACHABLE.id}`);
      // …and the verdict TRACKS the universe rather than being a constant: the same frozen
      // boards over an empty hunk set report nothing. (Pure re-assert over the boards this
      // run already produced — still no extra model turns.)
      expect(assertCoverage(realBoards, [])).toEqual([]);
    } finally {
      rmSync(boardsRoot, { recursive: true, force: true });
    }
  }, 900_000);

  // The fix lives at the adapter choke point (`toSdkOptions` → `normalizeOutputSchema`),
  // so it protects EVERY `outputSchema` routed through the claude port, not just boards.
  // This exercises a NON-board schema through the same path — `DELTA_DIGEST_OUTPUT_SCHEMA`,
  // a hand-written literal (no `$schema`, so it never carried the 2020-12 bug) — proving the
  // normalization is a harmless passthrough for a schema with no meta keys (regression guard).
  it("the adapter schema normalization passes a non-board schema through cleanly (delta-digest)", async () => {
    const { adapter } = await createClaudeHarness({ env: process.env });
    expect(adapter, "no claude harness resolved").not.toBeNull();
    const session = await (adapter as NonNullable<typeof adapter>).createSession({
      cwd: process.cwd(),
      outputSchema: DELTA_DIGEST_OUTPUT_SCHEMA,
    } as never);
    let status = "no-terminal-frame";
    let hasStructured = false;
    try {
      await session.send({
        prompt:
          "Return a JSON object with a single field `digest`: a one-sentence summary of the string 'a coding agent renamed a greeting'.",
      });
      for await (const event of session.events as AsyncIterable<never>) {
        const e = event as {
          kind: string;
          outcome?: { status: string; structuredOutput?: unknown };
        };
        if (e.kind === "session.ended") {
          status = e.outcome?.status ?? "unknown";
          hasStructured = e.outcome?.structuredOutput !== undefined;
          break;
        }
      }
    } finally {
      await session.close();
    }
    console.log(
      `[smoke] delta-digest via fixed adapter: status=${status} structured=${hasStructured}`,
    );
    expect(status, "delta-digest turn did not complete").toBe("completed");
    expect(hasStructured, "delta-digest emitted no structured output").toBe(true);
  }, 300_000);
});
