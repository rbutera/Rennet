import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  councilSeatTurn,
  createClaudeHarness,
  execaGit,
  ProjectSnapshotGenerator,
  ProjectSnapshotStore,
  resolveBaseRef,
} from "@rennet/adapters";
import { MAP_VERIFY_OUTPUT_SCHEMA, runMapVerify } from "@rennet/core";
import type { KnowledgeSet, ProjectProcessEvent } from "@rennet/protocol";
import { PROACTIVE_REHYDRATION_COMMAND_ID } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createKnowledgeSwarmRuntime } from "../src/runtime/knowledge-swarm";

/**
 * The c22 RELEASE-BLOCKER proof: the knowledge swarm run against a REAL, LARGE
 * repository through the REAL runtime and the REAL narration channel. Not part
 * of the hermetic gate (`pnpm check` runs `vitest run packages/server/src`,
 * which never reaches this directory) and dormant without the env flag, because
 * it spends the subscription for the better part of an hour:
 *
 *     RENNET_C22_PROOF=1 RENNET_C22_REPO=/path/to/a/large/repo \
 *       pnpm exec vitest run packages/server/integration
 *
 * A unit test cannot stand in for this. The bug it covers — the verify seat
 * receiving EVERY partition's statements in one prompt and dying on "Prompt is
 * too long", discarding a forty-minute run — survived a green unit suite for
 * exactly that reason: nothing hermetic has a context window.
 *
 * Three checks, in order, sharing one expensive run:
 *   1. the pass completes over the whole repository and persists a set;
 *   2. the SAME statements through ONE unbounded prompt still die — the
 *      positive control that proves check 1 is chunking, not luck;
 *   3. a non-`ok` outcome reaches the narration channel WITH its reason.
 */

const LIVE = process.env.RENNET_C22_PROOF === "1";
const SUBJECT = process.env.RENNET_C22_REPO ?? process.cwd();

const say = (line: string) => process.stderr.write(`[c22] ${line}\n`);

/** What check 1 produced, for the checks that reuse it instead of re-running. */
let produced: { set: KnowledgeSet; repoRoot: string } | undefined;

