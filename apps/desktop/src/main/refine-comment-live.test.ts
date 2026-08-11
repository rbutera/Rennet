import type {
  CodexExecRequest,
  CodexExecResult,
  CodexExecutor,
  HarnessEvent,
  HarnessPort,
  SessionSpec,
} from "@rennet/core";
import type { Patchset, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { createLiveRefinePort, extractFileDiff, REFINE_DIFF_CEILING } from "./refine-comment-live";

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE review.refine producer (issue #19). Driven with NO real codex and NO
// real claude: fakes stand in, so the council routing across BOTH seats + the
// honesty degradations are proven hermetically. `refine-comment.test.ts` in core
// proves the verdict→result law.
// ─────────────────────────────────────────────────────────────────────────────

const DIFF = [
  "diff --git a/src/keys.ts b/src/keys.ts",
  "index 000..111 100644",
  "--- a/src/keys.ts",
  "+++ b/src/keys.ts",
  "@@ -1,1 +1,2 @@",
  " export const a = 1;",
  "+export const b = 2;",
  "diff --git a/src/other.ts b/src/other.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

function review(id = "review-1"): Review {
  const patchset: Patchset = {
    id: "ps-1",
    createdAt: "2026-08-11T00:00:00.000Z",
    repository: {
      id: "repo",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "abc",
      baseOid: "abc",
      headOid: "def",
    },
    files: [],
    rawDiff: DIFF,
    byteLength: DIFF.length,
    truncated: false,
  };
  return {
    id,
    repositoryRoot: "/repo",
    patchsets: [patchset],
    activePatchsetId: patchset.id,
    dispositions: [],
    status: "current",
  };
}

/** A fake codex executor capturing the request and returning a canned output. */
function fakeExecutor(output: unknown, onCall?: (req: CodexExecRequest) => void): CodexExecutor {
  return async (req: CodexExecRequest): Promise<CodexExecResult> => {
    onCall?.(req);
    return { output };
  };
}

/** A `session.ended` completed frame carrying the given structured output. */
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

/** A fake Claude HarnessPort whose one session yields the given terminal events. */
function fakeClaudePort(
  makeEvents: () => HarnessEvent[],
  onSpec?: (spec: SessionSpec) => void,
): HarnessPort {
  return {
    descriptor: {} as never,
    health: async () => ({}) as never,
    createSession: async (spec: SessionSpec) => {
      onSpec?.(spec);
      const events = makeEvents();
      return {
        id: "s" as never,
        harness: "claude-code" as never,
        events: (async function* () {
          for (const event of events) yield event;
        })(),
        send: async () => "t" as never,
        interrupt: async () => {
          /* no-op in the fake */
        },
        close: async () => {
          /* no-op in the fake */
        },
      } as never;
    },
  } as HarnessPort;
}

describe("extractFileDiff", () => {
  it("returns only the requested file's diff section", () => {
    const section = extractFileDiff(DIFF, "src/keys.ts", REFINE_DIFF_CEILING);
    expect(section).toContain("a/src/keys.ts");
    expect(section).toContain("+export const b = 2;");
    // Stops before the next file's section.
    expect(section).not.toContain("src/other.ts");
  });

  it("returns an empty string when the path is not in the diff", () => {
    expect(extractFileDiff(DIFF, "src/missing.ts", REFINE_DIFF_CEILING)).toBe("");
  });

  it("bounds the section to the byte ceiling", () => {
    const section = extractFileDiff(DIFF, "src/keys.ts", 20);
    expect(section.length).toBeLessThanOrEqual(20 + "\n… (diff truncated at 20 bytes)".length);
    expect(section).toContain("truncated");
  });
});

describe("createLiveRefinePort — Codex seat (council resolves Terra)", () => {
  it("refines on Codex and returns the council-resolved model", async () => {
    let seenPrompt = "";
    const port = createLiveRefinePort({
      claudePort: async () => null,
      codexExecutor: async () =>
        fakeExecutor(
          {
            verdict: "refined",
            refinedBody: "Re-keying breaks per-key clients; please add a note.",
          },
          (req) => {
            seenPrompt = req.prompt;
          },
        ),
    });
    const result = await port({
      review: review(),
      type: "request-change",
      raw: "this breaks per-key clients?? add note",
      lens: "decisions",
      path: "src/keys.ts",
    });
    expect(result).toEqual({
      status: "refined",
      refined: "Re-keying breaks per-key clients; please add a note.",
      model: "gpt-5.6-terra",
    });
    // The anchored file diff was inlined for grounding (the "investigated" input).
    expect(seenPrompt).toContain("+export const b = 2;");
    expect(seenPrompt).toContain("this breaks per-key clients?? add note");
  });

  it("maps a no-change verdict through honestly", async () => {
    const port = createLiveRefinePort({
      claudePort: async () => null,
      codexExecutor: async () => fakeExecutor({ verdict: "no-change" }),
    });
    const result = await port({ review: review(), type: "comment", raw: "already clear" });
    expect(result).toEqual({ status: "no-change", model: "gpt-5.6-terra" });
  });

  it("returns an honest `failed` when the Codex turn throws — never the raw as refined", async () => {
    const port = createLiveRefinePort({
      claudePort: async () => null,
      codexExecutor: async () => async () => {
        throw new Error("codex exited 1");
      },
    });
    const result = await port({ review: review(), type: "comment", raw: "clean me up" });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toContain("codex exited 1");
  });
});

describe("createLiveRefinePort — Claude seat (Claude-only machine resolves Sonnet)", () => {
  it("refines on the Claude adapter via a read-only session with the inline schema", async () => {
    let seenSpec: SessionSpec | undefined;
    const port = createLiveRefinePort({
      claudePort: async () =>
        fakeClaudePort(
          () => [
            completedEvent({ verdict: "refined", refinedBody: "Please add a rollback path." }),
          ],
          (spec) => {
            seenSpec = spec;
          },
        ),
      codexExecutor: async () => null,
    });
    const result = await port({
      review: review(),
      type: "request-change",
      raw: "no down migration??",
      path: "src/keys.ts",
    });
    expect(result).toEqual({
      status: "refined",
      refined: "Please add a rollback path.",
      // Claude-only ⇒ council Table 2 assigns comment-refinement to Sonnet.
      model: "sonnet-5",
    });
    // The session is read-only and carries the structured-output schema (no docType).
    expect(seenSpec?.readOnly).toBe(true);
    expect(seenSpec?.outputSchema).toBeDefined();
  });

  it("fails honestly when the Claude turn completes without structured output", async () => {
    const port = createLiveRefinePort({
      claudePort: async () => fakeClaudePort(() => [completedEvent(undefined)]),
      codexExecutor: async () => null,
    });
    const result = await port({ review: review(), type: "comment", raw: "clean me up" });
    expect(result.status).toBe("failed");
  });
});

describe("createLiveRefinePort — no seat installed", () => {
  it("is UNAVAILABLE when NEITHER Codex nor Claude is installed", async () => {
    const port = createLiveRefinePort({
      claudePort: async () => null,
      codexExecutor: async () => null,
    });
    const result = await port({ review: review(), type: "comment", raw: "clean me up" });
    expect(result.status).toBe("unavailable");
  });
});
