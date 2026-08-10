import { writeFileSync } from "node:fs";
import {
  buildOfferedManifest,
  createCodexRunTurn,
  createInvocationBudget,
  DEFAULT_CODEX_UTILITY_EFFORT,
  DEFAULT_CODEX_UTILITY_MODEL,
  DEFAULT_MAX_HARNESS_INVOCATIONS,
  type DualSeat,
  decompose,
  runDualFindingReview,
} from "@rennet/core";
import type { Patchset, RspTokenUsage } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { createClaudeHarness } from "./claude-query";
import {
  createCodexExecutor,
  createCodexUtilityAdapter,
  defaultCodexExecEffects,
  discoverCodexAvailability,
} from "./codex-exec";
import { type CodexSessionReadResult, codexSessionsRoot } from "./codex-session-usage";
import { captureRangePatchset, execaGit } from "./git-range-diff";
import { createInstrumentedRunTurn, createMetricsCollector } from "./turn-metrics";

// ─────────────────────────────────────────────────────────────────────────────
// DUAL-REVIEW COST harness (#41, Rai's explicit ask 2026-08-10).
//
// Drives a REAL dual-model Flagged review against a dogfood target — Rennet
// reviewing a previously merged Rennet PR (a git range, no live GitHub fetch) —
// running the SAME finding lens INDEPENDENTLY on two provider seats (Claude on the
// user's subscription OAuth, Codex via `codex exec`) and reconciling them. It
// records, PER SEAT, the token cost the dual review pays ON TOP of the ~294K
// single-review baseline (see ~/expedition/Rennet Cost Baseline.md).
//
//   • Claude seat — measured through `createInstrumentedRunTurn` (real tokens off
//     the SDK result frame, #186). Directly comparable to the baseline `finding`
//     turn (~54,624 tokens).
//   • Codex seat — measured from what `createCodexRunTurn` returns. Codex exposes
//     LITTLE/NO per-call usage on a subscription account, so this is flagged
//     OPAQUE where it is: the harness reports exactly what Codex emits and never
//     guesses a number.
//
// It spends NO metered tokens but DOES spend subscription quota and needs BOTH a
// discoverable `claude` and `codex`, so it is SKIPPED unless RENNET_DUAL_COST=1:
//
//   RENNET_DUAL_COST=1 RENNET_DUAL_METRICS_OUT=/abs/dual.json \
//     pnpm exec vitest run packages/adapters/src/dual-review-cost.real.test.ts
//
// Optional RENNET_BASE_OID / RENNET_HEAD_OID / RENNET_REPO_ROOT override the target
// (default: PR #109, 5956d96...88ce92c, the SAME target the baseline measured).
// ─────────────────────────────────────────────────────────────────────────────

const RUN = process.env.RENNET_DUAL_COST === "1";
const REPO_ROOT = process.env.RENNET_REPO_ROOT ?? process.cwd();
const BASE_OID = process.env.RENNET_BASE_OID ?? "5956d96";
const HEAD_OID = process.env.RENNET_HEAD_OID ?? "88ce92c";
const METRICS_OUT = process.env.RENNET_DUAL_METRICS_OUT ?? "";

/** The baseline single `finding` turn (Claude), for the DELTA comparison. */
const BASELINE_FINDING_TOTAL_TOKENS = 54_624;

const SEED = {
  harness: "claude-code",
  harnessVersion: "unknown",
  adapterVersion: "0.0.0",
  model: "unknown",
  modelReportedBy: "unknown" as const,
  capability: {
    structuredOutput: {
      implementedByAdapter: true,
      advertisedByHarness: true,
      availableInSession: true,
    },
    perCallModelSelection: {
      implementedByAdapter: true,
      advertisedByHarness: true,
      availableInSession: true,
    },
  },
};

function line(s: string): void {
  process.stdout.write(`${s}\n`);
}

