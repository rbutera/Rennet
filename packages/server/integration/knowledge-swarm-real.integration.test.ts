import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  councilSeatTurn,
  createClaudeHarness,
  execaGit,
  ProjectContextReader,
  ProjectSnapshotGenerator,
  ProjectSnapshotStore,
  resolveBaseRef,
  snapshotContextFromLoaded,
} from "@rennet/adapters";
import type {
  KnowledgeSnapshotContext,
  PartitionWorkerResult,
  WorkerStatement,
} from "@rennet/core";
import {
  boundedAll,
  buildPartitions,
  MAP_VERIFY_OUTPUT_SCHEMA,
  PARTITION_WORKER_OUTPUT_SCHEMA,
  runMapVerify,
  runPartitionWorker,
} from "@rennet/core";
import type { ProjectProcessEvent } from "@rennet/protocol";
import { proactiveRehydrationCommandId } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createKnowledgeSwarmRuntime } from "../src/runtime/knowledge-swarm";

/**
 * The c22 RELEASE-BLOCKER proof. Not part of the hermetic gate (`pnpm check`
 * runs `vitest run packages/server/src`, which never reaches this directory)
 * and dormant without the env flag, because it spends the subscription:
 *
 *     RENNET_C22_PROOF=1 pnpm nx run rennet-server:real-knowledge
 *
 * WHAT IS ACTUALLY UNDER TEST: the verify seat used to receive EVERY
 * partition's statements in ONE prompt. On a repository the size of Rennet
 * (~1900 statements) that prompt exceeds the seat's context window, the seat
 * dies with "Prompt is too long", and the entire run is discarded. So the thing
 * to prove is that REAL statements at REAL volume chunk and verify.
 *
 * The 200-partition walk is deliberately NOT part of this proof. It costs 67
 * minutes, it exercises the worker fan-out rather than the verify seat, and its
 * configuration (cap 4, 200 partitions) is already slated for deletion in #584
 * — proving the correctness of something we have decided to delete is ceremony
 * with a long runtime. A small real slice supplies genuine minted statements;
 * those statements are scaled to production volume for the seat.
 *
 * A unit test cannot stand in for any of this: nothing hermetic has a context
 * window, which is exactly why a green unit suite hid the bug.
 *
 * STATED LIMITATION — read this before trusting the proof. The 6 minted slices
 * yield ~44 UNIQUE statements, so reaching 1900 clones them ~43x under fresh
 * ids. Every claim, subject, aspect and evidence anchor is genuine model
 * output; only the id is synthetic. So the prompt the seat receives is faithful
 * in SIZE and in the shape of each hypothesis, and repetitive in CONTENT in a
 * way a real 1900-statement set would not be.
 *
 * What that DOES establish: a 1900-hypothesis prompt overflows the seat, the
 * chunked path does not, and both were measured on the same input through the
 * same live seat. Prompt-size overflow is the bug, and prompt size is faithful.
 *
 * What it does NOT establish: anything about verdict QUALITY at scale — whether
 * the seat adjudicates 1900 varied hypotheses well, or whether chunk-local
 * cross-cutting synthesis loses reach against a genuinely diverse set. Content
 * variety was deliberately not purchased (~17s per extra slice) because it is
 * not the property under test.
 *
 * MEASURED RESULT, 2026-08-28, against Rennet itself (200 partitions) on a
 * quiet host, `PROOF_EXIT=0`, 3/3 tests passed, run duration 1341s:
 *
 *   minted   39 real statements from 6 real slices in 115s, scaled to 1900
 *   CHUNKED   ok in 1210s — confirmed=1683 rejected=42 crossCutting=61,
 *             producing a set of 1961 statements, no overflow
 *   UNBOUNDED failed, reason verbatim: "Prompt is too long"
 *   SURFACING outcome=snapshot-unavailable narrated on
 *             `proactive:rehydration` as {note:"Knowledge pass has no fresh
 *             snapshot", detail:"absent"} — the reason reaches the client
 *
 * The A/B is the proof: SAME 1900 statements, SAME live seat, one prompt dies
 * and thirteen chunks do not.
 */

