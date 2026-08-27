/**
 * Packet E2E (B06 cluster 7, reconciliation 5): the swarm plumbing runs against
 * THIS repository's REAL snapshot (file inventory + blobOids straight from
 * `git ls-tree`, scopes from the actual workspace layout) with a deterministic
 * stub `runTurn` that derives canned statements from the slice it is handed.
 * No model anywhere; the council-routed real path is proven by the adapters
 * contract tests.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { HarnessTurnResult } from "../harness-run-turn";
import { planReverify, routeDelta } from "./incremental";
import type { KnowledgeSnapshotContext } from "./mint";
import { buildPartitions, type PartitionSlice } from "./partition";
import { type PartitionWorkerResult, runMapVerify, runPartitionWorker } from "./swarm";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// ls-tree scopes its output to the cwd's tree prefix — run everything from the repo root.
const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: HERE,
  encoding: "utf8",
}).trim();

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Build the real snapshot: every tracked file at HEAD with its actual blobOid. */
function realSnapshot(): KnowledgeSnapshotContext {
  const baseOid = git(["rev-parse", "HEAD"]).trim();
  const files = git(["ls-tree", "-r", "-z", "--format=%(objectname)\t%(path)", "HEAD"])
    .split("\0")
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { blobOid: line.slice(0, tab), path: line.slice(tab + 1) };
    });
  // Scopes from the actual workspace layout: one per packages/* and apps/* dir.
  const roots = new Set<string>();
  for (const file of files) {
    const match = /^((?:packages|apps)\/[^/]+)\//.exec(file.path);
    if (match?.[1] !== undefined) roots.add(match[1]);
  }
  const scopes = [...roots].sort().map((root) => ({ name: root, root }));
  return { repoKey: "rennet-e2e", baseOid, snapshotFingerprint: `fp-${baseOid}`, files, scopes };
}

const PROVENANCE = { model: "stub", apiKeySource: null };

/** The deterministic worker stub: one statement derived from the slice it is handed. */
function workerStub(slice: PartitionSlice): (prompt: string) => Promise<HarnessTurnResult> {
  const first = slice.files[0];
  if (first === undefined) throw new Error(`empty slice ${slice.id}`);
  return async () => ({
    status: "emitted",
    body: {
      statements: [
        {
          subject: slice.id,
          aspect: "purpose",
          claim: `slice ${slice.id} anchors at ${first.path}`,
          confidence: "low",
          evidence: [{ path: first.path }],
          hint: `derived from ${slice.files.length} files`,
        },
      ],
    },
  });
}

async function runWorkers(
  slices: readonly PartitionSlice[],
  snapshot: KnowledgeSnapshotContext,
): Promise<PartitionWorkerResult[]> {
  return Promise.all(
    slices.map((slice) =>
      runPartitionWorker({ slice, snapshot, provenance: PROVENANCE, runTurn: workerStub(slice) }),
    ),
  );
}

describe("swarm e2e against this repository's real snapshot", () => {
  let snapshot: KnowledgeSnapshotContext;
  let partitions: readonly PartitionSlice[];

  beforeAll(() => {
    snapshot = realSnapshot();
    partitions = buildPartitions(snapshot);
  });

  it("partitions cover every in-scope file exactly once", () => {
    expect(snapshot.files.length).toBeGreaterThan(500); // a real repo, not a fixture
    expect(snapshot.scopes.length).toBeGreaterThan(5);
    const seen = new Map<string, string>();
    for (const slice of partitions) {
      for (const file of slice.files) {
        expect(
          seen.has(file.path),
          `${file.path} claimed by ${seen.get(file.path)} AND ${slice.id}`,
        ).toBe(false);
        seen.set(file.path, slice.id);
      }
    }
    expect(seen.size).toBe(snapshot.files.length);
  });

  it("every emitted statement's anchors resolve against the snapshot inventory; carry after a baseline advance re-processes only the owning partition", async () => {
    const inventory = new Map(snapshot.files.map((file) => [file.path, file.blobOid]));
    const workerResults = await runWorkers(partitions, snapshot);
    for (const result of workerResults) {
      expect(result.status).toBe("ok");
      expect(result.statements.length).toBe(1);
      expect(result.droppedStatements).toBe(0);
      expect(result.droppedAnchors).toBe(0);
    }
    const verify = await runMapVerify({
      workerResults,
      snapshot,
      provenance: PROVENANCE,
      runTurn: async () => ({
        status: "emitted",
        body: {
          verdicts: [{ id: workerResults[0]?.statements[0]?.statement.id, verdict: "confirmed" }],
          crossCutting: [],
        },
      }),
    });
    expect(verify.status).toBe("ok");
    const set = verify.set;
    if (set === undefined) throw new Error("verify returned no set");
    expect(set.statements.length).toBe(partitions.length);
    // The anchors-resolve assert: every anchor's blobOid IS the inventory's.
    for (const statement of set.statements) {
      for (const anchor of statement.evidence) {
        expect(anchor.blobOid).toBe(inventory.get(anchor.path));
      }
    }

    // Baseline advance: one touched file re-processes ONLY its owning partition.
    // Touch a file the stub actually cited, so the reverify arm engages too.
    const touched = partitions[0]?.files[0]?.path;
    if (touched === undefined) throw new Error("no partitions");
    expect(inventory.has(touched)).toBe(true);
    const routed = routeDelta(partitions, [touched]);
    expect(routed.length).toBe(1);
    expect(routed[0]?.files.some((file) => file.path === touched)).toBe(true);

    // Carry: untouched statements ride through byte-identical; only statements
    // citing the touched path re-verify.
    const before = new Map(set.statements.map((s) => [s.id, JSON.stringify(s)]));
    const plan = planReverify(set, [touched]);
    expect(plan.reverify.length + plan.carried.length).toBe(set.statements.length);
    expect(plan.reverify.length).toBeGreaterThan(0);
    for (const statement of plan.reverify) {
      expect(statement.evidence.some((anchor) => anchor.path === touched)).toBe(true);
    }
    for (const statement of plan.carried) {
      expect(JSON.stringify(statement)).toBe(before.get(statement.id));
    }

    // Second run: re-run exactly the routed workers; merged output keeps the
    // carried statements byte-identical.
    const rerun = await runWorkers(routed, snapshot);
    expect(rerun.length).toBe(1);
    const merged = [...plan.carried, ...rerun.flatMap((r) => r.statements.map((s) => s.statement))];
    expect(merged.length).toBe(set.statements.length);
    for (const statement of plan.carried) {
      const after = merged.find((s) => s.id === statement.id);
      expect(JSON.stringify(after)).toBe(before.get(statement.id));
    }
  });
});
