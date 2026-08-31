import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PartitionSlice, PartitionWorkerResult } from "@rennet/core";
import { KNOWLEDGE_SWARM_GENERATOR_ID, knowledgeStatementId } from "@rennet/core";
import type { KnowledgeStatement } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  type JournalTarget,
  journalKey,
  journalTargetDir,
  KNOWLEDGE_SCOPE_PLAN_FILE,
  KnowledgeJournal,
  type ScopePlanJournalInput,
  type ScopePlanJournalResult,
  STALE_TARGET_AGE_MS,
} from "./knowledge-journal";

// ─────────────────────────────────────────────────────────────────────────────
// The journal's REFUSALS. Shape validation alone accepts any well-formed JSON,
// so every check below is paired with its positive control: the same record with
// the one damaged field put back must read. A refusal test that would also refuse
// a healthy record proves nothing about the check it is named for.
// ─────────────────────────────────────────────────────────────────────────────

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rennet-journal-"));
  scratch.push(dir);
  return dir;
}

const TARGET: JournalTarget = {
  baseOid: "a".repeat(40),
  snapshotFingerprint: "fp-1",
  generator: KNOWLEDGE_SWARM_GENERATOR_ID,
};

const SLICE: PartitionSlice = {
  id: "mod:src/a.ts#aaaaaaaa",
  files: [
    { path: "src/a.ts", blobOid: "blob-a" },
    { path: "src/b.ts", blobOid: "blob-b" },
  ],
  neighbors: [],
};

const SCOPE_PLAN_INPUT = {
  selectorGenerator: "map-scope@1",
  catalogueDigest: "catalogue-1",
  sliceCap: 2,
  candidateSliceIds: ["mod:src/a.ts#aaaaaaaa", "mod:src/b.ts#bbbbbbbb", "dir:docs"],
  assignment: { harness: "codex", model: "gpt-5.6-terra", effort: "medium" },
} satisfies ScopePlanJournalInput;

const SCOPE_PLAN_RESULT = {
  includedSliceIds: ["mod:src/a.ts#aaaaaaaa", "mod:src/b.ts#bbbbbbbb"],
  excludedSlices: [{ sliceId: "dir:docs", reason: "documentation is not load-bearing" }],
  provenance: { generator: "map-scope@1", model: "gpt-5.6-terra", apiKeySource: null },
} satisfies ScopePlanJournalResult;

/** A statement whose id is correct for its content unless `id` overrides it. */
function statement(input?: {
  claim?: string;
  evidence?: readonly { path: string; blobOid: string }[];
  id?: string;
  learnedAgainst?: KnowledgeStatement["learnedAgainst"];
}): KnowledgeStatement {
  const claim = input?.claim ?? "a is the entry point";
  const evidence = [...(input?.evidence ?? [{ path: "src/a.ts", blobOid: "blob-a" }])];
  const core = { subject: "src", aspect: "purpose" as const, claim, evidence };
  return {
    ...core,
    id: input?.id ?? knowledgeStatementId(core),
    confidence: "high",
    status: "hypothesis",
    provenance: { generator: TARGET.generator, model: "worker", apiKeySource: null },
    learnedAgainst: input?.learnedAgainst ?? {
      baseOid: TARGET.baseOid,
      snapshotFingerprint: TARGET.snapshotFingerprint,
    },
  };
}

function result(statements: readonly KnowledgeStatement[]): PartitionWorkerResult {
  return {
    sliceId: SLICE.id,
    status: "ok",
    statements: statements.map((s) => ({ statement: s })),
    droppedAnchors: 0,
    droppedStatements: 1,
    attempts: 2,
  };
}

function entryPath(dir: string, target: JournalTarget = TARGET): string {
  return join(dir, journalTargetDir(target), `${journalKey(target, SLICE)}.json`);
}

function scopePlanPath(dir: string, target: JournalTarget = TARGET): string {
  return join(dir, journalTargetDir(target), KNOWLEDGE_SCOPE_PLAN_FILE);
}

