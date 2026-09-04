import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMetricsCollector, instrumentCodexExecutor } from "@rennet/adapters";
import type {
  CodexExecRequest,
  CodexExecResult,
  CodexExecutor,
  HarnessEvent,
  HarnessPort,
} from "@rennet/core";
import type { Patchset, Review, SuccessorAccount } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { sessionContextDir } from "./context-files";
import { createLiveDeltaDigestPort } from "./delta-digest-live";

// A REAL repository root: the live ports write the turn's context under it before the
// turn (session-context-files 3.7), and the seat resolves the paths in its prompt against
// it. A fixture root that does not exist cannot exercise the turn at all.
const REPO_ROOT = mkdtempSync(join(tmpdir(), "rennet-digest-repo-"));

/** Read one of the files the port wrote for this review. */
function contextFile(name: string): string {
  return readFileSync(join(sessionContextDir(REPO_ROOT, "review-1"), name), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE review.deltaDigest producer (issue #73 / M25). Driven with NO real codex
// and NO real claude: fakes stand in, so the council routing across BOTH seats + the
// model-free-floor degradations (throwing seat → failed, no seat → unavailable) are
// proven hermetically at the LIVE layer. `delta-digest.test.ts` in core proves the
// emitted→drafted / empty-text→failed law. Mirrors `draft-pr-body-live.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

function review(): Review {
  const patchset: Patchset = {
    id: "ps-1",
    createdAt: "2026-08-12T00:00:00.000Z",
    repository: {
      id: "repo",
      root: REPO_ROOT,
      commonDir: join(REPO_ROOT, ".git"),
      baseRef: "main",
      baseOid: "abc",
      headOid: "def",
    },
    files: [],
    rawDiff: "",
    byteLength: 0,
    truncated: false,
  };
  return {
    id: "review-1",
    repositoryRoot: REPO_ROOT,
    patchsets: [patchset],
    activePatchsetId: patchset.id,
    dispositions: [],
    status: "current",
  };
}

const ACCOUNT: SuccessorAccount = {
  asks: [
    {
      path: "src/rate/keys.ts",
      type: "request-change",
      summary: "rename the key",
      status: "addressed",
    },
    {
      path: "src/rate/middleware.ts",
      type: "comment",
      summary: "drop dead branch",
      status: "untouched",
    },
  ],
  beyondAsks: ["src/metrics/emit.ts"],
};

const input = () => ({ review: review(), account: ACCOUNT });

function fakeExecutor(
  output: unknown,
  onCall?: (req: CodexExecRequest) => void,
  observedModel?: string,
): CodexExecutor {
  return async (req: CodexExecRequest): Promise<CodexExecResult> => {
    onCall?.(req);
    return { output, ...(observedModel === undefined ? {} : { model: observedModel }) };
  };
}

function startedEvent(model: string): HarnessEvent {
  return {
    seq: 1,
    harness: "claude-code",
    sessionId: "s",
    turnId: "t",
    receivedAt: 0,
    native: null,
    kind: "session.started",
    model,
    cwd: REPO_ROOT,
    tools: [],
    apiKeySource: null,
  } as unknown as HarnessEvent;
}

function completedEvent(structuredOutput: unknown): HarnessEvent {
  return {
    seq: 1,
    harness: "claude-code",
    sessionId: "s",
    turnId: "t",
    receivedAt: 0,
    native: null,
    kind: "session.ended",
    outcome: { status: "completed", finalText: "", structuredOutput },
  } as unknown as HarnessEvent;
}

function fakeClaudePort(makeEvents: () => HarnessEvent[]): HarnessPort {
  return {
    descriptor: {} as never,
    health: async () => ({}) as never,
    createSession: async () =>
      ({
        id: "s" as never,
        harness: "claude-code" as never,
        events: (async function* () {
          for (const event of makeEvents()) yield event;
        })(),
        send: async () => "t" as never,
        interrupt: async () => {
          /* no-op in the fake */
        },
        close: async () => {
          /* no-op in the fake */
        },
      }) as never,
  } as HarnessPort;
}

describe("createLiveDeltaDigestPort — Codex seat", () => {
  it("digests on Codex, reports the OBSERVED runtime model, and grounds the prompt in ONLY the account", async () => {
    let seenPrompt = "";
    let seenCwd: string | undefined;
    const producer = createLiveDeltaDigestPort({
      claudePort: async () => null,
      codexExecutor: async () =>
        fakeExecutor(
          {
            digest:
              "Renamed the key, left the dead branch, and touched metrics nobody asked about.",
          },
          (req) => {
            seenPrompt = req.prompt;
            seenCwd = req.cwd;
          },
          "gpt-observed",
        ),
    });
    const result = await producer(input());
    expect(result).toEqual({
      status: "drafted",
      text: "Renamed the key, left the dead branch, and touched metrics nobody asked about.",
      model: "gpt-observed",
    });
    // The prompt NAMES the account and carries no fact of its own (3.7); the account
    // is on disk under the root the turn runs in, so the grounding guarantee is the same
    // one — that file is still the only thing the turn may state.
    expect(seenPrompt).toContain(".rennet/context/review-1/digest-input.json");
    expect(seenPrompt).not.toContain("src/rate/keys.ts");
    expect(seenPrompt).not.toContain("src/metrics/emit.ts");
    expect(seenCwd).toBe(REPO_ROOT);
    const written = JSON.parse(contextFile("digest-input.json")) as { beyondAsks: string[] };
    expect(contextFile("digest-input.json")).toContain("src/rate/keys.ts");
    expect(written.beyondAsks).toContain("src/metrics/emit.ts");
    expect(contextFile("README.md")).toContain("digest-input.json");
  });

  it("MODEL-FREE FLOOR: a THROWING Codex seat degrades to failed — never a fabricated digest", async () => {
    const producer = createLiveDeltaDigestPort({
      claudePort: async () => null,
      codexExecutor: async () => async () => {
        throw new Error("codex exited 1");
      },
    });
    const result = await producer(input());
    expect(result.status).toBe("failed");
  });

  it("maps an empty digest from the model to failed (the honesty floor holds live)", async () => {
    const producer = createLiveDeltaDigestPort({
      claudePort: async () => null,
      codexExecutor: async () => fakeExecutor({ digest: "" }),
    });
    expect((await producer(input())).status).toBe("failed");
  });
});

describe("createLiveDeltaDigestPort — Claude seat", () => {
  it("digests on the Claude adapter and reports the ACTUAL runtime model", async () => {
    const producer = createLiveDeltaDigestPort({
      claudePort: async () =>
        fakeClaudePort(() => [
          startedEvent("haiku-actual"),
          completedEvent({ digest: "A tight summary." }),
        ]),
      codexExecutor: async () => null,
    });
    const result = await producer(input());
    expect(result).toEqual({ status: "drafted", text: "A tight summary.", model: "haiku-actual" });
  });

  it("MODEL-FREE FLOOR: a Claude turn with no structured output is failed", async () => {
    const producer = createLiveDeltaDigestPort({
      claudePort: async () => fakeClaudePort(() => [completedEvent(undefined)]),
      codexExecutor: async () => null,
    });
    expect((await producer(input())).status).toBe("failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The measurement tap on the Codex leg. This port drives `codex exec` directly, so none of
// the session instrumentation sees it: without the wrapped executor the turn spends the
// user's subscription and records nothing at all — not the tokens, not the inlined bytes.
// ─────────────────────────────────────────────────────────────────────────────

describe("createLiveDeltaDigestPort — the Codex send reaches the metrics sink", () => {
  it("records one TurnMetric carrying the turn's tokens and the prompt's measurement", async () => {
    const collector = createMetricsCollector();
    const digest = fakeExecutor({ digest: "A tight summary." });
    const producer = createLiveDeltaDigestPort({
      claudePort: async () => null,
      codexExecutor: async () =>
        instrumentCodexExecutor(
          async (req) => ({
            ...(await digest(req)),
            tokens: {
              input: 4_000,
              output: 120,
              cacheRead: 0,
              cacheWrite: 0,
              reasoning: null,
              total: 4_120,
            },
          }),
          collector,
          "codex-utility",
        ),
    });

    expect((await producer(input())).status).toBe("drafted");

    expect(collector.metrics).toHaveLength(1);
    // The port names the job, so one shared executor's metric still says which seat spent it.
    expect(collector.metrics[0]?.label).toBe("delta-digest");
    expect(collector.metrics[0]?.usage).toMatchObject({ totalTokens: 4_120 });
    expect(collector.metrics[0]?.status).toBe("emitted");
    // The prompt points at the account FILE rather than carrying it, which is the whole
    // point of the conversion — so the honest reading here is absence, not a number. The
    // wrapper's own tests carry the over-the-limit case.
    expect(collector.metrics[0]?.inlineContextBytes).toBeUndefined();
  });
});

describe("createLiveDeltaDigestPort — no seat installed", () => {
  it("MODEL-FREE FLOOR: is UNAVAILABLE when NEITHER seat is installed (never a fabricated digest)", async () => {
    const producer = createLiveDeltaDigestPort({
      claudePort: async () => null,
      codexExecutor: async () => null,
    });
    expect((await producer(input())).status).toBe("unavailable");
  });
});
