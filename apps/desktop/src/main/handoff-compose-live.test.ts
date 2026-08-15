import {
  buildHandoffBundle,
  type CodexExecutor,
  type HarnessDescriptor,
  type HarnessEvent,
  type HarnessHealth,
  type HarnessPort,
  type SessionSpec,
} from "@rennet/core";
import type { HandoffDisposition, Patchset } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import {
  claudeComposePort,
  createLiveComposeBundle,
  mapComposeOutput,
} from "./handoff-compose-live";

const patchset: Patchset = {
  id: "ps-1",
  createdAt: "2026-08-11T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/repo",
    commonDir: "/repo/.git",
    baseRef: "origin/main",
    baseOid: "base",
    headOid: "head",
  },
  files: [
    {
      path: "src/auth.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
      patch: "diff --git a/src/auth.ts b/src/auth.ts\n@@ -1 +1 @@\n+a",
    },
    {
      path: "src/user.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
      patch: "diff --git a/src/user.ts b/src/user.ts\n@@ -1 +1 @@\n+u",
    },
  ],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

const DISPOSITIONS: HandoffDisposition[] = [
  { path: "src/auth.ts", type: "request-change", body: "validate the token" },
  { path: "src/auth.ts", type: "comment", body: "handle expiry too" },
  { path: "src/user.ts", type: "request-change", body: "return 404 not 500" },
];

function bundle() {
  return buildHandoffBundle({ reviewId: "r1", patchset, dispositions: DISPOSITIONS });
}

const VALID_PROPOSAL = {
  groups: [
    { title: "Harden token handling", dispositionIds: ["d0", "d1"] },
    { title: "Fix the status code", dispositionIds: ["d2"] },
  ],
};

