import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodexExecRequest,
  CodexExecResult,
  HarnessPort,
  HarnessSession,
  LoadedSnapshot,
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
import { runKnowledgeSwarmForRepo } from "./knowledge-swarm";

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

const READER = {
  loadFresh: () => ({ ok: true as const, snapshot: SNAPSHOT }),
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

describe("knowledge swarm — council-routed contract (no live model)", () => {
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
});
