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
import { describe, expect, it } from "vitest";
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
  it("runs a READ-ONLY session (composition reads, never writes)", async () => {
    const { port, lastSpec } = fakeClaude(VALID_PROPOSAL);
    await claudeComposePort(port, "/repo")("prompt");
    expect(lastSpec()?.readOnly).toBe(true);
  });
});

describe("createLiveComposeBundle", () => {
  it("adopts a valid authoring from the Codex seat (composed:true)", async () => {
    const compose = createLiveComposeBundle({
      claudePort: () => Promise.resolve(null),
      codexExecutor: () => Promise.resolve(fakeCodex(VALID_PROPOSAL)),
    });
    const composed = await compose({ bundle: bundle(), repoRoot: "/repo" });
    expect(composed.composed).toBe(true);
    expect(composed.tasks).toHaveLength(2);
    expect(composed.tasks[0]?.sourceDispositions).toEqual(["d0", "d1"]);
  });

  it("adopts a valid authoring from the Claude seat when Codex is absent", async () => {
    const { port } = fakeClaude(VALID_PROPOSAL);
    const compose = createLiveComposeBundle({
      claudePort: () => Promise.resolve(port),
      codexExecutor: () => Promise.resolve(null),
    });
    const composed = await compose({ bundle: bundle(), repoRoot: "/repo" });
    expect(composed.composed).toBe(true);
    expect(composed.tasks).toHaveLength(2);
  });

  it("returns the mechanical floor when NO seat is installed", async () => {
    const compose = createLiveComposeBundle({
      claudePort: () => Promise.resolve(null),
      codexExecutor: () => Promise.resolve(null),
    });
    const composed = await compose({ bundle: bundle(), repoRoot: "/repo" });
    expect(composed.composed).toBe(false);
    expect(composed.tasks).toHaveLength(3); // one per ask, nothing lost
    expect(Object.keys(composed.traceMap).sort()).toEqual(["d0", "d1", "d2"]);
  });

  it("falls to the floor when the seat returns a malformed authoring", async () => {
    const compose = createLiveComposeBundle({
      claudePort: () => Promise.resolve(null),
      codexExecutor: () => Promise.resolve(fakeCodex({ groups: "garbage" })),
    });
    const composed = await compose({ bundle: bundle(), repoRoot: "/repo" });
    expect(composed.composed).toBe(false);
    expect(composed.tasks).toHaveLength(3);
  });
});
