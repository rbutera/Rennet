import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodexExecRequest,
  CodexExecResult,
  HarnessPort,
  HarnessSession,
  LoadedSnapshot,
  PartitionSlice,
} from "@rennet/core";
import {
  KNOWLEDGE_SWARM_GENERATOR_ID,
  MAP_VERIFY_OUTPUT_SCHEMA,
  PARTITION_WORKER_OUTPUT_SCHEMA,
} from "@rennet/core";
import type { KnowledgeSet, KnowledgeStatement } from "@rennet/protocol";
import { KNOWLEDGE_SCHEMA_VERSION } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { GitExec } from "./git-range-diff";
import { type JournalTarget, KnowledgeJournal } from "./knowledge-journal";
import { DEFAULT_SWARM_CONCURRENCY, runKnowledgeSwarmForRepo } from "./knowledge-swarm";
import type { LoadFreshResult } from "./project-context-reader";

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT tests for the real council-routed path (reconciliation 5): the swarm
// resolves `partition-worker`/`map-verify` per availability scenario and lands
// each turn on the RIGHT harness port with the RIGHT model/effort and the RIGHT
// output schema. No live model call anywhere — both harness seams are fakes
// that capture what they were handed and answer canned statements.
// ─────────────────────────────────────────────────────────────────────────────

/** A snapshot fixture with two scopes (⇒ two partitions) and anchored files. */
const SNAPSHOT = {
  manifest: { repoKey: "repo", baseOid: "oid-1", fingerprint: "fp-1" },
  files: [
    { path: "a/one.ts", blobOid: "blob-a1" },
    { path: "b/two.ts", blobOid: "blob-b1" },
  ],
  scopes: [
    { name: "a", root: "a" },
    { name: "b", root: "b" },
  ],
  // No per-blob shards: the fixture pins the COUNCIL contract, not partitioning, so
  // it presents a snapshot with an empty (but present, and honestly readable) shard
  // index. Every file is then edge-less and lands in the directory fallback tier —
  // the two scope slices this suite expects.
  entryPoints: [],
  symbolDigestByBlob: new Map<string, string>(),
  referenceDigestByBlob: new Map<string, string>(),
  importDigestByBlob: new Map<string, string>(),
  load: () => undefined,
} as unknown as LoadedSnapshot;

/**
 * The same two files at the PRIOR baseline, with `a/one.ts` at different bytes.
 *
 * A reader that answered the same snapshot for every OID would make the W4 signature
 * diff see one blobOid on both sides of the delta and call the change cosmetic — a
 * fixture lying its way into "nothing to do". The prior snapshot has no symbol shards
 * either (see {@link SNAPSHOT}), so the diff cannot read a signature for either blob
 * and falls back to structural, which is the honest verdict for "we cannot tell".
 */
const PRIOR_SNAPSHOT = {
  ...SNAPSHOT,
  manifest: { repoKey: "repo", baseOid: "oid-0", fingerprint: "fp-0" },
  files: [
    { path: "a/one.ts", blobOid: "blob-a0" },
    { path: "b/two.ts", blobOid: "blob-b1" },
  ],
} as unknown as LoadedSnapshot;

/**
 * The prior baseline with the CURRENT snapshot's file inventory — so every changed
 * path has one blobOid on both sides and classifies cosmetic — carrying the
 * fingerprint the stored set records as the one it was learned against (`fp-0`).
 *
 * That fingerprint is not decoration. A manifest at an OID is overwritten in place by
 * a re-extraction, so a prior loaded by OID alone may be a DIFFERENT view of the same
 * commit than the statements were learned against, and the swarm refuses to classify
 * against it. This fixture is the case where the join genuinely holds.
 */
const COMPARABLE_PRIOR_SNAPSHOT = {
  ...SNAPSHOT,
  manifest: { repoKey: "repo", baseOid: "oid-0", fingerprint: "fp-0" },
} as unknown as LoadedSnapshot;

