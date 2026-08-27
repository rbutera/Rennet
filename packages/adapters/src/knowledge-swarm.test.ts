import type {
  CodexExecRequest,
  CodexExecResult,
  HarnessPort,
  HarnessSession,
  LoadedSnapshot,
} from "@rennet/core";
import { MAP_VERIFY_OUTPUT_SCHEMA, PARTITION_WORKER_OUTPUT_SCHEMA } from "@rennet/core";
import type { KnowledgeSet } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
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
} as unknown as LoadedSnapshot;

const READER = {
  loadFresh: () => ({ ok: true as const, snapshot: SNAPSHOT }),
};

function makeStore(): {
  saved: KnowledgeSet[];
  store: {
    loadLocal: () => KnowledgeSet | null;
    save: (repoKey: string, set: KnowledgeSet) => void;
  };
} {
  const saved: KnowledgeSet[] = [];
  return {
    saved,
    store: {
      loadLocal: () => null,
      save: (_repoKey, set) => {
        saved.push(set);
      },
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
        send: async () => {},
        close: async () => {},
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
function fakeCodexExecutor(captures: CodexExecRequest[], body: () => unknown) {
  return async (req: CodexExecRequest): Promise<CodexExecResult> => {
    captures.push(req);
    return { output: body() };
  };
}

const workerBody = (): unknown => ({
  statements: [
    {
      subject: "a",
      aspect: "purpose",
      claim: "module a does a-things",
      confidence: "high",
      evidence: [{ path: "a/one.ts" }],
      hint: "pairs with b",
    },
  ],
});

const verifyBody = (): unknown => ({ verdicts: [], crossCutting: [] });

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
    // the council's both-scenario pick and the WORKER output schema.
    expect(codexCaptures).toHaveLength(2);
    for (const req of codexCaptures) {
      expect(req.model).toBe("gpt-5.6-luna");
      expect(req.effort).toBe("low");
      expect(req.outputSchema).toBe(PARTITION_WORKER_OUTPUT_SCHEMA);
    }
    // One verify turn on the Claude port with sonnet-5 and the VERIFY schema.
    expect(claudeCaptures).toHaveLength(1);
    expect(claudeCaptures[0]?.model).toBe("sonnet-5");
    expect(claudeCaptures[0]?.outputSchema).toBe(MAP_VERIFY_OUTPUT_SCHEMA);
    // The set persisted, statements minted through the honesty contract, and the
    // worker's hint died at synthesis (never stored).
    expect(saved).toHaveLength(1);
    expect(saved[0]?.statements.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(saved[0])).not.toContain("pairs with b");
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