describe("rennet dual-model Flagged review — cost (gated real turns)", () => {
  it.skipIf(!RUN)(
    "measures per-seat (Claude + Codex) token cost for a dual Flagged review on a dogfood PR",
    async () => {
      const { adapter, discovery } = await createClaudeHarness({ env: process.env });
      expect(
        adapter,
        `no claude binary discovered: ${JSON.stringify(discovery.health)}`,
      ).not.toBeNull();
      const codex = await discoverCodexAvailability();
      expect(codex.available, "codex is required for a dual-model measurement").toBe(true);
      if (!adapter || !codex.available) return;

      const patchset: Patchset = await captureRangePatchset(execaGit, {
        root: REPO_ROOT,
        baseOid: BASE_OID,
        headOid: HEAD_OID,
        baseRef: "main",
      });
      line(
        `\ndogfood target ${BASE_OID}...${HEAD_OID}: ${patchset.files.length} files, ${patchset.byteLength} diff bytes`,
      );

      const decomposition = decompose(patchset);
      const manifest = buildOfferedManifest(decomposition);

      // ── Claude seat: instrumented so its real token usage is captured ────────
      const collector = createMetricsCollector();
      const claudeSeat: DualSeat = {
        provider: "claude-code",
        label: "Claude",
        seed: SEED,
        runTurn: createInstrumentedRunTurn(
          adapter,
          { docType: "finding", cwd: REPO_ROOT },
          collector,
          "finding-claude",
        ),
      };

      // ── Codex seat: real `codex exec`, tokens now read from the session log ──
      // The executor correlates each `codex exec` to its rollout `.jsonl` by the
      // unique scratch cwd and returns REAL tokens; the onUsageMeasurement hook
      // collects the correlation outcome so the report is honest about measured vs
      // unmeasured (never "opaque", never a guessed number).
      const codexMeasurements: CodexSessionReadResult[] = [];
      const executor = createCodexExecutor(defaultCodexExecEffects, {
        onUsageMeasurement: (m) => codexMeasurements.push(m),
      });
      const port = createCodexUtilityAdapter({ executor });
      const rawCodexTurn = createCodexRunTurn(port, {
        docType: "finding",
        patchset: { id: patchset.id },
        manifest,
        model: DEFAULT_CODEX_UTILITY_MODEL,
        effort: DEFAULT_CODEX_UTILITY_EFFORT,
      });
      let codexTokens: RspTokenUsage | null = null;
      let codexLatencyMs = 0;
      let codexAttempts = 0;
      const codexSeat: DualSeat = {
        provider: "codex",
        label: "Codex",
        seed: { ...SEED, harness: "codex", model: DEFAULT_CODEX_UTILITY_MODEL },
        runTurn: async (prompt: string, attempt: number) => {
          codexAttempts += 1;
          const started = Date.now();
          const result = await rawCodexTurn(prompt, attempt);
          codexLatencyMs += Date.now() - started;
          if (result.status === "emitted" && result.tokens) codexTokens = result.tokens;
          return result;
        },
      };

      const { review, seatRuns } = await runDualFindingReview({
        deepReview: true,
        patchsetId: patchset.id,
        manifest,
        seats: [claudeSeat, codexSeat],
        makeBudget: () => createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS),
      });

      // ── Claude cost (real tokens) from the instrumentation collector ─────────
      const claudeMetrics = collector.metrics.filter((m) => m.label === "finding-claude");
      const claudeTotal = claudeMetrics.reduce((sum, m) => sum + (m.usage?.totalTokens ?? 0), 0);
      const claudeLatency = claudeMetrics.reduce((sum, m) => sum + m.latencyMs, 0);
      const claudeModel = [...new Set(claudeMetrics.map((m) => m.model).filter(Boolean))].join(
        ", ",
      );
      const claudeAuth = [
        ...new Set(claudeMetrics.map((m) => m.apiKeySource).filter(Boolean)),
      ].join(", ");

      const cx = codexTokens as RspTokenUsage | null;
      const codexTotal = cx?.total ?? null;
      const codexMeasured = cx !== null && cx.total > 0;
      const measuredCount = codexMeasurements.filter((m) => m.status === "measured").length;
      const codexStatusNote = codexMeasured
        ? `measured from ${measuredCount} session log(s)`
        : `UNMEASURED: ${codexMeasurements.map((m) => `${m.status}${m.reason ? ` (${m.reason})` : ""}`).join("; ") || "no measurement recorded"}`;

      line("");
      line("=== RENNET DUAL-REVIEW COST — per seat (Flagged lens) ===");
      line(
        [
          "seat".padEnd(8),
          "turns".padStart(6),
          "totalTokens".padStart(12),
          "latencyMs".padStart(10),
          "model/auth",
        ].join(" "),
      );
      line(
        [
          "Claude".padEnd(8),
          String(claudeMetrics.length).padStart(6),
          String(claudeTotal).padStart(12),
          String(Math.round(claudeLatency)).padStart(10),
          `${claudeModel || "?"} / ${claudeAuth || "?"}`,
        ].join(" "),
      );
      line(
        [
          "Codex".padEnd(8),
          String(codexAttempts).padStart(6),
          String(codexTotal ?? "UNMEASURED").padStart(12),
          String(Math.round(codexLatencyMs)).padStart(10),
          `${DEFAULT_CODEX_UTILITY_MODEL} / subscription`,
        ].join(" "),
      );
      if (codexMeasured && cx) {
        line(
          [
            "  ".padEnd(8),
            "".padStart(6),
            `in ${cx.input} / out ${cx.output} / cacheRead ${cx.cacheRead}`.padStart(12),
            "",
            "REAL (session log)",
          ].join(" "),
        );
      }
      line("-".repeat(60));
      line(`codex sessions dir: ${codexSessionsRoot()}`);
      line(`codex usage: ${codexStatusNote}`);
      line(
        `Claude vs baseline finding turn (~${BASELINE_FINDING_TOTAL_TOKENS} tok): the SECOND opinion`,
      );
      line(`  → dual Flagged ≈ 1 Claude finding turn + 1 Codex finding turn.`);
      line(
        codexMeasured
          ? `  → Codex reported ${codexTotal} REAL tokens (read from the session log, chaching-style).`
          : "  → Codex usage UNMEASURED (session log not correlated); NOT guessed, NOT opaque.",
      );
      const reconciled = review.status === "ok" ? review.findings.length : 0;
      const concur =
        review.status === "ok"
          ? review.findings.filter((f) => f.agreement.kind === "concur").length
          : 0;
      const disagree = reconciled - concur;
      line(
        `reconciled findings: ${reconciled} (concur ${concur}, disagree ${disagree}); review status: ${review.status}`,
      );
      line("");

      if (METRICS_OUT) {
        writeFileSync(
          METRICS_OUT,
          JSON.stringify(
            {
              target: { baseOid: BASE_OID, headOid: HEAD_OID, files: patchset.files.length },
              capturedAt: new Date().toISOString(),
              claude: {
                turns: claudeMetrics.length,
                totalTokens: claudeTotal,
                latencyMs: claudeLatency,
                metrics: claudeMetrics,
              },
              codex: {
                attempts: codexAttempts,
                tokens: cx,
                measured: codexMeasured,
                sessionsDir: codexSessionsRoot(),
                measurements: codexMeasurements,
                latencyMs: codexLatencyMs,
              },
              reconcile: { reconciled, concur, disagree, status: review.status },
              baselineFindingTurnTokens: BASELINE_FINDING_TOTAL_TOKENS,
            },
            null,
            2,
          ),
        );
        line(`metrics written to ${METRICS_OUT}`);
      }

      // Both seats ran; the review resolved (ok, possibly degraded, or failed loud).
      expect(seatRuns).toHaveLength(2);
      expect(claudeMetrics.length).toBeGreaterThanOrEqual(1);
      // Every Claude turn ran on the unmetered subscription path.
      for (const m of claudeMetrics) expect(["oauth", "none", null]).toContain(m.apiKeySource);
    },
    900_000,
  );
});
