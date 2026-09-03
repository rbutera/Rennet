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
  buildDeltaPacket,
  type CodexExecutor,
  type HarnessPort,
  type LintContext,
  type LintTarget,
} from "@rennet/core";
import {
  type DossierItem,
  type DraftElement,
  type Generation,
  type LensAbsenceReason,
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
// mints a real Generation, and the drafters emit real boards — non-empty elements and
// honest per-lens failures where a seat could not run.
//
// TWO harness-compat fixes were exercised FIRST by this run (both landed as
// discrete adapter commits): (1) strip the draft-2020-12 `$schema` meta the
// installed claude's `--json-schema` ajv rejects; (2) map the council's versioned
// model aliases (`opus-4.8`/`sonnet-5`) to the binary's full ids. Before them,
// every seat failed identically; after, the drafters run.
//
// The terminal oracle follows the durable #689 contract. A lane settles as exactly one
// populated board, typed absence, or explicit failure. A zero-element board and a lane
// carrying no terminal evidence are both proof failures.
// ─────────────────────────────────────────────────────────────────────────────

const SMOKE = process.env.RENNET_SMOKE === "1";

// A real small one-file patchset — a single edited line, enough for the drafters
// to have a coherent change to reason over.
const PATCH = [
  "@@ -1,3 +1,3 @@",
  " export function greet(name: string): string {",
  `-  return \`Hi \${name}\`;`,
  `+  return \`Hello, \${name}!\`;`,
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

interface TerminalElement {
  readonly id: string;
  readonly kind: DraftElement["kind"];
  readonly data: Readonly<Record<string, unknown>>;
}

interface TerminalLaneInput {
  readonly lens: LintTarget;
  readonly board?: { readonly elements: readonly TerminalElement[] };
  readonly absence?: LensAbsenceReason;
  readonly failure?: string;
}

type TerminalLaneEvidence =
  | { readonly kind: "board"; readonly elements: number }
  | { readonly kind: "absence"; readonly reason: LensAbsenceReason }
  | { readonly kind: "failure"; readonly reason: string };

type ProviderCallLane = LintTarget | "post-process" | "unknown";

interface ProviderCallEvidence {
  readonly provider: "claude" | "codex";
  readonly callId: string;
  readonly lane: ProviderCallLane;
  readonly status: "started" | "completed" | "failed";
  readonly requestedModel?: string;
  readonly effort?: string;
  readonly reportedModel?: string;
  readonly reason?: string;
}

type ProviderCallIdentity = Omit<ProviderCallEvidence, "status" | "reportedModel" | "reason">;
type ProviderCallObserver = (evidence: ProviderCallEvidence) => void;

const PROMPT_LANES: readonly [needle: string, lane: ProviderCallLane][] = [
  ["# Post-process pass", "post-process"],
  ["# Round report", "report"],
  ["# Design lens", "design"],
  ["# Sequence lens", "sequence"],
  ["# Decisions lens", "decisions"],
  ["# Flagged lens", "flagged"],
  ["# Noise lens", "noise"],
];

const ABSENCE_BY_LENS: ReadonlyMap<LintTarget, LensAbsenceReason> = new Map([
  ["design", "no-material"],
  ["decisions", "no-decisions"],
  ["flagged", "no-findings"],
  ["noise", "no-noise"],
]);

function terminalLaneEvidence(outcome: TerminalLaneInput): TerminalLaneEvidence {
  const variants = [
    outcome.board !== undefined,
    outcome.absence !== undefined,
    outcome.failure !== undefined,
  ].filter(Boolean).length;
  if (variants !== 1) {
    throw new Error(`${outcome.lens}: expected exactly one terminal outcome, got ${variants}`);
  }
  if (outcome.board !== undefined) {
    if (outcome.board.elements.length === 0) {
      throw new Error(`${outcome.lens}: a zero-element board is not a successful arrival`);
    }
    return { kind: "board", elements: outcome.board.elements.length };
  }
  if (outcome.absence !== undefined) {
    const expected = ABSENCE_BY_LENS.get(outcome.lens);
    if (expected !== outcome.absence) {
      throw new Error(
        `${outcome.lens}: expected typed absence ${expected ?? "none"}, got ${outcome.absence}`,
      );
    }
    return { kind: "absence", reason: outcome.absence };
  }
  if (outcome.failure === undefined || outcome.failure.length === 0) {
    throw new Error(`${outcome.lens}: terminal failure has no reason`);
  }
  return { kind: "failure", reason: outcome.failure };
}

function assertCoreReviewEvidence(outcomes: readonly TerminalLaneInput[]): void {
  for (const outcome of outcomes) terminalLaneEvidence(outcome);
  const byLens = new Map(outcomes.map((outcome) => [outcome.lens, outcome]));
  const sequence = byLens.get("sequence");
  if (!sequence?.board || !hasReachableKind(sequence.board.elements, "order_step")) {
    throw new Error("Sequence must contain a real reading-order step, not filler prose");
  }
  for (const [lens, requiredKind] of [
    ["decisions", "decision"],
    ["flagged", "finding"],
  ] as const) {
    const outcome = byLens.get(lens);
    if (outcome?.absence !== undefined) continue;
    if (!outcome?.board || !hasReachableKind(outcome.board.elements, requiredKind)) {
      throw new Error(`${lens} must contain a real ${requiredKind} or its typed empty state`);
    }
  }
}

function hasReachableKind(
  elements: readonly TerminalElement[],
  requiredKind: DraftElement["kind"],
): boolean {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const nested = new Set<string>();
  for (const element of elements) {
    const children = element.data.children;
    if (!Array.isArray(children)) continue;
    for (const child of children) if (typeof child === "string") nested.add(child);
  }
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visited.has(id)) return false;
    visited.add(id);
    const element = byId.get(id);
    if (element === undefined) return false;
    if (element.kind === requiredKind) return true;
    if (element.kind !== "section" && element.kind !== "order_step") return false;
    const children = element.data.children;
    return Array.isArray(children)
      ? children.some((child) => typeof child === "string" && visit(child))
      : false;
  };
  return elements.some(
    (element) => element.kind === "section" && !nested.has(element.id) && visit(element.id),
  );
}