describe("KnowledgeJournal", () => {
  it("round-trips a checked scope plan without counting it as a worker entry", () => {
    const dir = scratchDir();
    const journal = new KnowledgeJournal(dir);

    journal.writeScopePlan(TARGET, SCOPE_PLAN_INPUT, SCOPE_PLAN_RESULT);

    expect(journal.readScopePlan(TARGET, SCOPE_PLAN_INPUT)).toEqual(SCOPE_PLAN_RESULT);
    expect(journal.size(TARGET)).toBe(0);

    journal.write(TARGET, SLICE, result([statement()]));
    expect(journal.size(TARGET)).toBe(1);
    expect(journal.readScopePlan(TARGET, SCOPE_PLAN_INPUT)).toEqual(SCOPE_PLAN_RESULT);
  });

  it("refuses a scope plan whose canonical bytes no longer match its checksum", () => {
    const dir = scratchDir();
    const journal = new KnowledgeJournal(dir);
    journal.writeScopePlan(TARGET, SCOPE_PLAN_INPUT, SCOPE_PLAN_RESULT);
    const path = scopePlanPath(dir);
    const healthy = readFileSync(path, "utf8");

    // Positive control: this exact record reads before and after the one-field damage.
    expect(journal.readScopePlan(TARGET, SCOPE_PLAN_INPUT)).toEqual(SCOPE_PLAN_RESULT);
    const damaged = JSON.parse(healthy) as {
      excludedSlices: { sliceId: string; reason: string }[];
    };
    damaged.excludedSlices[0] = {
      sliceId: "dir:docs",
      reason: "edited after the selector returned",
    };
    writeFileSync(path, JSON.stringify(damaged));
    expect(journal.readScopePlan(TARGET, SCOPE_PLAN_INPUT)).toBeNull();

    writeFileSync(path, healthy);
    expect(journal.readScopePlan(TARGET, SCOPE_PLAN_INPUT)).toEqual(SCOPE_PLAN_RESULT);
  });

  it("refuses a scope plan copied from a foreign target", () => {
    const dir = scratchDir();
    const journal = new KnowledgeJournal(dir);
    journal.writeScopePlan(TARGET, SCOPE_PLAN_INPUT, SCOPE_PLAN_RESULT);
    const foreign = { ...TARGET, baseOid: "f".repeat(40) };
    const foreignDir = join(dir, journalTargetDir(foreign));
    mkdirSync(foreignDir, { recursive: true });
    writeFileSync(scopePlanPath(dir, foreign), readFileSync(scopePlanPath(dir), "utf8"));

    expect(journal.readScopePlan(foreign, SCOPE_PLAN_INPUT)).toBeNull();
    expect(journal.readScopePlan(TARGET, SCOPE_PLAN_INPUT)).toEqual(SCOPE_PLAN_RESULT);
  });

  it.each([
    ["selector generator", { ...SCOPE_PLAN_INPUT, selectorGenerator: "map-scope@2" }],
    ["catalogue digest", { ...SCOPE_PLAN_INPUT, catalogueDigest: "catalogue-2" }],
    ["slice cap", { ...SCOPE_PLAN_INPUT, sliceCap: 1 }],
    [
      "resolved assignment",
      {
        ...SCOPE_PLAN_INPUT,
        assignment: { harness: "claude-code", model: "sonnet-5", effort: "medium" },
      },
    ],
  ] satisfies readonly (readonly [string, ScopePlanJournalInput])[])(
    "refuses a scope plan for a foreign %s",
    (_label, foreignInput) => {
      const journal = new KnowledgeJournal(scratchDir());
      journal.writeScopePlan(TARGET, SCOPE_PLAN_INPUT, SCOPE_PLAN_RESULT);

      expect(journal.readScopePlan(TARGET, foreignInput)).toBeNull();
      expect(journal.readScopePlan(TARGET, SCOPE_PLAN_INPUT)).toEqual(SCOPE_PLAN_RESULT);
    },
  );

  it.each([
    [
      "an unknown slice",
      {
        ...SCOPE_PLAN_RESULT,
        includedSliceIds: ["unknown", "mod:src/b.ts#bbbbbbbb"],
      },
    ],
    ["an uncovered candidate", { ...SCOPE_PLAN_RESULT, excludedSlices: [] }],
    [
      "more included slices than the cap",
      {
        ...SCOPE_PLAN_RESULT,
        includedSliceIds: [...SCOPE_PLAN_INPUT.candidateSliceIds],
        excludedSlices: [],
      },
    ],
    [
      "a duplicate slice",
      {
        ...SCOPE_PLAN_RESULT,
        excludedSlices: [
          ...SCOPE_PLAN_RESULT.excludedSlices,
          { sliceId: "mod:src/a.ts#aaaaaaaa", reason: "duplicate" },
        ],
      },
    ],
    [
      "a blank exclusion reason",
      {
        ...SCOPE_PLAN_RESULT,
        excludedSlices: [{ sliceId: "dir:docs", reason: " " }],
      },
    ],
    [
      "foreign selector provenance",
      {
        ...SCOPE_PLAN_RESULT,
        provenance: { ...SCOPE_PLAN_RESULT.provenance, generator: "map-scope@2" },
      },
    ],
  ] satisfies readonly (readonly [string, ScopePlanJournalResult])[])(
    "does not persist a scope plan containing %s",
    (_label, invalid) => {
      const dir = scratchDir();
      const journal = new KnowledgeJournal(dir);

      journal.writeScopePlan(TARGET, SCOPE_PLAN_INPUT, invalid);

      expect(journal.readScopePlan(TARGET, SCOPE_PLAN_INPUT)).toBeNull();
      expect(() => readFileSync(scopePlanPath(dir), "utf8")).toThrow();
    },
  );

  it("round-trips a completed batch, counts and clears it", () => {
    const dir = scratchDir();
    const journal = new KnowledgeJournal(dir);
    journal.write(TARGET, SLICE, result([statement()]));

    const read = journal.read(TARGET, SLICE);
    expect(read?.statements.map((entry) => entry.statement.claim)).toEqual([
      "a is the entry point",
    ]);
    // The counters are the worker's own, not defaults quietly substituted.
    expect(read?.droppedStatements).toBe(1);
    expect(read?.attempts).toBe(2);
    expect(journal.size(TARGET)).toBe(1);

    journal.clear(TARGET);
    expect(journal.read(TARGET, SLICE)).toBeNull();
    expect(journal.size(TARGET)).toBe(0);
  });

  it("round-trips the structured off-slice hint without storing it in the statement", () => {
    const journal = new KnowledgeJournal(scratchDir());
    const completed: PartitionWorkerResult = {
      ...result([]),
      statements: [
        {
          statement: statement(),
          hint: { path: "lib/c.ts", coupling: "the library may share the dispatch contract" },
        },
      ],
    };

    journal.write(TARGET, SLICE, completed);

    const entry = journal.read(TARGET, SLICE)?.statements[0];
    expect(entry?.hint).toEqual({
      path: "lib/c.ts",
      coupling: "the library may share the dispatch contract",
    });
    expect(JSON.stringify(entry?.statement)).not.toContain("dispatch contract");
  });

  it("preserves worker signal ranking because the first statement leads its seam group", () => {
    const journal = new KnowledgeJournal(scratchDir());
    journal.write(
      TARGET,
      SLICE,
      result([statement({ claim: "highest signal" }), statement({ claim: "lower signal" })]),
    );

    expect(journal.read(TARGET, SLICE)?.statements.map((entry) => entry.statement.claim)).toEqual([
      "highest signal",
      "lower signal",
    ]);
  });

  it("reuses a legitimately EMPTY result rather than paying a turn to rediscover it", () => {
    // The decision, recorded: an empty statement list is a real worker answer — a
    // slice of assets, a batch the model found nothing worth claiming about — and it
    // is covered by the checksum like any other. Treating empty as "not journaled"
    // would re-run those batches on every retry forever. Emptiness arriving through
    // corruption fails the checksum instead, which is the case worth refusing.
    const journal = new KnowledgeJournal(scratchDir());
    journal.write(TARGET, SLICE, result([]));
    const read = journal.read(TARGET, SLICE);
    expect(read).not.toBeNull();
    expect(read?.statements).toEqual([]);
  });

  it("refuses a record whose bytes were edited after it was written", () => {
    const dir = scratchDir();
    const journal = new KnowledgeJournal(dir);
    journal.write(TARGET, SLICE, result([statement()]));
    const path = entryPath(dir);
    const healthy = readFileSync(path, "utf8");
    // The positive control first: untouched, this record reads.
    expect(journal.read(TARGET, SLICE)).not.toBeNull();

    // Still valid JSON, still the right shape, still the right target — a truncated
    // list is exactly what a half-written or hand-edited file looks like.
    const damaged = JSON.parse(healthy) as { statements: unknown[] };
    damaged.statements = [];
    writeFileSync(path, JSON.stringify(damaged));
    expect(journal.read(TARGET, SLICE)).toBeNull();

    // And back: the refusal is about the damage, not about the file being rewritten.
    writeFileSync(path, healthy);
    expect(journal.read(TARGET, SLICE)).not.toBeNull();
  });

  it("refuses a statement whose id does not match its own content", () => {
    // Written with a correct checksum, so only the id recomputation can catch it.
    // Every dedupe, disposition carry and verify verdict downstream keys on that id.
    const journal = new KnowledgeJournal(scratchDir());
    journal.write(TARGET, SLICE, result([statement({ id: "0".repeat(64) })]));
    expect(journal.read(TARGET, SLICE)).toBeNull();

    journal.write(TARGET, SLICE, result([statement()]));
    expect(journal.read(TARGET, SLICE)).not.toBeNull();
  });

  it("refuses a statement learned against a different baseline", () => {
    const journal = new KnowledgeJournal(scratchDir());
    journal.write(
      TARGET,
      SLICE,
      result([
        statement({ learnedAgainst: { baseOid: "b".repeat(40), snapshotFingerprint: "fp-1" } }),
      ]),
    );
    expect(journal.read(TARGET, SLICE)).toBeNull();

    // Same shape, same everything, learnedAgainst put back: it reads.
    journal.write(TARGET, SLICE, result([statement()]));
    expect(journal.read(TARGET, SLICE)).not.toBeNull();
  });

  it("refuses a checksummed statement attributed to another generator", () => {
    const journal = new KnowledgeJournal(scratchDir());
    const healthy = statement();
    const foreignGenerator = {
      ...healthy,
      provenance: {
        ...healthy.provenance,
        generator: `${TARGET.generator}-foreign`,
      },
    };

    // write() computes the current target's checksum over this exact statement.
    // The refusal therefore exercises embedded provenance, not checksum damage.
    journal.write(TARGET, SLICE, result([foreignGenerator]));
    expect(journal.read(TARGET, SLICE)).toBeNull();

    journal.write(TARGET, SLICE, result([healthy]));
    const recovered = journal.read(TARGET, SLICE);
    expect(recovered?.statements).toHaveLength(1);
    expect(recovered?.statements[0]?.statement.provenance.generator).toBe(TARGET.generator);
  });

  it("refuses a statement whose anchor is not in THIS slice at THIS content", () => {
    const journal = new KnowledgeJournal(scratchDir());
    // A path the slice does not hold at all.
    journal.write(
      TARGET,
      SLICE,
      result([statement({ evidence: [{ path: "lib/c.ts", blobOid: "blob-c" }] })]),
    );
    expect(journal.read(TARGET, SLICE)).toBeNull();

    // A path it does hold, at bytes it does not: the same refusal, and the one a
    // path-only check would miss.
    journal.write(
      TARGET,
      SLICE,
      result([statement({ evidence: [{ path: "src/a.ts", blobOid: "blob-STALE" }] })]),
    );
    expect(journal.read(TARGET, SLICE)).toBeNull();

    journal.write(
      TARGET,
      SLICE,
      result([statement({ evidence: [{ path: "src/b.ts", blobOid: "blob-b" }] })]),
    );
    expect(journal.read(TARGET, SLICE)).not.toBeNull();
  });

  it("refuses a result written for another generator or another extraction", () => {
    const journal = new KnowledgeJournal(scratchDir());
    journal.write(TARGET, SLICE, result([statement()]));
    // Same git OID, same slice, same membership — a prompt rework or a re-extraction
    // is still a different question, and the old answer is not an answer to it.
    expect(journal.read({ ...TARGET, generator: "knowledge-swarm@3" }, SLICE)).toBeNull();
    expect(journal.read({ ...TARGET, snapshotFingerprint: "fp-2" }, SLICE)).toBeNull();
    expect(journal.read(TARGET, SLICE)).not.toBeNull();
  });

  it("does not reuse a bare fallback id after its exact membership grows", () => {
    const journal = new KnowledgeJournal(scratchDir());
    const original: PartitionSlice = {
      id: "dir:docs",
      files: [{ path: "src/a.ts", blobOid: "blob-a" }],
      neighbors: [],
    };
    const enlarged: PartitionSlice = {
      ...original,
      files: [...original.files, { path: "src/b.ts", blobOid: "blob-b" }],
    };
    journal.write(TARGET, original, result([statement()]));

    expect(journal.read(TARGET, enlarged)).toBeNull();
    expect(journal.read(TARGET, original)).not.toBeNull();
  });

  // ── Concurrency: one directory per target ─────────────────────────────────

  it("clears only its OWN target, leaving a concurrent run's journal intact", () => {
    // The failure this partitioning exists to stop: two runs at two baselines, the
    // first to promote deleting the second's completed turns with a recursive
    // remove of the whole journal.
    const dir = scratchDir();
    const journal = new KnowledgeJournal(dir);
    const other: JournalTarget = { ...TARGET, baseOid: "c".repeat(40) };
    const otherStatement = statement({
      learnedAgainst: { baseOid: other.baseOid, snapshotFingerprint: other.snapshotFingerprint },
    });
    journal.write(TARGET, SLICE, result([statement()]));
    journal.write(other, SLICE, result([otherStatement]));
    expect(journal.size(TARGET)).toBe(1);
    expect(journal.size(other)).toBe(1);

    journal.clear(TARGET);
    expect(journal.size(TARGET)).toBe(0);
    expect(journal.size(other)).toBe(1);
    expect(journal.read(other, SLICE)).not.toBeNull();
  });

  it("keeps two targets at ONE base OID apart, so clearing either spares the other", () => {
    // The finer grain of the same bug. Both runs sit at the same git OID and differ
    // only in what shaped their answers — a re-extraction (`snapshotFingerprint`) or a
    // prompt rework (`generator`). A directory named for the base OID alone put all
    // three in one place, so the first to promote deleted the others' completed turns.
    const dir = scratchDir();
    const journal = new KnowledgeJournal(dir);
    const reExtracted: JournalTarget = { ...TARGET, snapshotFingerprint: "fp-2" };
    const reworked: JournalTarget = { ...TARGET, generator: "knowledge-swarm@6" };
    for (const target of [TARGET, reExtracted, reworked]) {
      journal.write(target, SLICE, result([statement()]));
      expect(journal.size(target)).toBe(1);
    }
    // Three distinct directories under one base OID — the property, stated as a count
    // rather than inferred from the survivors below.
    expect(readdirSync(dir)).toHaveLength(3);

    journal.clear(TARGET);
    expect(journal.size(TARGET)).toBe(0);
    expect(journal.size(reExtracted)).toBe(1);
    expect(journal.size(reworked)).toBe(1);
  });

  it("sweeps a target directory nobody has touched in a day, and spares a fresh one", () => {
    const dir = scratchDir();
    const abandoned: JournalTarget = { ...TARGET, baseOid: "d".repeat(40) };
    new KnowledgeJournal(dir).write(abandoned, SLICE, result([statement()]));

    // The control first, and it is the important half: at the real clock, that
    // directory is minutes old and a promotion must leave it exactly where it is —
    // a sweep that cannot tell "abandoned" from "in flight" is the bug it replaced.
    const live = new KnowledgeJournal(dir);
    live.write(TARGET, SLICE, result([statement()]));
    live.clear(TARGET);
    expect(readdirSync(dir)).toEqual([journalTargetDir(abandoned)]);

    // A day later, the same directory is a dead run's leftovers.
    const later = new KnowledgeJournal(dir, () => Date.now() + STALE_TARGET_AGE_MS + 1_000);
    later.write(TARGET, SLICE, result([statement()]));
    later.clear(TARGET);
    expect(readdirSync(dir)).toEqual([]);
  });
});