const READER = {
  loadFresh: (_repoKey: string, oid: string) => ({
    ok: true as const,
    snapshot: oid === "oid-0" ? PRIOR_SNAPSHOT : SNAPSHOT,
  }),
};

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): {
  saved: KnowledgeSet[];
  store: {
    loadLocal: () => KnowledgeSet | null;
    save: (repoKey: string, set: KnowledgeSet) => void;
    journalDir: () => string;
  };
} {
  const saved: KnowledgeSet[] = [];
  // A real, isolated journal home per fixture: these tests do not exercise the
  // journal, but they must not share one either — a leaked entry from a sibling
  // test would answer a batch this one meant to run.
  const journal = mkdtempSync(join(tmpdir(), "rennet-swarm-journal-"));
  scratch.push(journal);
  return {
    saved,
    store: {
      loadLocal: () => null,
      save: (_repoKey, set) => {
        saved.push(set);
      },
      journalDir: () => journal,
    },
  };
}

interface ClaudeCapture {
  readonly model: string | undefined;
  readonly outputSchema: unknown;
}

/** A fake Claude port capturing createSession options and emitting canned output. */
function fakeClaudePort(captures: ClaudeCapture[], body: () => unknown): HarnessPort {
  return {
    createSession: async (options: {
      model?: string;
      outputSchema?: unknown;
    }): Promise<HarnessSession> => {
      captures.push({ model: options.model, outputSchema: options.outputSchema });
      const session = {
        send: async () => {
          /* the fake accepts the prompt and answers via events */
        },
        close: async () => {
          /* nothing to release */
        },
        events: (async function* () {
          yield {
            kind: "session.ended",
            native: {},
            outcome: { status: "completed", structuredOutput: body() },
          };
        })(),
      };
      return session as unknown as HarnessSession;
    },
  } as unknown as HarnessPort;
}

/** A fake codex executor capturing each request and answering canned output. */
function fakeCodexExecutor(captures: CodexExecRequest[], body: (req: CodexExecRequest) => unknown) {
  return async (req: CodexExecRequest): Promise<CodexExecResult> => {
    captures.push(req);
    return { output: body(req) };
  };
}

/**
 * Every worker answers with a statement citing a/one.ts. For the `a` worker
 * that is in-slice and mints; for the `b` worker (a DISTINCT claim, so dedup
 * cannot mask the outcome) it is OFF-SLICE and must be dropped at mint —
 * partition isolation is enforced, not requested.
 */
const workerBody = (req?: { prompt?: string }): Record<string, unknown> => ({
  statements: [
    req?.prompt?.includes("b/two.ts")
      ? {
          subject: "b",
          aspect: "purpose",
          claim: "b cites another worker's slice",
          confidence: "high",
          evidence: [{ path: "a/one.ts" }],
        }
      : {
          subject: "a",
          aspect: "purpose",
          claim: "module a does a-things",
          confidence: "high",
          evidence: [{ path: "a/one.ts" }],
          hint: "pairs with b",
        },
  ],
});

const verifyBody = (): Record<string, unknown> => ({ verdicts: [], crossCutting: [] });

function wideSnapshot(partitions: number): LoadedSnapshot {
  const files = Array.from({ length: partitions }, (_, index) => ({
    path: `scope-${index}/file.ts`,
    blobOid: `blob-${index}`,
  }));
  return {
    manifest: { repoKey: "repo", baseOid: "oid-wide", fingerprint: "fp-wide" },
    files,
    scopes: files.map((_, index) => ({ name: `scope-${index}`, root: `scope-${index}` })),
    entryPoints: [],
    symbolDigestByBlob: new Map<string, string>(),
    referenceDigestByBlob: new Map<string, string>(),
    importDigestByBlob: new Map<string, string>(),
    load: () => undefined,
  } as unknown as LoadedSnapshot;
}

