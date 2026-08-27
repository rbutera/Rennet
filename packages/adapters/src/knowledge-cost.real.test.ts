import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createClaudeHarness } from "./claude-query";
import { execaGit } from "./git-range-diff";
import { KnowledgeStore } from "./knowledge-store";
import { runKnowledgeSwarmForRepo } from "./knowledge-swarm";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { resolveBaseRef } from "./project-snapshot-source";
import { defaultProjectsBaseDir, ProjectSnapshotStore } from "./project-snapshot-store";
import { createMetricsCollector, type TurnMetric } from "./turn-metrics";

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE COST harness (Rai's ask 2026-08-10: "repo-map generation cost").
//
// The knowledge layer is the ONE place the Repo Map spends model turns, so THIS
// is the "repo-map generation cost" to measure. Since B06 the layer is the
// PARTITIONED SWARM (#460): one light worker turn per partition slice plus one
// verify/synthesis turn — uncapped by decision, so the honest cost question is
// "how many partitions does this repo produce and what does each turn cost".
// It drives the REAL swarm against a dogfood target — this repo at its resolved
// base OID — on the user's own harnesses, recording model/tokens/latency per
// Claude turn via the same turn-metrics seam the ~294K review baseline uses.
//
// It spends subscription quota and needs a discoverable `claude`, so it is
// SKIPPED unless RENNET_KNOWLEDGE_COST=1:
//
//   RENNET_KNOWLEDGE_COST=1 RENNET_METRICS_OUT=/abs/knowledge-metrics.json \
//     pnpm exec vitest run packages/adapters/src/knowledge-cost.real.test.ts
//
// Optional: RENNET_REPO_ROOT overrides the dogfood target (default: cwd).
// Codex-seat turns (when the council routes workers to Luna) report through the
// executor's own usage surface, not this collector — the summary below counts
// the Claude-seat turns and states that boundary honestly.
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
  line("=== RENNET KNOWLEDGE SWARM COST — per Claude model turn ===");
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
    "measures the swarm's per-partition + verify turn cost vs the ~294K review baseline",
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
      const outcome = await runKnowledgeSwarmForRepo({
        reader,
        knowledgeStore,
        claudePort: adapter,
        codexExecutor: null,
        repoKey: base.repoKey,
        repoRoot: REPO_ROOT,
        baseOid: base.baseOid,
        collector,
        onProgress: (event) => {
          if (event.kind === "verify" || event.status !== "queued")
            process.stdout.write(`  ${JSON.stringify(event)}\n`);
        },
      });
      process.stdout.write(`\nswarm run: ${outcome.status}\n`);
      if (outcome.status === "ok") {
        process.stdout.write(
          `partitions: ${outcome.ranPartitions}/${outcome.totalPartitions}, statements: ${outcome.set.statements.length}\n`,
        );
      }

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
    1_800_000,
  );
});