const LIVE = process.env.RENNET_C22_PROOF === "1";
const SUBJECT = process.env.RENNET_C22_REPO ?? process.cwd();
/** How many real partitions to mint from. Enough for genuine variety, minutes not hours. */
const SLICES = Number(process.env.RENNET_C22_SLICES ?? "6");
/** The statement volume the seat must survive — Rennet's own measured ~1900. */
const TARGET = Number(process.env.RENNET_C22_TARGET ?? "1900");

const say = (line: string) => process.stderr.write(`[c22] ${line}\n`);

/** Real minted statements, scaled to `TARGET` by cloning under fresh ids. */
let scaled: readonly WorkerStatement[] | undefined;
let context: KnowledgeSnapshotContext | undefined;

describe.skipIf(!LIVE)("c22 — the verify seat at real statement volume", () => {
  it("chunks and verifies ~1900 real statements without overflowing the seat", async () => {
    const { adapter, discovery } = await createClaudeHarness({ env: process.env });
    expect(adapter, `no claude discovered: ${JSON.stringify(discovery.health)}`).not.toBeNull();
    if (!adapter) return;

    const baseDir = mkdtempSync(join(tmpdir(), "c22-proof-"));
    const store = new ProjectSnapshotStore(baseDir);
    const base = await resolveBaseRef(SUBJECT, { git: execaGit });
    await new ProjectSnapshotGenerator({ store }).generate(SUBJECT, {
      explicitBaseRef: base.baseOid,
    });
    const gated = new ProjectContextReader(store).loadFresh(base.repoKey, base.baseOid);
    expect(gated.ok, "the subject snapshot must be fresh").toBe(true);
    if (!gated.ok) return;
    const snapshot = snapshotContextFromLoaded(gated.snapshot);
    context = snapshot;

    const partitions = buildPartitions(snapshot);
    say(`subject ${SUBJECT}: ${partitions.length} partitions, minting from ${SLICES}`);

    // Real workers on real Rennet code through the real council seat.
    const worker = councilSeatTurn(
      "partition-worker",
      PARTITION_WORKER_OUTPUT_SCHEMA,
      { claudePort: adapter, repoRoot: SUBJECT, label: "knowledge.worker" },
      { availability: { installed: ["claude-code"] } },
    );
    expect("failure" in worker ? worker.failure : "").toBe("");
    if ("failure" in worker) return;

    const mintStart = Date.now();
    const results = await boundedAll(
      partitions.slice(0, SLICES).map((slice) => async () => {
        const result = await runPartitionWorker({
          slice,
          snapshot,
          provenance: { model: worker.model, apiKeySource: null },
          runTurn: worker.runTurn,
        });
        say(
          `worker ${slice.id} ${result.status} ` +
            `${result.status === "ok" ? `${result.statements.length} statements` : ""}`,
        );
        return result;
      }),
      3,
    );
    const minted = results.flatMap((r) => (r.status === "ok" ? r.statements : []));
    say(
      `minted ${minted.length} real statements in ${Math.round((Date.now() - mintStart) / 1000)}s`,
    );
    expect(minted.length).toBeGreaterThan(0);

    // Scale to production volume. Cloning under fresh ids keeps every
    // statement a REAL shape — real claims, real evidence anchors, real
    // subjects — so the prompt the seat receives is the size and texture of
    // the one that killed it. Only the id is synthetic.
    const grown: WorkerStatement[] = [];
    for (let i = 0; grown.length < TARGET; i += 1) {
      for (const entry of minted) {
        if (grown.length >= TARGET) break;
        grown.push(
          i === 0
            ? entry
            : { ...entry, statement: { ...entry.statement, id: `${entry.statement.id}-c22x${i}` } },
        );
      }
    }
    scaled = grown;
    say(`scaled to ${grown.length} statements for the verify seat`);

    const verifySeat = councilSeatTurn(
      "map-verify",
      MAP_VERIFY_OUTPUT_SCHEMA,
      { claudePort: adapter, repoRoot: SUBJECT, label: "knowledge.verify" },
      { availability: { installed: ["claude-code"] } },
    );
    expect("failure" in verifySeat ? verifySeat.failure : "").toBe("");
    if ("failure" in verifySeat) return;

    const verifyStart = Date.now();
    const verify = await runMapVerify({
      workerResults: [workerResult(grown)],
      snapshot,
      provenance: { model: verifySeat.model, apiKeySource: null },
      runTurn: verifySeat.runTurn,
    });
    say(
      `CHUNKED verify: ${verify.status} in ${Math.round((Date.now() - verifyStart) / 1000)}s ` +
        `confirmed=${verify.confirmed} rejected=${verify.rejected} ` +
        `crossCutting=${verify.crossCutting} reason=${verify.failureReason ?? "-"}`,
    );
    expect(verify.failureReason ?? "").not.toMatch(/too long/i);
    expect(verify.status).toBe("ok");
    expect(verify.set?.statements.length ?? 0).toBeGreaterThan(0);
    say(`CHUNKED produced a set of ${verify.set?.statements.length} statements`);
  }, 3_600_000);

  it("POSITIVE CONTROL: the SAME statements in ONE unbounded prompt still die", async () => {
    expect(scaled, "the green run must have produced scaled statements").toBeDefined();
    if (!scaled || !context) return;
    const { adapter } = await createClaudeHarness({ env: process.env });
    if (!adapter) return;

    const seat = councilSeatTurn(
      "map-verify",
      MAP_VERIFY_OUTPUT_SCHEMA,
      { claudePort: adapter, repoRoot: SUBJECT, label: "knowledge.verify" },
      { availability: { installed: ["claude-code"] } },
    );
    if ("failure" in seat) return;

    say(`control: ${scaled.length} statements in ONE prompt (the pre-fix path)`);
    const verify = await runMapVerify({
      workerResults: [workerResult(scaled)],
      snapshot: context,
      provenance: { model: seat.model, apiKeySource: null },
      runTurn: seat.runTurn,
      maxRetries: 0,
      // The pre-fix behaviour, restored on purpose: one prompt for the lot.
      chunkSize: Number.MAX_SAFE_INTEGER,
    });
    say(`UNBOUNDED verify: ${verify.status} reason=${verify.failureReason ?? "-"}`);
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
      narrate: (projectId, event) =>
        broadcast.push({ commandId: proactiveRehydrationCommandId(projectId), event }),
    });
    // A repo the scratch store has no snapshot for: a real non-`ok` outcome
    // through the real runtime, no stubbing.
    const outcome = await runtime.runForRepo({
      projectId: "c22-project",
      repoKey: "c22-no-such-repo",
      repoRoot: SUBJECT,
      toOid: "0".repeat(40),
    });
    say(`surfacing control outcome=${outcome.status}`);
    expect(outcome.status).not.toBe("ok");
    if (outcome.status === "ok") return;
    const carried = broadcast.find(
      (entry) =>
        entry.commandId === proactiveRehydrationCommandId("c22-project") &&
        entry.event.kind === "stage" &&
        entry.event.detail === outcome.reason,
    );
    say(`surfacing control narrated: ${JSON.stringify(carried?.event)}`);
    expect(carried, "the reason must reach the channel the client subscribes to").toBeDefined();
  });
});

function workerResult(statements: readonly WorkerStatement[]): PartitionWorkerResult {
  return {
    sliceId: "c22:scaled",
    status: "ok",
    statements,
    droppedAnchors: 0,
    droppedStatements: 0,
    attempts: 1,
  };
}
