import type {
  CodexExecRequest,
  CodexExecResult,
  CodexExecutor,
  HarnessEvent,
  HarnessPort,
} from "@rennet/core";
import type { DeltaAccount, Patchset, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { createLiveDeltaDigestPort } from "./delta-digest-live";

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
      root: "/repo",
      commonDir: "/repo/.git",
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
    repositoryRoot: "/repo",
    patchsets: [patchset],
    activePatchsetId: patchset.id,
    dispositions: [],
    status: "current",
  };
}

const ACCOUNT: DeltaAccount = {
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
    cwd: "/repo",
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
    // The prompt carries the account's facts and NOTHING about the code itself.
    expect(seenPrompt).toContain("src/rate/keys.ts");
    expect(seenPrompt).toContain("src/metrics/emit.ts");
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

describe("createLiveDeltaDigestPort — no seat installed", () => {
  it("MODEL-FREE FLOOR: is UNAVAILABLE when NEITHER seat is installed (never a fabricated digest)", async () => {
    const producer = createLiveDeltaDigestPort({
      claudePort: async () => null,
      codexExecutor: async () => null,
    });
    expect((await producer(input())).status).toBe("unavailable");
  });
});