function terminalBoard(
  kind: DraftElement["kind"],
  options: { readonly reachable?: boolean } = {},
): NonNullable<TerminalLaneInput["board"]> {
  const leaf: TerminalElement = { id: "leaf", kind, data: {} };
  if (options.reachable === false) return { elements: [leaf] };
  const root: TerminalElement = {
    id: "root",
    kind: "section",
    data: { children: [leaf.id] },
  };
  return { elements: [root, leaf] };
}

function providerCallLane(prompt: string): ProviderCallLane {
  return PROMPT_LANES.find(([needle]) => prompt.includes(needle))?.[1] ?? "unknown";
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logSmokeEvidence(kind: string, evidence: unknown): void {
  console.log(`[smoke] ${new Date().toISOString()} ${kind}: ${JSON.stringify(evidence)}`);
}

function observeCodexExecutor(
  executor: CodexExecutor,
  observe: ProviderCallObserver,
): CodexExecutor {
  let callSequence = 0;
  return async (request) => {
    const identity = {
      provider: "codex",
      callId: `codex-${++callSequence}`,
      lane: providerCallLane(request.prompt),
      requestedModel: request.model,
      effort: request.effort,
    } satisfies ProviderCallIdentity;
    observe({ ...identity, status: "started" });
    try {
      const result = await executor(request);
      observe({
        ...identity,
        status: "completed",
        ...(result.model === undefined ? {} : { reportedModel: result.model }),
      });
      return result;
    } catch (error) {
      observe({
        ...identity,
        status: "failed",
        reason: failureReason(error),
      });
      throw error;
    }
  };
}

function observeClaudePort(port: HarnessPort, observe: ProviderCallObserver): HarnessPort {
  let callSequence = 0;
  return {
    descriptor: port.descriptor,
    health: () => port.health(),
    async createSession(spec) {
      const session = await port.createSession(spec);
      let identity: ProviderCallIdentity | undefined;
      let reportedModel: string | undefined;
      let settled = false;
      const settle = (
        terminal:
          | { readonly status: "completed" }
          | { readonly status: "failed"; readonly reason: string },
      ): void => {
        if (settled || identity === undefined) return;
        settled = true;
        if (terminal.status === "completed") {
          observe({
            ...identity,
            status: "completed",
            ...(reportedModel === undefined ? {} : { reportedModel }),
          });
          return;
        }
        observe({
          ...identity,
          status: "failed",
          reason: terminal.reason,
        });
      };
      const events = {
        async *[Symbol.asyncIterator]() {
          try {
            for await (const event of session.events) {
              if (event.kind === "session.started") reportedModel = event.model;
              if (event.kind === "error") {
                settle({ status: "failed", reason: event.error.message });
              } else if (event.kind === "session.ended") {
                if (event.outcome.status === "completed") settle({ status: "completed" });
                else if (event.outcome.status === "failed") {
                  settle({ status: "failed", reason: event.outcome.error.message });
                } else {
                  settle({ status: "failed", reason: "the Claude turn was cancelled" });
                }
              }
              yield event;
            }
            settle({
              status: "failed",
              reason: "the Claude event stream ended without a terminal frame",
            });
          } catch (error) {
            settle({ status: "failed", reason: failureReason(error) });
            throw error;
          }
        },
      };
      return {
        id: session.id,
        harness: session.harness,
        events,
        async send(input) {
          identity = {
            provider: "claude",
            callId: `claude-${++callSequence}`,
            lane: providerCallLane(input.prompt),
            ...(spec.model === undefined ? {} : { requestedModel: spec.model }),
          };
          observe({ ...identity, status: "started" });
          try {
            return await session.send(input);
          } catch (error) {
            settle({ status: "failed", reason: failureReason(error) });
            throw error;
          }
        },
        interrupt: () => session.interrupt(),
        close: () => session.close(),
      };
    },
  };
}

describe("rounds live-smoke terminal oracle", () => {
  it("accepts each honest terminal variant", () => {
    expect(terminalLaneEvidence({ lens: "sequence", board: terminalBoard("order_step") })).toEqual({
      kind: "board",
      elements: 2,
    });
    expect(terminalLaneEvidence({ lens: "decisions", absence: "no-decisions" })).toEqual({
      kind: "absence",
      reason: "no-decisions",
    });
    expect(terminalLaneEvidence({ lens: "flagged", failure: "provider unavailable" })).toEqual({
      kind: "failure",
      reason: "provider unavailable",
    });
  });

  it("rejects swallowed, conflicting, zero-element, and cross-lens outcomes", () => {
    expect(() => terminalLaneEvidence({ lens: "sequence" })).toThrow("exactly one");
    expect(() =>
      terminalLaneEvidence({
        lens: "noise",
        absence: "no-noise",
        failure: "also failed",
      }),
    ).toThrow("exactly one");
    expect(() => terminalLaneEvidence({ lens: "sequence", board: { elements: [] } })).toThrow(
      "zero-element board",
    );
    expect(() => terminalLaneEvidence({ lens: "flagged", absence: "no-decisions" })).toThrow(
      "expected typed absence no-findings",
    );
  });

  it("rejects noise-only generations and requires the three core review lenses", () => {
    const noiseOnly: readonly TerminalLaneInput[] = [
      { lens: "design", absence: "no-material" },
      { lens: "sequence", board: terminalBoard("prose") },
      { lens: "decisions", absence: "no-decisions" },
      { lens: "flagged", absence: "no-findings" },
      { lens: "noise", board: terminalBoard("prose") },
    ];
    expect(() => assertCoreReviewEvidence(noiseOnly)).toThrow(
      "Sequence must contain a real reading-order step",
    );

    const coreUseful = noiseOnly.map((outcome) =>
      outcome.lens === "sequence"
        ? { lens: "sequence" as const, board: terminalBoard("order_step") }
        : outcome,
    );
    expect(() => assertCoreReviewEvidence(coreUseful)).not.toThrow();

    const paddedDecisions = coreUseful.map((outcome) =>
      outcome.lens === "decisions"
        ? { lens: "decisions" as const, board: terminalBoard("prose") }
        : outcome,
    );
    expect(() => assertCoreReviewEvidence(paddedDecisions)).toThrow(
      "decisions must contain a real decision",
    );

    const paddedFlagged = coreUseful.map((outcome) =>
      outcome.lens === "flagged"
        ? { lens: "flagged" as const, board: terminalBoard("prose") }
        : outcome,
    );
    expect(() => assertCoreReviewEvidence(paddedFlagged)).toThrow(
      "flagged must contain a real finding",
    );

    const failedDecisions = coreUseful.map((outcome) =>
      outcome.lens === "decisions"
        ? { lens: "decisions" as const, failure: "provider failed" }
        : outcome,
    );
    expect(() => assertCoreReviewEvidence(failedDecisions)).toThrow(
      "decisions must contain a real decision or its typed empty state",
    );

    const allCoreBoards = coreUseful.map((outcome) => {
      if (outcome.lens === "decisions") {
        return { lens: "decisions" as const, board: terminalBoard("decision") };
      }
      if (outcome.lens === "flagged") {
        return { lens: "flagged" as const, board: terminalBoard("finding") };
      }
      return outcome;
    });
    expect(() => assertCoreReviewEvidence(allCoreBoards)).not.toThrow();

    const orphanSequence = coreUseful.map((outcome) =>
      outcome.lens === "sequence"
        ? { lens: "sequence" as const, board: terminalBoard("order_step", { reachable: false }) }
        : outcome,
    );
    expect(() => assertCoreReviewEvidence(orphanSequence)).toThrow(
      "Sequence must contain a real reading-order step",
    );
  });

  it("records Codex calls before execution and after success or failure", async () => {
    const evidence: ProviderCallEvidence[] = [];
    const completed = observeCodexExecutor(
      async () => ({ output: { findings: [] }, model: "gpt-observed" }),
      (entry) => evidence.push(entry),
    );
    await expect(
      completed({ model: "gpt-requested", effort: "medium", prompt: "# Decisions lens" }),
    ).resolves.toMatchObject({ model: "gpt-observed" });
    expect(evidence.map((entry) => entry.status)).toEqual(["started", "completed"]);
    expect(evidence[0]).toMatchObject({
      provider: "codex",
      callId: "codex-1",
      lane: "decisions",
      status: "started",
      requestedModel: "gpt-requested",
      effort: "medium",
    });
    expect(evidence[1]).toMatchObject({
      provider: "codex",
      callId: "codex-1",
      lane: "decisions",
      status: "completed",
      reportedModel: "gpt-observed",
    });

    const failed = observeCodexExecutor(
      async () => {
        throw new Error("codex stopped");
      },
      (entry) => evidence.push(entry),
    );
    await expect(
      failed({ model: "gpt-requested", effort: "low", prompt: "# Flagged lens" }),
    ).rejects.toThrow("codex stopped");
    expect(evidence.at(-1)).toMatchObject({
      provider: "codex",
      callId: "codex-1",
      lane: "flagged",
      status: "failed",
      requestedModel: "gpt-requested",
      effort: "low",
      reason: "codex stopped",
    });
  });

  it("classifies post-process before embedded board prose", () => {
    expect(providerCallLane("# Post-process pass\n\n# Decisions lens")).toBe("post-process");
  });
});

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
      logSmokeEvidence("claude-discovery", discovery.health);
      const codexProbe = await discoverCodex(defaultCodexDiscoveryDeps(), {});
      if (codexProbe.chosen === null) {
        throw new Error(`no Codex harness resolved: ${JSON.stringify(codexProbe.health)}`);
      }
      const rawCodexExecutor = createCodexExecutor(defaultCodexExecEffects, {
        bin: codexProbe.chosen.path,
        harnessVersion: codexProbe.chosen.version,
        ...(codexProbe.chosen.runtimePath === undefined
          ? {}
          : { runtimePath: codexProbe.chosen.runtimePath }),
        repoRoot,
      });
      const providerCalls: ProviderCallEvidence[] = [];
      const recordProviderCall: ProviderCallObserver = (entry) => {
        providerCalls.push(entry);
        logSmokeEvidence("provider-call", entry);
      };
      const codexExecutor = observeCodexExecutor(rawCodexExecutor, recordProviderCall);
      const observedClaudePort =
        claudePort === null ? null : observeClaudePort(claudePort, recordProviderCall);
      logSmokeEvidence("ports", { claude: observedClaudePort !== null, codex: true });
      expect(claudePort, "no claude harness resolved — cannot smoke the drafters").not.toBeNull();

      // REAL prompt files (packages/prompts/src) and a REAL file-backed boards runtime.
      const promptsSrcDir = join(dirname(fileURLToPath(import.meta.url)), "../../../prompts/src");
      const boards = createBoardsRuntime(boardsRoot);

      const deltaPacket = buildDeltaPacket(smallPatchset(), DOSSIER, SUCCESSOR);
      expect(deltaPacket.successorAccount).not.toBeUndefined(); // isRound fires

      const lintContextFor = (lens: LintTarget): LintContext => ({
        lens,
        regions: [{ path: "src/greet.ts", side: "head", start: 1, end: 3 }],
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
        resolveClaudePort: async () => observedClaudePort,
        resolveCodexExecutor: async () => codexExecutor,
        boardsRuntimeFor: () => ({
          service: boards.service,
          createRennetBoard: boards.createRennetBoard,
        }),
        readPrompt: createNodePromptReader(promptsSrcDir),
      });

      const started = Date.now();
      let latestProgress: unknown;
      const abortController = new AbortController();
      const abortAfterMs = 840_000;
      const abortTimer = setTimeout(() => {
        logSmokeEvidence("watchdog-abort", {
          elapsedMs: Date.now() - started,
          latestProgress,
          providerCalls,
        });
        abortController.abort();
      }, abortAfterMs);
      const outcome = await (async () => {
        try {
          return await runtime.runRound({
            session,
            repoRoot,
            previousGeneration: PREV_GEN,
            asksDispatched: [],
            runWorkers: async () => ({
              commitRange: { from: "c0", to: "c1" },
              patchsetId: "ps-c15-smoke",
            }),
            deltaPacket,
            lintContextFor,
            reviewDraftLintCtx: { files: new Map([["src/greet.ts", 3]]) },
            signal: abortController.signal,
            onProgress: (event) => {
              latestProgress = event;
              logSmokeEvidence("round-progress", {
                elapsedMs: Date.now() - started,
                event,
              });
            },
          });
        } finally {
          clearTimeout(abortTimer);
        }
      })();
      const elapsedMs = Date.now() - started;

      // ── EVIDENCE ─────────────────────────────────────────────────────────────
      const report = outcome.pipeline.report;
      const lensRows = outcome.pipeline.boards.map((b) => ({
        lens: b.lens,
        boardId: b.boardId ?? null,
        elements: b.board?.elements.length ?? 0,
        absence: b.absence ?? null,
        failure: b.failure ?? null,
      }));
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
            providerCalls,
          },
          null,
          2,
        ),
      );

      // ── The HONEST pass bar (Rai's ruling): task 1.1 proves the pipeline EXECUTES
      // end to end, not that every model turn is perfect. Real drafters occasionally
      // emit a dangling-ref board or a flaky turn; demanding 6/6 on one live draw would
      // fight model nondeterminism and make the smoke itself flaky. The bar is: a real
      // generation is minted, the report drafts, Sequence comes back valid, Decisions and
      // Flagged are useful or honestly empty, and — crucially — any other per-seat failure
      // surfaces as a REAL error, never a swallowed empty or a fabricated board. (Observed
      // failure modes, TRANSIENT/model-content, not
      // infra: a lens board rejected `bad-ref` for citing a non-existent element id; a lens
      // turn that did not emit. Both are the honest-degradation doctrine working. Per-seat
      // draft quality is a drafting-quality concern orthogonal to the collation bridge.) ──
      const allOutcomes = [...(report ? [report] : []), ...outcome.pipeline.boards];

      // A real generation was minted (isRound + landed patchset ⇒ successor generation).
      expect(outcome.boardGeneration.id).toBe("gen:ps-c15-smoke");
      expect(outcome.frozenPrevious?.id).toBe(PREV_GEN.id);
      expect(allOutcomes.length, "report seat did not run").toBe(6);
      const statusesByCall = new Map<string, ProviderCallEvidence["status"][]>();
      for (const call of providerCalls) {
        const key = `${call.provider}:${call.callId}`;
        statusesByCall.set(key, [...(statusesByCall.get(key) ?? []), call.status]);
      }
      for (const [call, statuses] of statusesByCall) {
        expect(
          statuses.filter((status) => status === "started"),
          `${call} did not record exactly one start: ${JSON.stringify(statuses)}`,
        ).toHaveLength(1);
        expect(
          statuses.filter((status) => status !== "started"),
          `${call} did not record exactly one terminal result: ${JSON.stringify(statuses)}`,
        ).toHaveLength(1);
      }
      for (const provider of ["claude", "codex"] as const) {
        expect(
          providerCalls.filter((call) => call.provider === provider && call.status === "completed")
            .length,
          `${provider} resolved but completed no call: ${JSON.stringify(providerCalls)}`,
        ).toBeGreaterThan(0);
      }

      // No swallowed empties: every seat has exactly one populated, absent, or failed
      // terminal result. The cheap oracle tests above are the positive controls for this
      // assertion, including the old zero-element-success shape.
      for (const o of allOutcomes) {
        expect(() => terminalLaneEvidence(o)).not.toThrow();
        if (o.board !== undefined) {
          expect(parseDraft(o.board).ok, `${o.lens}: emitted board is not a valid DraftBoard`).toBe(
            true,
          );
        }
      }
      assertCoreReviewEvidence(outcome.pipeline.boards);

      // The report drafts (its own seat, first) and carries content — it is the reviewer's
      // greeting and the lens drafters' input.
      expect(report?.failure ?? null, `round-report seat failed: ${report?.failure}`).toBeNull();
      expect(report?.board?.elements.length ?? 0, "round-report board is empty").toBeGreaterThan(0);

      // Sequence is the load-bearing chronological review, while Decisions and Flagged
      // must either carry useful content or say honestly that there is none. Noise alone
      // and an empty Design board are not evidence that the review experience works.
      const validLensBoards = outcome.pipeline.boards.filter(
        (o) => o.board !== undefined && o.board.elements.length > 0 && parseDraft(o.board).ok,
      );
      expect(validLensBoards.some((outcome) => outcome.lens === "sequence")).toBe(true);
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
