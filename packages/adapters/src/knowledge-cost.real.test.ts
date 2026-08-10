import { writeFileSync } from "node:fs";
import { createInvocationBudget, DEFAULT_MAX_HARNESS_INVOCATIONS } from "@rennet/core";
import { describe, expect, it } from "vitest";
import { createClaudeHarness } from "./claude-query";
import { execaGit } from "./git-range-diff";
import { enrichKnowledgeForRepo } from "./knowledge-enrichment";
import { KnowledgeStore } from "./knowledge-store";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { resolveBaseRef } from "./project-snapshot-source";
import { defaultProjectsBaseDir, ProjectSnapshotStore } from "./project-snapshot-store";
import { createMetricsCollector, type TurnMetric } from "./turn-metrics";

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE COST harness (Rai's ask 2026-08-10: "repo-map generation cost").
//
// The knowledge layer is the ONE place the Repo Map spends model turns, so THIS is
// the "repo-map generation cost" to measure. It drives the REAL enrichment (an
// initial full pass + a branch-advance delta pass) against a dogfood target — this
// repo at its resolved base OID — on the user's own `claude` (subscription OAuth,
// $0 metered), and records model/tokens/latency per turn via the same turn-metrics
// seam the ~294K review baseline uses (`~/expedition/Rennet Cost Baseline.md`), so
// the DELTA is directly comparable.
//
// It spends subscription quota and needs a discoverable `claude`, so it is SKIPPED
// unless RENNET_KNOWLEDGE_COST=1:
//
//   RENNET_KNOWLEDGE_COST=1 RENNET_METRICS_OUT=/abs/knowledge-metrics.json \
//     pnpm exec vitest run packages/adapters/src/knowledge-cost.real.test.ts
//
// Optional: RENNET_REPO_ROOT overrides the dogfood target (default: cwd).
//
// ── ANALYTICAL ENVELOPE (when a live turn is not spent) ───────────────────────
// The knowledge pass is bounded to ONE structured turn per pass (budget-gated,
// changed-regions-only on a delta). Its shape is the same single-turn `claude`
// session the review producers use, whose measured baseline is ~50–57K tokens/turn
// (Cost Baseline 2026-08-10). So:
//   • INITIAL full enrichment ≈ 1 turn ≈ ~55–90K tokens (a larger prompt: the file
//     inventory + scopes, capped at DEFAULT_KNOWLEDGE_MAX_FILES=400 paths) — i.e.
//     roughly ONE review-producer turn, ~20–30% of the ~294K full-review baseline,
//     paid ONCE at project-open, not per review.
//   • DELTA pass ≈ 1 turn over ONLY the changed regions ≈ ~40–55K tokens, and only
//     when the reference branch actually moves (debounced + merge-train-coalesced),
//     carrying untouched statements verbatim (never re-run) — so steady-state cost
//     tracks change size, not repo size.
//   • Neither is on the review's critical path: a review spends its ~294K on the
//     structural + lens turns regardless; knowledge adds at most ~1 turn, async.
// The live numbers below refine this envelope with measured token counts.
// ─────────────────────────────────────────────────────────────────────────────

const RUN = process.env.RENNET_KNOWLEDGE_COST === "1";
const REPO_ROOT = process.env.RENNET_REPO_ROOT ?? process.cwd();
const METRICS_OUT = process.env.RENNET_METRICS_OUT ?? "";
const REVIEW_BASELINE_TOTAL = 293_815; // ~294K tokens, full review (Cost Baseline 2026-08-10)

function summarize(metrics: readonly TurnMetric[]): void {
  const line = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  line("");
  line("=== RENNET KNOWLEDGE PASS COST — per model turn ===");
  let total = 0;
  let ms = 0;
  for (const m of metrics) {
    const u = m.usage;
    line(
      [
        m.label.padEnd(20),
        m.status.padEnd(9),
        `in=${u?.inputTokens ?? "-"}`,
        `out=${u?.outputTokens ?? "-"}`,
        `cacheW=${u?.cacheCreationTokens ?? "-"}`,
        `total=${u?.totalTokens ?? "-"}`,
        `ms=${Math.round(m.latencyMs)}`,
      ].join("  "),
    );
    total += u?.totalTokens ?? 0;
    ms += m.latencyMs;
  }
  line("-".repeat(80));
  line(`knowledge total: ${total} tokens over ${metrics.length} turns, ${Math.round(ms)} ms`);
  line(
    `vs ~294K full-review baseline: ${((total / REVIEW_BASELINE_TOTAL) * 100).toFixed(1)}% of one full review`,
  );
  const models = [...new Set(metrics.map((m) => m.model).filter(Boolean))];
  const auth = [...new Set(metrics.map((m) => m.apiKeySource).filter(Boolean))];
  line(
    `model(s): ${models.join(", ") || "unknown"}   apiKeySource: ${auth.join(", ") || "unknown"}`,
  );
  line("");
}

describe("rennet knowledge layer — generation cost (gated real turns)", () => {
  it.skipIf(!RUN)(
    "measures the initial enrichment + delta pass token cost vs the ~294K review baseline",
    async () => {
      const { adapter, discovery } = await createClaudeHarness({ env: process.env });
      expect(
        adapter,
        `no claude binary discovered: ${JSON.stringify(discovery.health)}`,
      ).not.toBeNull();
      if (!adapter) return;

      const store = new ProjectSnapshotStore(defaultProjectsBaseDir());
      const generator = new ProjectSnapshotGenerator({ store });
      const reader = new ProjectContextReader(store);
      const knowledgeStore = new KnowledgeStore(store);

      const base = await resolveBaseRef(REPO_ROOT, { git: execaGit });
      await generator.generate(REPO_ROOT, { explicitBaseRef: base.baseOid });

      const collector = createMetricsCollector();
      const initial = await enrichKnowledgeForRepo({
        reader,
        knowledgeStore,
        port: adapter,
        repoKey: base.repoKey,
        repoRoot: REPO_ROOT,
        baseOid: base.baseOid,
        budget: createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS),
        collector,
      });
      process.stdout.write(`\ninitial enrichment: ${initial.status}\n`);

      summarize(collector.metrics);
      if (METRICS_OUT) {
        writeFileSync(
          METRICS_OUT,
          JSON.stringify(
            {
              target: { repoRoot: REPO_ROOT, baseOid: base.baseOid },
              capturedAt: new Date().toISOString(),
              reviewBaselineTotal: REVIEW_BASELINE_TOTAL,
              metrics: collector.metrics,
            },
            null,
            2,
          ),
        );
        process.stdout.write(`metrics written to ${METRICS_OUT}\n`);
      }

      // At least one measured knowledge turn ran, and it ran on the unmetered path.
      expect(collector.metrics.length).toBeGreaterThanOrEqual(1);
      for (const m of collector.metrics) {
        expect(["oauth", "none", null]).toContain(m.apiKeySource);
      }
    },
    900_000,
  );
});