async function measureWorkerConcurrency(concurrency?: number): Promise<{
  readonly startedBeforeRelease: number;
  readonly peak: number;
  readonly outcome: Awaited<ReturnType<typeof runKnowledgeSwarmForRepo>>;
}> {
  let releaseWorkers: () => void = () => {
    throw new Error("worker gate was not initialised");
  };
  const workerGate = new Promise<void>((resolve) => {
    releaseWorkers = resolve;
  });
  let active = 0;
  let peak = 0;
  let started = 0;
  const { store } = makeStore();
  const outcomePromise = runKnowledgeSwarmForRepo({
    reader: { loadFresh: () => ({ ok: true as const, snapshot: wideSnapshot(17) }) },
    knowledgeStore: store,
    claudePort: fakeClaudePort([], verifyBody),
    codexExecutor: async () => {
      started += 1;
      active += 1;
      peak = Math.max(peak, active);
      await workerGate;
      active -= 1;
      return { output: { statements: [] } };
    },
    repoKey: "repo",
    repoRoot: "/repo",
    baseOid: "oid-wide",
    ...(concurrency === undefined ? {} : { concurrency }),
  });

  const startedBeforeRelease = started;
  releaseWorkers();
  const outcome = await outcomePromise;
  return { startedBeforeRelease, peak, outcome };
}

