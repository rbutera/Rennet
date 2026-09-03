import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodexExecRequest,
  CodexExecResult,
  CodexExecutor,
  HarnessEvent,
  HarnessPort,
  SessionSpec,
} from "@rennet/core";
import type { Patchset, Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { sessionContextDir } from "./context-files";
import { createLiveDraftPrBodyPort, type LiveDraftPrBodyInput } from "./draft-pr-body-live";

// A REAL repository root: the live ports write the turn's context under it before the
// turn (session-context-files 3.7), and the seat resolves the paths in its prompt against
// it. A fixture root that does not exist cannot exercise the turn at all.
const REPO_ROOT = mkdtempSync(join(tmpdir(), "rennet-prbody-repo-"));

/** Read one of the files the port wrote for this review. */
function contextFile(name: string): string {
  return readFileSync(join(sessionContextDir(REPO_ROOT, "review-1"), name), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE review.draftPrBody producer (issue #74, M26). Driven with NO real codex
// and NO real claude: fakes stand in, so the council routing across BOTH seats +
// the honesty degradations are proven hermetically. `draft-pr-body.test.ts` in core
// proves the emitted→drafted / empty-field→failed law.
// ─────────────────────────────────────────────────────────────────────────────

function review(id = "review-1"): Review {
  const patchset: Patchset = {
    id: "ps-1",
    createdAt: "2026-08-11T00:00:00.000Z",
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
    id,
    repositoryRoot: REPO_ROOT,
    patchsets: [patchset],
    activePatchsetId: patchset.id,
    dispositions: [],
    status: "current",
  };
}

const INPUT: LiveDraftPrBodyInput = {
  review: review(),
  base: "main",
  head: "feat/rate-limit-fallback",
  narration: {
    oneLine: "Adds a process-local fallback bucket to the rate limiter.",
    paragraph: "The fail-open path was unbounded; this bounds it.",
  },
  dispositions: [
    { type: "request-change", path: "keys.ts", resolution: "Document the migration note." },
  ],
  requirements: ["The limiter MUST bound the fail-open path"],
};

/** A fake codex executor capturing the request and returning a canned output. An
 *  `observedModel` stands in for the model the real executor reads from the session
 *  log (#74 MED-3) — distinct from the REQUESTED model to prove the port reports what
 *  ran, not the plan. */
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

describe("createLiveDraftPrBodyPort — Codex seat (council resolves Luna)", () => {
  it("drafts on Codex, reports the OBSERVED runtime model (not the requested pick), and grounds the prompt", async () => {
    let seenPrompt = "";
    let seenCwd: string | undefined;
    const port = createLiveDraftPrBodyPort({
      claudePort: async () => null,
      codexExecutor: async () =>
        fakeExecutor(
          { title: "Bound the rate limiter's fail-open path", body: "Adds a fallback bucket." },
          (req) => {
            seenPrompt = req.prompt;
            seenCwd = req.cwd;
          },
          // What Codex ACTUALLY ran (from its session log) — a runtime-versioned id
          // DISTINCT from the requested "gpt-5.6-luna", so reporting the plan reddens.
          "gpt-5.6-luna-2026-06-01",
        ),
    });
    const result = await port(INPUT);
    expect(result).toEqual({
      status: "drafted",
      title: "Bound the rate limiter's fail-open path",
      body: "Adds a fallback bucket.",
      // The OBSERVED model, not the council-resolved plan — provenance is what wrote it.
      model: "gpt-5.6-luna-2026-06-01",
    });
    // The real drafting material reached the model — the honest-account inputs, not
    // a diffstat. This is the citing contract on the LIVE path.
    // The citing contract on the LIVE path, through the files (3.7): the prompt names
    // them and runs in the checkout, and the material is on the other end of the paths.
    expect(seenPrompt).toContain("feat/rate-limit-fallback");
    expect(seenPrompt).toContain(".rennet/context/review-1/pr-body/narration.json");
    expect(seenPrompt).toContain(".rennet/context/review-1/pr-body/requirements.json");
    expect(seenPrompt).not.toContain("process-local fallback bucket");
    expect(seenPrompt).not.toContain("The limiter MUST bound the fail-open path");
    expect(seenCwd).toBe(REPO_ROOT);
    expect(contextFile("pr-body/narration.json")).toContain("process-local fallback bucket");
    expect(JSON.parse(contextFile("pr-body/requirements.json"))).toEqual([
      "The limiter MUST bound the fail-open path",
    ]);
    expect(contextFile("pr-body/dispositions.json")).toContain("Document the migration note.");
    expect(contextFile("README.md")).toContain("pr-body/dispositions.json");
  });

  it("falls back to the requested model when the session log named none (best remaining truth)", async () => {
    const port = createLiveDraftPrBodyPort({
      claudePort: async () => null,
      // No observed model from the executor (an uncorrelated / model-less session log).
      codexExecutor: async () => fakeExecutor({ title: "A clean title", body: "A clean body." }),
    });
    const result = await port(INPUT);
    // pr-body-draft resolves to Luna when Codex is installed (Table 1 / Table 3).
    expect(result).toEqual({
      status: "drafted",
      title: "A clean title",
      body: "A clean body.",
      model: "gpt-5.6-luna",
    });
  });

  it("returns an honest `failed` when the Codex turn throws — never a fabricated draft", async () => {
    const port = createLiveDraftPrBodyPort({
      claudePort: async () => null,
      codexExecutor: async () => async () => {
        throw new Error("codex exited 1");
      },
    });
    const result = await port(INPUT);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toContain("codex exited 1");
  });

  it("maps an empty title/body from the model to `failed` (the honesty floor holds live)", async () => {
    const port = createLiveDraftPrBodyPort({
      claudePort: async () => null,
      codexExecutor: async () => fakeExecutor({ title: "A title", body: "" }),
    });
    const result = await port(INPUT);
    expect(result.status).toBe("failed");
  });
});

describe("createLiveDraftPrBodyPort — Claude seat (Claude-only machine resolves Haiku)", () => {
  it("drafts on the Claude adapter and reports the ACTUAL runtime model, not the planned one", async () => {
    let seenSpec: SessionSpec | undefined;
    const port = createLiveDraftPrBodyPort({
      claudePort: async () =>
        fakeClaudePort(
          () => [
            startedEvent("claude-haiku-4-5-20260101"),
            completedEvent({
              title: "Add a rollback path",
              body: "The backfill needs a down migration.",
            }),
          ],
          (spec) => {
            seenSpec = spec;
          },
        ),
      codexExecutor: async () => null,
    });
    const result = await port(INPUT);
    expect(result).toEqual({
      status: "drafted",
      title: "Add a rollback path",
      body: "The backfill needs a down migration.",
      // The model the session STARTED on — provenance records what wrote the draft,
      // not the council's planned "haiku". Reporting the plan reddens this.
      model: "claude-haiku-4-5-20260101",
    });
    expect(seenSpec?.outputSchema).toBeDefined();
  });

  it("falls back to the resolved model when the session reports no started frame", async () => {
    const port = createLiveDraftPrBodyPort({
      claudePort: async () =>
        fakeClaudePort(() => [completedEvent({ title: "A title", body: "A body." })]),
      codexExecutor: async () => null,
    });
    const result = await port(INPUT);
    expect(result).toEqual({
      status: "drafted",
      title: "A title",
      body: "A body.",
      model: "haiku",
    });
  });

  it("fails honestly when the Claude turn completes without structured output", async () => {
    const port = createLiveDraftPrBodyPort({
      claudePort: async () => fakeClaudePort(() => [completedEvent(undefined)]),
      codexExecutor: async () => null,
    });
    const result = await port(INPUT);
    expect(result.status).toBe("failed");
  });
});

describe("createLiveDraftPrBodyPort — no seat installed", () => {
  it("is UNAVAILABLE when NEITHER Codex nor Claude is installed", async () => {
    const port = createLiveDraftPrBodyPort({
      claudePort: async () => null,
      codexExecutor: async () => null,
    });
    const result = await port(INPUT);
    expect(result.status).toBe("unavailable");
  });
});