// ── A fake HarnessPort whose single session yields one scripted terminal frame ──
class FakeSession {
  readonly id = "s1";
  readonly harness = "claude-code";
  constructor(private readonly script: HarnessEvent[]) {}
  get events(): AsyncIterable<HarnessEvent> {
    const script = this.script;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
        for (const event of script) yield event;
      },
    };
  }
  send(): Promise<string> {
    return Promise.resolve("t1");
  }
  interrupt(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function ended(structuredOutput: unknown): HarnessEvent {
  return {
    kind: "session.ended",
    outcome: { status: "completed", finalText: "", structuredOutput },
  } as unknown as HarnessEvent;
}

function fakeClaude(structuredOutput: unknown): {
  port: HarnessPort;
  lastSpec: () => SessionSpec | null;
} {
  let last: SessionSpec | null = null;
  const port: HarnessPort = {
    descriptor: {} as HarnessDescriptor,
    health: () => Promise.resolve({ state: "ready", version: "2.1.0" } as HarnessHealth),
    createSession: (spec: SessionSpec) => {
      last = spec;
      return Promise.resolve(
        new FakeSession([ended(structuredOutput)]) as unknown as Awaited<
          ReturnType<HarnessPort["createSession"]>
        >,
      );
    },
  };
  return { port, lastSpec: () => last };
}

function fakeCodex(output: unknown): CodexExecutor {
  return () => Promise.resolve({ output });
}

describe("mapComposeOutput", () => {
  it("maps a well-formed groups array to an emitted proposal", () => {
    const result = mapComposeOutput(VALID_PROPOSAL);
    expect(result.status).toBe("emitted");
    if (result.status === "emitted") expect(result.proposal.groups).toHaveLength(2);
  });

  it("fails on a missing/!array groups", () => {
    expect(mapComposeOutput({}).status).toBe("failed");
    expect(mapComposeOutput({ groups: "nope" }).status).toBe("failed");
    expect(mapComposeOutput(null).status).toBe("failed");
  });

  it("fails on a malformed group (never a fabricated proposal)", () => {
    expect(mapComposeOutput({ groups: [{ title: "t" }] }).status).toBe("failed");
    expect(mapComposeOutput({ groups: [{ title: 1, dispositionIds: [] }] }).status).toBe("failed");
    expect(mapComposeOutput({ groups: [{ title: "t", dispositionIds: [1, 2] }] }).status).toBe(
      "failed",
    );
  });
});

describe("claudeComposePort", () => {
  it("binds the compose session to the repo with the structured-output schema", async () => {
    const { port, lastSpec } = fakeClaude(VALID_PROPOSAL);
    await claudeComposePort(port, "/repo")("prompt");
    expect(lastSpec()?.cwd).toBe("/repo");
    expect(lastSpec()?.outputSchema).toBeDefined();
  });
});

describe("createLiveComposeBundle", () => {
  it("adopts a valid authoring from the Codex seat (composed:true) and records the resolution", async () => {
    const compose = createLiveComposeBundle({
      claudePort: () => Promise.resolve(null),
      codexExecutor: () => Promise.resolve(fakeCodex(VALID_PROPOSAL)),
    });
    const { bundle: composed, resolution } = await compose({ bundle: bundle(), repoRoot: "/repo" });
    expect(composed.composed).toBe(true);
    expect(composed.tasks).toHaveLength(2);
    expect(composed.tasks[0]?.sourceDispositions).toEqual(["d0", "d1"]);
    // The recorded resolution names the seat that ran (task 2.2).
    expect(resolution.status).toBe("resolved");
    if (resolution.status === "resolved") {
      expect(resolution.harness).toBe("codex");
      expect(resolution.model).not.toBe("");
      expect(resolution.summary).not.toBe("");
    }
  });

  it("adopts a valid authoring from the Claude seat when Codex is absent", async () => {
    const { port } = fakeClaude(VALID_PROPOSAL);
    const compose = createLiveComposeBundle({
      claudePort: () => Promise.resolve(port),
      codexExecutor: () => Promise.resolve(null),
    });
    const { bundle: composed, resolution } = await compose({ bundle: bundle(), repoRoot: "/repo" });
    expect(composed.composed).toBe(true);
    expect(composed.tasks).toHaveLength(2);
    expect(resolution.status).toBe("resolved");
    if (resolution.status === "resolved") expect(resolution.harness).toBe("claude-code");
  });

  it("returns the mechanical floor + an unavailable resolution when NO seat is installed", async () => {
    const compose = createLiveComposeBundle({
      claudePort: () => Promise.resolve(null),
      codexExecutor: () => Promise.resolve(null),
    });
    const { bundle: composed, resolution } = await compose({ bundle: bundle(), repoRoot: "/repo" });
    expect(composed.composed).toBe(false);
    expect(composed.tasks).toHaveLength(3); // one per ask, nothing lost
    expect(Object.keys(composed.traceMap).sort()).toEqual(["d0", "d1", "d2"]);
    expect(resolution.status).toBe("unavailable");
  });

  it("falls to the floor when the seat returns a malformed authoring", async () => {
    const compose = createLiveComposeBundle({
      claudePort: () => Promise.resolve(null),
      codexExecutor: () => Promise.resolve(fakeCodex({ groups: "garbage" })),
    });
    const { bundle: composed } = await compose({ bundle: bundle(), repoRoot: "/repo" });
    expect(composed.composed).toBe(false);
    expect(composed.tasks).toHaveLength(3);
  });
});

describe("createLiveComposeBundle — budget gating (task 2.1, #260 semantics)", () => {
  // A minimal budget stub: one grant, then refuse (an exhausted ceiling).
  function budgetWith(remaining: number) {
    let left = remaining;
    const calls: string[] = [];
    return {
      calls,
      budget: {
        max: remaining,
        consumed: 0,
        remaining: left,
        refused: false,
        tryConsume(purpose: string) {
          calls.push(purpose);
          if (left <= 0) {
            return {
              granted: false as const,
              code: "R10_BUDGET_EXHAUSTED" as const,
              purpose,
              consumed: remaining,
              max: remaining,
              reason: "invocation budget exhausted",
            };
          }
          left -= 1;
          return { granted: true as const, purpose, consumed: remaining - left, remaining: left };
        },
      },
    };
  }

  it("an exhausted budget degrades to the floor with NO model call", async () => {
    const stub = budgetWith(0);
    const codex = vi.fn(fakeCodex(VALID_PROPOSAL));
    const compose = createLiveComposeBundle({
      claudePort: () => Promise.resolve(null),
      codexExecutor: () => Promise.resolve(codex),
      budget: () => stub.budget,
    });
    const { bundle: composed, resolution } = await compose({ bundle: bundle(), repoRoot: "/repo" });
    expect(composed.composed).toBe(false); // the floor, honestly marked
    expect(composed.tasks).toHaveLength(3);
    expect(codex).not.toHaveBeenCalled(); // no model turn spent
    expect(stub.calls).toEqual(["handoff-bundle-composition"]);
    expect(resolution.status).toBe("unavailable");
  });

  it("a budget with room charges ONE invocation and runs the turn", async () => {
    const stub = budgetWith(5);
    const codex = vi.fn(fakeCodex(VALID_PROPOSAL));
    const compose = createLiveComposeBundle({
      claudePort: () => Promise.resolve(null),
      codexExecutor: () => Promise.resolve(codex),
      budget: () => stub.budget,
    });
    const { bundle: composed } = await compose({ bundle: bundle(), repoRoot: "/repo" });
    expect(composed.composed).toBe(true);
    expect(codex).toHaveBeenCalledTimes(1);
    expect(stub.calls).toEqual(["handoff-bundle-composition"]);
  });

  it("an ABSENT budget runs ungated (#260)", async () => {
    const codex = vi.fn(fakeCodex(VALID_PROPOSAL));
    const compose = createLiveComposeBundle({
      claudePort: () => Promise.resolve(null),
      codexExecutor: () => Promise.resolve(codex),
      // no budget dep
    });
    const { bundle: composed } = await compose({ bundle: bundle(), repoRoot: "/repo" });
    expect(composed.composed).toBe(true);
    expect(codex).toHaveBeenCalledTimes(1);
  });
});

describe("F3: rejections fall to the floor, never a rejected command", () => {
  it("createLiveComposeBundle returns the mechanical floor when a seat probe throws", async () => {
    const compose = createLiveComposeBundle({
      claudePort: () => Promise.reject(new Error("claude discovery blew up")),
      codexExecutor: () => Promise.resolve(null),
    });
    const { bundle: composed, resolution } = await compose({ bundle: bundle(), repoRoot: "/repo" });
    expect(composed.composed).toBe(false); // one per ask, nothing lost
    expect(composed.tasks).toHaveLength(3);
    expect(Object.keys(composed.traceMap).sort()).toEqual(["d0", "d1", "d2"]);
    expect(resolution.status).toBe("unavailable");
  });

  it("claudeComposePort keeps the turn result when session.close() rejects", async () => {
    const port: HarnessPort = {
      descriptor: {} as HarnessDescriptor,
      health: () => Promise.resolve({ state: "ready", version: "2.1.0" } as HarnessHealth),
      createSession: () => {
        const session = new FakeSession([ended(VALID_PROPOSAL)]);
        // Teardown rejects AFTER a valid result was already produced.
        Object.assign(session, { close: () => Promise.reject(new Error("close failed")) });
        return Promise.resolve(
          session as unknown as Awaited<ReturnType<HarnessPort["createSession"]>>,
        );
      },
    };
    // Must RESOLVE to the emitted result, not reject on the teardown error.
    const result = await claudeComposePort(port, "/repo")("prompt");
    expect(result.status).toBe("emitted");
  });
});