describe("knowledge swarm — council-routed contract (no live model)", () => {
  it("starts twelve worker turns by default and never exceeds that bound", async () => {
    expect(DEFAULT_SWARM_CONCURRENCY).toBe(12);

    const measured = await measureWorkerConcurrency();

    expect(measured.startedBeforeRelease).toBe(12);
    expect(measured.peak).toBe(12);
    expect(measured.outcome).toMatchObject({
      status: "ok",
      ranPartitions: 17,
      totalPartitions: 17,
    });
  });

  it("keeps the per-run worker limit load-bearing", async () => {
    const measured = await measureWorkerConcurrency(3);

    expect(measured.startedBeforeRelease).toBe(3);
    expect(measured.peak).toBe(3);
    expect(measured.outcome.status).toBe("ok");
  });

  it("both-scenario: workers land on codex (luna/low), verify on claude (sonnet-5), each with its schema", async () => {
    const claudeCaptures: ClaudeCapture[] = [];
    const codexCaptures: CodexExecRequest[] = [];
    const { saved, store } = makeStore();

    const outcome = await runKnowledgeSwarmForRepo({
      reader: READER,
      knowledgeStore: store,
      claudePort: fakeClaudePort(claudeCaptures, verifyBody),
      codexExecutor: fakeCodexExecutor(codexCaptures, workerBody),
      repoKey: "repo",
      repoRoot: "/repo",
      baseOid: "oid-1",
    });

    expect(outcome.status).toBe("ok");
    // Two scopes ⇒ two partition-worker turns, BOTH on the codex executor with
    // the council's both-scenario pick and the WORKER output schema, each ROOTED
    // AT THE CHECKOUT so the seat reads real files (review P0 — never a temp-dir
    // turn reasoning from filenames).
    expect(codexCaptures).toHaveLength(2);
    for (const req of codexCaptures) {
      expect(req.model).toBe("gpt-5.6-luna");
      expect(req.effort).toBe("low");
      expect(req.outputSchema).toBe(PARTITION_WORKER_OUTPUT_SCHEMA);
      expect(req.cwd).toBe("/repo");
      expect(req.mcpServers).toEqual({});
    }
    // One verify turn on the Claude port with sonnet-5 and the VERIFY schema.
    expect(claudeCaptures).toHaveLength(1);
    expect(claudeCaptures[0]?.model).toBe("sonnet-5");
    expect(claudeCaptures[0]?.outputSchema).toBe(MAP_VERIFY_OUTPUT_SCHEMA);
    // The set persisted, statements minted through the honesty contract, and the
    // worker's hint died at synthesis (never stored). The `b` worker's off-slice
    // citation was dropped at mint — exactly ONE statement survives, worker a's.
    expect(saved).toHaveLength(1);
    expect(saved[0]?.statements.map((s) => s.subject)).toEqual(["a"]);
    expect(JSON.stringify(saved[0])).not.toContain("another worker's slice");
    expect(JSON.stringify(saved[0])).not.toContain("pairs with b");
    // Provenance names the WORKER seat's resolved model, not null (review P2).
    expect(saved[0]?.statements[0]?.provenance.model).toBe("gpt-5.6-luna");
  });

  it("claude-only scenario: workers land on claude (haiku), verify on claude (sonnet-5)", async () => {
    const claudeCaptures: ClaudeCapture[] = [];
    const { store } = makeStore();

    const outcome = await runKnowledgeSwarmForRepo({
      reader: READER,
      knowledgeStore: store,
      claudePort: fakeClaudePort(claudeCaptures, () =>
        // The same port answers both seats; a worker turn parses as statements,
        // the verify turn tolerates the extra keys being absent.
        ({ ...workerBody(), ...verifyBody() }),
      ),
      codexExecutor: null,
      repoKey: "repo",
      repoRoot: "/repo",
      baseOid: "oid-1",
    });

    expect(outcome.status).toBe("ok");
    const models = claudeCaptures.map((capture) => capture.model);
    // Two worker turns on haiku + one verify on sonnet-5 (order of workers varies).
    expect(models.filter((model) => model === "haiku")).toHaveLength(2);
    expect(models.filter((model) => model === "sonnet-5")).toHaveLength(1);
    const schemas = claudeCaptures.map((capture) => capture.outputSchema);
    expect(schemas.filter((schema) => schema === PARTITION_WORKER_OUTPUT_SCHEMA)).toHaveLength(2);
    expect(schemas.filter((schema) => schema === MAP_VERIFY_OUTPUT_SCHEMA)).toHaveLength(1);
  });

  it("a partially-failed swarm keeps the prior store (all-or-keep-prior)", async () => {
    const { saved, store } = makeStore();
    const codexCaptures: CodexExecRequest[] = [];
    // The `b` worker's turns always throw; the `a` worker succeeds.
    const flaky = async (req: CodexExecRequest): Promise<CodexExecResult> => {
      codexCaptures.push(req);
      if (req.prompt.includes("b/two.ts")) throw new Error("codex fell over");
      return { output: workerBody(req) };
    };
    const outcome = await runKnowledgeSwarmForRepo({
      reader: READER,
      knowledgeStore: store,
      claudePort: fakeClaudePort([], verifyBody),
      codexExecutor: flaky,
      repoKey: "repo",
      repoRoot: "/repo",
      baseOid: "oid-1",
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("1 of 2 partition workers failed after a retry");
      // WHICH one, by name — a bare count tells an operator nothing about whether
      // a retry will get further.
      expect(outcome.failedSlices).toEqual(["b"]);
    }
    // A set silently missing the failed slice's knowledge must never be saved.
    expect(saved).toHaveLength(0);
  });

  it("runs every batch even after one fails, retries the failure ONCE, and journals the rest", async () => {
    // This REPLACES the old abandon-the-queue behaviour (#581). Abandoning made
    // sense only while a failed run threw the survivors' work away; the journal
    // keeps it, so finishing the run is what makes the next one cheap. `a` fails
    // both times, `b` must still get its turn, and `b`'s result must be on disk.
    const { saved, store } = makeStore();
    const prompts: string[] = [];
    const progress: { sliceId: string; status: string }[] = [];
    const flaky = async (req: CodexExecRequest): Promise<CodexExecResult> => {
      prompts.push(req.prompt);
      if (req.prompt.includes("a/one.ts")) throw new Error("codex fell over");
      return { output: workerBody(req) };
    };
    const outcome = await runKnowledgeSwarmForRepo({
      reader: READER,
      knowledgeStore: store,
      claudePort: fakeClaudePort([], verifyBody),
      codexExecutor: flaky,
      repoKey: "repo",
      repoRoot: "/repo",
      baseOid: "oid-1",
      // One lane, so `b` is genuinely still queued when `a` fails.
      concurrency: 1,
      onProgress: (event) => {
        if (event.kind === "partition" && event.status !== "queued") {
          progress.push({ sliceId: event.sliceId, status: event.status });
        }
      },
    });

    // `b` really ran; `a` ran twice (its own in-turn retry, then the run's).
    expect(prompts.filter((prompt) => prompt.includes("b/two.ts"))).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt.includes("a/one.ts"))).toHaveLength(4);
    // ORDER, not membership: `a` fails, `b` still runs, THEN `a` is retried. A set
    // of `toContain`s would be satisfied by a run that retried before finishing.
    expect(progress).toEqual([
      { sliceId: "a", status: "running" },
      { sliceId: "a", status: "failed" },
      { sliceId: "b", status: "running" },
      { sliceId: "b", status: "done" },
      { sliceId: "a", status: "running" },
      { sliceId: "a", status: "failed" },
    ]);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failedSlices).toEqual(["a"]);
      // `b`'s completed work survives the failed run, ready to be reused.
      expect(outcome.journaled).toBe(1);
    }
    expect(saved).toHaveLength(0);
  });

  it("a resolved-but-unavailable harness is an honest failure, not a silent fallback", async () => {
    const { saved, store } = makeStore();
    // codex-only availability resolves partition-worker to codex; with the
    // executor then missing the run must refuse — never run the turn elsewhere.
    const outcome = await runKnowledgeSwarmForRepo({
      reader: READER,
      knowledgeStore: store,
      claudePort: null,
      codexExecutor: null,
      repoKey: "repo",
      repoRoot: "/repo",
      baseOid: "oid-1",
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.reason).toContain("unavailable");
    expect(saved).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prior-set identity (review P1): the runner derives its own mode from the
// STORED set — skip when current, delta from `prior.baseOid` when older, full
// replacement when the prior came from a foreign generator (the retired flat
// pass must never survive as carry substrate).
// ─────────────────────────────────────────────────────────────────────────────

/** A stored prior statement citing `b/two.ts` (unchanged across the delta). */
const PRIOR_B_STATEMENT: KnowledgeStatement = {
  id: "prior-b",
  subject: "b",
  aspect: "purpose",
  claim: "module b does b-things",
  evidence: [{ path: "b/two.ts", blobOid: "blob-b1" }],
  confidence: "high",
  status: "confirmed",
  provenance: { generator: KNOWLEDGE_SWARM_GENERATOR_ID, model: "haiku", apiKeySource: null },
  learnedAgainst: { baseOid: "oid-0", snapshotFingerprint: "fp-0" },
};

function priorSet(overrides: Partial<KnowledgeSet> = {}): KnowledgeSet {
  return {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    repoKey: "repo",
    baseOid: "oid-0",
    snapshotFingerprint: "fp-0",
    generator: KNOWLEDGE_SWARM_GENERATOR_ID,
    statements: [PRIOR_B_STATEMENT],
    ...overrides,
  };
}

function storeWithPrior(prior: KnowledgeSet): {
  saved: KnowledgeSet[];
  store: {
    loadLocal: () => KnowledgeSet | null;
    save: (k: string, s: KnowledgeSet) => void;
    journalDir: () => string;
  };
} {
  const { saved, store } = makeStore();
  return { saved, store: { ...store, loadLocal: () => prior } };
}

describe("knowledge swarm — prior-set identity", () => {
  it("an eligible prior set at the current baseline is an honest skip (no turns run)", async () => {
    const codexCaptures: CodexExecRequest[] = [];
    const { saved, store } = storeWithPrior(priorSet({ baseOid: "oid-1" }));
    const outcome = await runKnowledgeSwarmForRepo({
      reader: READER,
      knowledgeStore: store,
      claudePort: fakeClaudePort([], verifyBody),
      codexExecutor: fakeCodexExecutor(codexCaptures, workerBody),
      repoKey: "repo",
      repoRoot: "/repo",
      baseOid: "oid-1",
    });
    expect(outcome.status).toBe("skipped");
    expect(codexCaptures).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it("a foreign-generator prior set (the retired flat pass) forces a FULL rerun, never carry", async () => {
    const codexCaptures: CodexExecRequest[] = [];
    // Same OID as the target: identity, not staleness, must drive the decision.
    const { saved, store } = storeWithPrior(
      priorSet({ baseOid: "oid-1", generator: "knowledge-gen@1" }),
    );
    const outcome = await runKnowledgeSwarmForRepo({
      reader: READER,
      knowledgeStore: store,
      claudePort: fakeClaudePort([], verifyBody),
      codexExecutor: fakeCodexExecutor(codexCaptures, workerBody),
      repoKey: "repo",
      repoRoot: "/repo",
      baseOid: "oid-1",
    });
    expect(outcome.status).toBe("ok");
    // BOTH partitions ran (full swarm), and the flat-pass statement is gone.
    expect(codexCaptures).toHaveLength(2);
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(saved[0])).not.toContain("module b does b-things");
  });

  it("incremental: delta base is prior.baseOid, only the owning partition re-runs, untouched statements carry byte-identical", async () => {
    const codexCaptures: CodexExecRequest[] = [];
    const gitCalls: string[][] = [];
    const git: GitExec = async (_root, args) => {
      gitCalls.push(args);
      if (args[0] === "diff") return "a/one.ts\0";
      if (args[0] === "ls-tree") return "a/one.ts\0b/two.ts\0";
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const { saved, store } = storeWithPrior(priorSet());
    const outcome = await runKnowledgeSwarmForRepo({
      reader: READER,
      knowledgeStore: store,
      claudePort: fakeClaudePort([], verifyBody),
      codexExecutor: fakeCodexExecutor(codexCaptures, workerBody),
      repoKey: "repo",
      repoRoot: "/repo",
      baseOid: "oid-1",
      git,
    });
    expect(outcome.status).toBe("ok");
    // The delta base came from the STORED set, not any caller input.
    expect(gitCalls[0]).toContain("oid-0..oid-1");
    // Only the `a` partition owns the changed path ⇒ exactly one worker turn.
    expect(codexCaptures).toHaveLength(1);
    expect(codexCaptures[0]?.prompt).toContain("a/one.ts");
    // The untouched prior statement carried BYTE-IDENTICAL.
    const carriedStatement = saved[0]?.statements.find((s) => s.id === "prior-b");
    expect(carriedStatement).toEqual(PRIOR_B_STATEMENT);
    if (outcome.status === "ok") expect(outcome.carried).toBe(1);
  });

  it("an unreadable PRIOR snapshot routes every change; a readable one classifies it", async () => {
    // The W4 fail-safe at the live seam, with its own control beside it. Both runs see
    // the same git diff and the same current snapshot. The only difference is whether
    // the prior snapshot can be read — and it is deliberately a snapshot that says
    // "cosmetic" (identical blobOids), so a run that could read it spends no turn and
    // a run that could not must spend one rather than assume.
    const git: GitExec = async (_root, args) => {
      if (args[0] === "diff") return "a/one.ts\0";
      if (args[0] === "ls-tree") return "a/one.ts\0b/two.ts\0";
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const run = async (
      loadFresh: (repoKey: string, oid: string) => LoadFreshResult,
    ): Promise<{
      turns: number;
      outcome: Awaited<ReturnType<typeof runKnowledgeSwarmForRepo>>;
    }> => {
      const captures: CodexExecRequest[] = [];
      const { store } = storeWithPrior(priorSet());
      const outcome = await runKnowledgeSwarmForRepo({
        reader: { loadFresh },
        knowledgeStore: store,
        claudePort: fakeClaudePort([], verifyBody),
        codexExecutor: fakeCodexExecutor(captures, workerBody),
        repoKey: "repo",
        repoRoot: "/repo",
        baseOid: "oid-1",
        git,
      });
      return { turns: captures.length, outcome };
    };

    const refused = await run((_repoKey, oid) =>
      oid === "oid-0"
        ? { ok: false as const, failure: { reason: "absent" as const } }
        : { ok: true as const, snapshot: SNAPSHOT },
    );
    expect(refused.turns).toBe(1);
    if (refused.outcome.status === "ok") expect(refused.outcome.skippedCosmetic).toBe(0);

    // The control: served an identical prior, the same change is cosmetic and costs
    // nothing — so the turn above is the fail-safe firing, not the diff being inert.
    // The prior carries the FINGERPRINT the stored set was learned against; serving a
    // snapshot with identical blobs but another fingerprint is a different refusal,
    // and it has its own test below.
    const served = await run((_repoKey, oid) => ({
      ok: true as const,
      snapshot:
        oid === "oid-0"
          ? (COMPARABLE_PRIOR_SNAPSHOT as unknown as LoadedSnapshot)
          : (SNAPSHOT as unknown as LoadedSnapshot),
    }));
    expect(served.turns).toBe(0);
    expect(served.outcome.status).toBe("ok");
    if (served.outcome.status === "ok") {
      expect(served.outcome.ranPartitions).toBe(0);
      expect(served.outcome.skippedCosmetic).toBe(1);
    }
  });

  it("a prior snapshot whose FINGERPRINT is not the learned-against one routes every change", async () => {
    // The OID is not the snapshot's identity. A manifest is stored per baseline and
    // overwritten in place, so a re-extraction at the prior OID — a new symbol or
    // import extractor, a different inventory — replaces the view the stored
    // statements were learned against while leaving the OID exactly where it was. A
    // classification against THAT snapshot answers "did the signature move?" by
    // comparing two different extractions.
    //
    // Both arms below are handed a prior with the SAME blobOids as the current
    // snapshot, so both would classify the change cosmetic and spend nothing. The only
    // difference is the fingerprint, and the run that cannot join on it must pay the
    // turn rather than assume.
    const git: GitExec = async (_root, args) => {
      if (args[0] === "diff") return "a/one.ts\0";
      if (args[0] === "ls-tree") return "a/one.ts\0b/two.ts\0";
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const runWithPriorFingerprint = async (fingerprint: string): Promise<number> => {
      const captures: CodexExecRequest[] = [];
      const { store } = storeWithPrior(priorSet());
      const reExtracted = {
        ...COMPARABLE_PRIOR_SNAPSHOT,
        manifest: { repoKey: "repo", baseOid: "oid-0", fingerprint },
      } as unknown as LoadedSnapshot;
      const outcome = await runKnowledgeSwarmForRepo({
        reader: {
          loadFresh: (_repoKey: string, oid: string) => ({
            ok: true as const,
            snapshot: oid === "oid-0" ? reExtracted : SNAPSHOT,
          }),
        },
        knowledgeStore: store,
        claudePort: fakeClaudePort([], verifyBody),
        codexExecutor: fakeCodexExecutor(captures, workerBody),
        repoKey: "repo",
        repoRoot: "/repo",
        baseOid: "oid-1",
        git,
      });
      expect(outcome.status).toBe("ok");
      return captures.length;
    };

    // `fp-0` is what `priorSet()` records; `fp-re-extracted` is the same commit seen
    // by a later extraction, which the set never learned against.
    expect(await runWithPriorFingerprint("fp-re-extracted")).toBe(1);
    expect(await runWithPriorFingerprint("fp-0")).toBe(0);
  });

  it("a git failure is a FAILED pass the scheduler retries, never a silent skip", async () => {
    const git: GitExec = async () => {
      throw new Error("fatal: bad object");
    };
    const { saved, store } = storeWithPrior(priorSet());
    const outcome = await runKnowledgeSwarmForRepo({
      reader: READER,
      knowledgeStore: store,
      claudePort: fakeClaudePort([], verifyBody),
      codexExecutor: fakeCodexExecutor([], workerBody),
      repoKey: "repo",
      repoRoot: "/repo",
      baseOid: "oid-1",
      git,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed")
      expect(outcome.reason).toContain("changed-path resolution failed");
    expect(saved).toHaveLength(0);
  });

  it("refuses to save when another run wrote the store while this one was working", async () => {
    // Two runs, no coordination between them: the proactive watcher's advance and
    // the review-open kick. This one reads the store at the top, spends every worker
    // turn and the verify seat, and by the time it reaches the save another run has
    // promoted a NEWER set. Writing here would roll the store back to an older
    // target, silently, with the newer run's work gone.
    const { saved, store } = makeStore();
    let stored: KnowledgeSet | null = null;
    const racing = {
      ...store,
      loadLocal: () => stored,
      save: (repoKey: string, set: KnowledgeSet) => {
        store.save(repoKey, set);
      },
    };
    // The target this run journals under, and a SEEDED entry for a slice this run
    // does not execute — an earlier attempt's leftover. It makes the journal's entry
    // count (3) differ from what this run completed (2), which is the only way the
    // `journaled` assertion below can tell the two apart.
    const target: JournalTarget = {
      baseOid: "oid-1",
      snapshotFingerprint: "fp-1",
      generator: KNOWLEDGE_SWARM_GENERATOR_ID,
    };
    const journal = new KnowledgeJournal(store.journalDir());
    const stranger: PartitionSlice = { id: "dir:c", files: [], neighbors: [] };
    journal.write(target, stranger, {
      sliceId: stranger.id,
      status: "ok",
      statements: [],
      droppedAnchors: 0,
      droppedStatements: 0,
      attempts: 1,
    });
    expect(journal.size(target)).toBe(1);
    const outcome = await runKnowledgeSwarmForRepo({
      reader: READER,
      knowledgeStore: racing,
      claudePort: fakeClaudePort([], verifyBody),
      codexExecutor: fakeCodexExecutor([], () => {
        // The other run lands mid-flight, between this run's read and its save.
        stored = priorSet({ baseOid: "oid-9" });
        return workerBody();
      }),
      repoKey: "repo",
      repoRoot: "/repo",
      baseOid: "oid-1",
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("superseded");
      // THE DISK, not a counter. "The journal is deliberately kept" is a claim about
      // what is on the filesystem after the refusal, and a `journaled` number would
      // read exactly the same whether or not `clear` had run — insert
      // `journal.clear(target)` before the superseded return and this line reds while
      // the one below it does not.
      expect(journal.size(target)).toBe(3);
      // And the counter is THIS RUN's completed batches (2), not the journal's entry
      // count (3, seeded above): swap the outcome field back to `journal.size(target)`
      // and this reds. The distinction matters on a retry, where the journal holds
      // every earlier attempt's work and this run completed a subset.
      expect(outcome.journaled).toBe(2);
    }
    expect(saved).toHaveLength(0);
  });

  it("saves when the store did not move — the superseded check is not a blanket refusal", async () => {
    // The control for the refusal above. Same fixture, same everything, except that
    // nothing else writes: a guard that refused unconditionally would pass the test
    // above and fail this one.
    const { saved, store } = makeStore();
    const outcome = await runKnowledgeSwarmForRepo({
      reader: READER,
      knowledgeStore: store,
      claudePort: fakeClaudePort([], verifyBody),
      codexExecutor: fakeCodexExecutor([], workerBody),
      repoKey: "repo",
      repoRoot: "/repo",
      baseOid: "oid-1",
    });
    expect(outcome.status).toBe("ok");
    expect(saved).toHaveLength(1);
  });
});