describe.skipIf(!LIVE)("c22 — the real knowledge swarm on a real repository", () => {
  it("completes over the whole repository and narrates on the rehydration channel", async () => {
    const { adapter, discovery } = await createClaudeHarness({ env: process.env });
    expect(adapter, `no claude discovered: ${JSON.stringify(discovery.health)}`).not.toBeNull();
    if (!adapter) return;

    const baseDir = mkdtempSync(join(tmpdir(), "c22-proof-"));
    say(`subject ${SUBJECT}`);
    say(`scratch store ${baseDir}`);
    const store = new ProjectSnapshotStore(baseDir);
    const base = await resolveBaseRef(SUBJECT, { git: execaGit });
    await new ProjectSnapshotGenerator({ store }).generate(SUBJECT, {
      explicitBaseRef: base.baseOid,
    });

    // The composition root's own wiring, verbatim: every runtime narration is
    // broadcast under PROACTIVE_REHYDRATION_COMMAND_ID — the id the indexing
    // screen now subscribes to. Nothing here is a stub but the transport.
    const broadcast: { commandId: string; event: ProjectProcessEvent }[] = [];
    // Timing instrumentation for the "context map in <= 5 minutes" workstream:
    // observed in-flight worker count (the ACHIEVED concurrency, not the cap)
    // and each worker's wall time, read off the narration itself.
    const startedAt = new Map<string, number>();
    const durations: number[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const started = Date.now();
    const runtime = createKnowledgeSwarmRuntime({
      store,
      resolveClaudePort: async () => adapter,
      resolveCodexExecutor: async () => null,
      narrate: (event) => {
        broadcast.push({ commandId: PROACTIVE_REHYDRATION_COMMAND_ID, event });
        if (event.kind !== "stage") return;
        const key = event.detail?.split(":")[0] ?? "";
        if (/ running$/.test(event.note)) {
          startedAt.set(key, Date.now());
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
        } else if (/ (done|failed)$/.test(event.note)) {
          const at = startedAt.get(key);
          if (at !== undefined) durations.push(Date.now() - at);
          inFlight -= 1;
        }
        say(
          `+${Math.round((Date.now() - started) / 1000)}s inflight=${inFlight} ` +
            `${event.note} — ${event.detail ?? ""}`,
        );
      },
    });

    const outcome = await runtime.runForRepo({
      repoKey: base.repoKey,
      repoRoot: SUBJECT,
      toOid: base.baseOid,
    });
    const wallSeconds = Math.round((Date.now() - started) / 1000);
    const sorted = [...durations].sort((a, b) => a - b);
    const median = sorted.length === 0 ? 0 : (sorted[sorted.length >> 1] ?? 0);
    const sumWorkers = durations.reduce((a, b) => a + b, 0);
    say(
      `TIMING wall=${wallSeconds}s workers=${durations.length} ` +
        `medianWorker=${Math.round(median / 1000)}s ` +
        `slowestWorker=${Math.round((sorted[sorted.length - 1] ?? 0) / 1000)}s ` +
        `sumWorkerTime=${Math.round(sumWorkers / 1000)}s ` +
        `peakInFlight=${peakInFlight} ` +
        `achievedConcurrency=${(sumWorkers / Math.max(1, wallSeconds * 1000)).toFixed(2)}`,
    );
    say(`outcome=${outcome.status} in ${wallSeconds}s`);
    if (outcome.status !== "ok") say(`reason: ${outcome.reason}`);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;

    say(
      `partitions ${outcome.ranPartitions}/${outcome.totalPartitions} ` +
        `failed=${outcome.failedPartitions} statements=${outcome.set.statements.length} ` +
        `confirmed=${outcome.verify.confirmed} rejected=${outcome.verify.rejected} ` +
        `crossCutting=${outcome.verify.crossCutting}`,
    );
    expect(outcome.totalPartitions).toBeGreaterThan(100);
    expect(outcome.set.statements.length).toBeGreaterThan(0);

    // The set is on disk, not just in the return value.
    const file = join(store.paths(base.repoKey).knowledgeDir, "knowledge.json");
    expect(existsSync(file)).toBe(true);
    const stored = JSON.parse(readFileSync(file, "utf8")) as { statements: unknown[] };
    say(`stored ${stored.statements.length} statements at ${file}`);
    expect(stored.statements.length).toBeGreaterThan(0);

    // The user could actually see it: worker lines AND the verify line landed
    // on the id a client subscribes to.
    const onChannel = broadcast.filter(
      (entry) => entry.commandId === PROACTIVE_REHYDRATION_COMMAND_ID,
    );
    const notes = onChannel.map((entry) =>
      entry.event.kind === "stage" ? `${entry.event.note} ${entry.event.detail ?? ""}` : "",
    );
    say(`narrated ${onChannel.length} events on ${PROACTIVE_REHYDRATION_COMMAND_ID}`);
    expect(onChannel.length).toBeGreaterThan(0);
    expect(notes.some((note) => note.startsWith("Knowledge verified"))).toBe(true);
    expect(notes.some((note) => /too long/i.test(note))).toBe(false);

    produced = { set: outcome.set, repoRoot: SUBJECT };
  }, 7_200_000);

  it("POSITIVE CONTROL: the same statements in ONE unbounded prompt still die", async () => {
    expect(produced, "check 1 must have produced a set").toBeDefined();
    if (!produced) return;
    const { adapter } = await createClaudeHarness({ env: process.env });
    if (!adapter) return;

    const seat = councilSeatTurn(
      "map-verify",
      MAP_VERIFY_OUTPUT_SCHEMA,
      { claudePort: adapter, repoRoot: produced.repoRoot, label: "knowledge.verify" },
      { availability: { installed: ["claude-code"] } },
    );
    expect("failure" in seat ? seat.failure : "", "the verify seat must resolve").toBe("");
    if ("failure" in seat) return;

    const workerResults = [
      {
        sliceId: "c22:control",
        status: "ok" as const,
        statements: produced.set.statements.map((statement) => ({ statement })),
        droppedAnchors: 0,
        droppedStatements: 0,
        attempts: 1,
      },
    ];
    say(`control: ${produced.set.statements.length} statements in ONE prompt`);
    const verify = await runMapVerify({
      workerResults,
      snapshot: {
        repoKey: produced.set.repoKey,
        baseOid: produced.set.baseOid,
        snapshotFingerprint: produced.set.snapshotFingerprint,
        files: [],
        scopes: [],
      },
      provenance: { model: seat.model, apiKeySource: null },
      runTurn: seat.runTurn,
      maxRetries: 0,
      // The pre-fix behaviour, restored on purpose: one prompt for the lot.
      chunkSize: Number.MAX_SAFE_INTEGER,
    });
    say(`control outcome=${verify.status} reason=${verify.failureReason ?? "-"}`);
    expect(verify.status).toBe("failed");
    expect(verify.failureReason ?? "").toMatch(/too long|context|exceed|token/i);
  }, 1_800_000);

  it("POSITIVE CONTROL: a failed pass reaches the channel carrying its reason", async () => {
    const { adapter } = await createClaudeHarness({ env: process.env });
    if (!adapter) return;
    const broadcast: { commandId: string; event: ProjectProcessEvent }[] = [];
    const runtime = createKnowledgeSwarmRuntime({
      store: new ProjectSnapshotStore(mkdtempSync(join(tmpdir(), "c22-empty-"))),
      resolveClaudePort: async () => adapter,
      resolveCodexExecutor: async () => null,
      narrate: (event) => broadcast.push({ commandId: PROACTIVE_REHYDRATION_COMMAND_ID, event }),
    });
    // A repo the scratch store has no snapshot for: a real non-`ok` outcome
    // through the real runtime, no stubbing.
    const outcome = await runtime.runForRepo({
      repoKey: "c22-no-such-repo",
      repoRoot: SUBJECT,
      toOid: "0".repeat(40),
    });
    say(`surfacing control outcome=${outcome.status}`);
    expect(outcome.status).not.toBe("ok");
    if (outcome.status === "ok") return;
    const carried = broadcast.find(
      (entry) =>
        entry.commandId === PROACTIVE_REHYDRATION_COMMAND_ID &&
        entry.event.kind === "stage" &&
        entry.event.detail === outcome.reason,
    );
    say(`surfacing control narrated: ${JSON.stringify(carried?.event)}`);
    expect(carried, "the reason must reach the channel the client subscribes to").toBeDefined();
  });
});
