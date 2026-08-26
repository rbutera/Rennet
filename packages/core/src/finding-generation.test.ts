import type { PatchFile, Patchset, RspCapabilitySnapshot, RspEnvelope } from "@rennet/protocol";
import { sha256Hex } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { buildOfferedManifest } from "./angle-generation";
import { createCodexRunTurn } from "./codex-run-turn";
import type { CodexUtilityPort, CodexUtilityResult } from "./codex-utility-port";
import { decompose } from "./decomposition";
import {
  type FindingProvenanceSeed,
  type FindingTurnResult,
  runFindingAngle,
} from "./finding-generation";
import { createInvocationBudget } from "./invocation-budget";

// ── A tiny real changeset: b.ts imports a.ts, plus one lockfile (mechanical) ─

function file(path: string, patch: string, extra: Partial<PatchFile> = {}): PatchFile {
  return {
    path,
    status: "modified",
    additions: null,
    deletions: null,
    binary: false,
    patch,
    ...extra,
  };
}

function patch(path: string, lines: string[]): string {
  const oldCount = lines.filter((l) => l[0] === "-" || l[0] === " ").length;
  const newCount = lines.filter((l) => l[0] === "+" || l[0] === " ").length;
  return (
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
    `@@ -1,${oldCount} +1,${newCount} @@\n${lines.join("\n")}\n`
  );
}

const PATCHSET: Patchset = {
  id: "ps_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/repo",
    commonDir: "/repo/.git",
    baseRef: "origin/main",
    baseOid: "0".repeat(40),
    headOid: "1".repeat(40),
  },
  files: [
    file("src/a.ts", patch("src/a.ts", ["+export const a = 1;"])),
    file("src/b.ts", patch("src/b.ts", ['+import { a } from "./a";', "+export const b = a + 1;"])),
    file("pnpm-lock.yaml", patch("pnpm-lock.yaml", ["+  resolution: {integrity: sha512-xxx}"])),
  ],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

const DECOMPOSITION = decompose(PATCHSET);
const MANIFEST = buildOfferedManifest(DECOMPOSITION);
/** A real offered hunk id, so a finding anchored here is genuinely grounded. */
const OFFERED_HUNK = MANIFEST.occurrences[0]?.id ?? "h1";

const CAPABILITY: RspCapabilitySnapshot = {
  structuredOutput: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
  perCallModelSelection: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
};

const SEED: FindingProvenanceSeed = {
  harness: "claude-code",
  harnessVersion: "2.1.220",
  adapterVersion: "0.1.0",
  model: "claude-opus-4-8",
  modelReportedBy: "harness",
  capability: CAPABILITY,
};

const PORT_CAPABILITY: RspCapabilitySnapshot = {
  structuredOutput: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
  perCallModelSelection: {
    implementedByAdapter: false,
    advertisedByHarness: false,
    availableInSession: false,
  },
};

function codexEnvelope(body: unknown): RspEnvelope {
  return {
    rsp: 1,
    docType: "finding",
    schemaVersion: 1,
    docId: "PORT_DOC",
    patchsetId: PATCHSET.id,
    provenance: {
      harness: "codex",
      harnessVersion: "0.9.0",
      adapterVersion: "0.1.0",
      model: "gpt-5.6-terra",
      modelReportedBy: "config",
      tier: "light",
      route: "utility",
      runId: "port_run",
      inputDigest: "sha256:port",
      capability: PORT_CAPABILITY,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: null, total: 2 },
      reportedUsd: null,
      derivedUsd: null,
    },
    body,
    x: {},
  };
}

function codexPort(body: unknown): CodexUtilityPort {
  return {
    complete: async (): Promise<CodexUtilityResult> => ({
      status: "admitted",
      document: codexEnvelope(body),
      report: {
        docType: "finding",
        admission: "atomic",
        admitted: true,
        errors: [],
        admittedItemCount: null,
        rejectedItemCount: 0,
        rejectedItems: [],
      },
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: null, total: 2 },
      attempts: [],
    }),
  };
}

/** A mocked harness turn that emits the given body on attempt 0, then fails. */
function emits(body: unknown): (prompt: string, attempt: number) => Promise<FindingTurnResult> {
  return (_prompt, attempt) =>
    Promise.resolve(
      attempt === 0
        ? { status: "emitted", body }
        : { status: "failed", message: "no scripted body" },
    );
}

/** A mocked harness turn that emits the given body on EVERY attempt. */
function alwaysEmits(
  body: unknown,
): (prompt: string, attempt: number) => Promise<FindingTurnResult> {
  return () => Promise.resolve({ status: "emitted", body });
}

/** A model finding as the SDK would emit it (no findingId — the runner mints it). */
function modelFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    anchor: `rennet:hunk/${OFFERED_HUNK}`,
    summary: "the new export shadows an existing binding and changes call resolution",
    severity: "medium",
    agreement: { kind: "concur", agree: 1, total: 1 },
    ...overrides,
  };
}

describe("runFindingAngle — the live finding runner (issue #32)", () => {
  it("feeds assembled context verbatim and preserves the absent-context prompt golden", async () => {
    const capture = async (assembledContext?: string): Promise<string> => {
      let prompt = "";
      await runFindingAngle({
        patchsetId: PATCHSET.id,
        manifest: MANIFEST,
        provenance: SEED,
        assembledContext,
        runTurn: (sent) => {
          prompt = sent;
          return Promise.resolve({ status: "emitted", body: { findings: [] } });
        },
        budget: createInvocationBudget(5),
      });
      return prompt;
    };
    const context = "shared context line one\nshared context line two";
    const absent = await capture();
    const present = await capture(context);

    expect(sha256Hex(absent)).toBe(
      "28657be302ffa327584a27a8ef75f61b5130bc59093666d1d1a9bd2e20ee2bfc",
    );
    expect(absent).not.toContain("<<<rennet:layer context>>>");
    expect(present).toContain(
      `<<<rennet:layer context>>>\n${context}\n\n<<<rennet:layer payload>>>`,
    );
  });

  it("admits a grounded finding, minting the id and owning the concur vote", async () => {
    const result = await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({ findings: [modelFinding()] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding?.anchor).toBe(`rennet:hunk/${OFFERED_HUNK}`);
    expect(finding?.severity).toBe("medium");
    // The runner mints identity — the model never supplied a findingId.
    expect(typeof finding?.findingId).toBe("string");
    expect((finding?.findingId ?? "").length).toBeGreaterThan(0);
    // The vote is the runner's authority: a single model concurs with itself.
    expect(finding?.agreement).toEqual({ kind: "concur", agree: 1, total: 1 });
    // The emitted document is a real admitted `finding` doc.
    expect(result.document?.docType).toBe("finding");
    expect(result.report?.admitted).toBe(true);
  });

  it("prefers a Codex utility turn's executor provenance over the seed (#88)", async () => {
    const runTurn = createCodexRunTurn(codexPort({ findings: [modelFinding()] }), {
      docType: "finding",
      patchset: { id: PATCHSET.id },
      manifest: MANIFEST,
      model: "gpt-5.6-terra",
      effort: "medium",
    });
    const result = await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn,
      budget: createInvocationBudget(5),
    });

    expect(result.status).toBe("ok");
    expect(result.document?.provenance.route).toBe("utility");
    expect(result.document?.provenance.tier).toBe("light");
    expect(result.document?.provenance.capability).toEqual(PORT_CAPABILITY);
  });

  it("normalises the vote even when the model reports a different one", async () => {
    const result = await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      // The model claims a 3-of-3 council vote; a single-model run cannot, and the
      // runner overwrites it rather than trust the model's self-certified vote.
      runTurn: emits({
        findings: [modelFinding({ agreement: { kind: "concur", agree: 3, total: 3 } })],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.findings[0]?.agreement).toEqual({ kind: "concur", agree: 1, total: 1 });
  });

  it("culls an ungrounded finding (a hallucinated anchor) without sinking the grounded ones", async () => {
    const result = await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({
        findings: [
          modelFinding({ anchor: "rennet:hunk/does-not-exist", summary: "points at nothing" }),
          modelFinding({ summary: "a real, grounded concern about the shown lines" }),
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.summary).toBe("a real, grounded concern about the shown lines");
    expect(result.attempts.at(-1)?.culledCount).toBe(1);
    // The surviving, culled document still admits.
    expect(result.report?.admitted).toBe(true);
  });

  it("culls a word-less finding (an empty summary is not a flag)", async () => {
    const result = await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({ findings: [modelFinding({ summary: "   " })] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.findings).toHaveLength(0);
  });

  it("is honestly empty when the model flags nothing (ran clean, not failed)", async () => {
    const result = await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({ findings: [] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.findings).toEqual([]);
    expect(result.report?.admitted).toBe(true);
  });

  // ── #158 item 1: a malformed body is not a clean review ──────────────────
  // A model that returns a body which is not a finding document has NOT reviewed
  // the code. Collapsing that to `{ findings: [] }` reports a clean review that
  // found nothing — indistinguishable from a genuine one. These two tests pin
  // both directions: a malformed body must FAIL, and a genuinely empty findings
  // array must still be OK.

  it("treats a malformed body (not a finding document) as a failed turn, never a clean review (#158)", async () => {
    // A shape the model must never be believed for: an object with no findings array.
    const result = await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: alwaysEmits({ result: "here is my prose review, I found nothing wrong" }),
      budget: createInvocationBudget(5),
    });
    // The bug's signature was `status: "ok"` with an empty findings set. The honest
    // outcome is the LOUD failed state — the model did not produce a finding document.
    expect(result.status).toBe("failed");
    expect(result.findings).toEqual([]);
    expect(result.failureReason).toContain("malformed");
    // The malformed emission is recorded as its own fact, distinct from a turn that
    // never emitted (turn-failed) or an empty-but-valid review.
    expect(result.attempts.every((a) => a.outcome === "malformed-body")).toBe(true);
  });

  it.each([
    ["a bare string", "I reviewed the code and it looks fine"],
    ["null", null],
    ["a bare array (the findings, un-wrapped)", []],
    ["an object whose findings is not an array", { findings: "none" }],
  ])("treats %s as malformed, not a clean review (#158)", async (_label, body) => {
    const result = await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: alwaysEmits(body),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("failed");
    expect(result.findings).toEqual([]);
  });

  it("a genuinely empty findings array is a CLEAN review and still reports ok (#158, the other direction)", async () => {
    // The companion to the malformed test: `{ findings: [] }` is a model that
    // reviewed the code and flagged nothing. This must keep working exactly.
    const result = await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: alwaysEmits({ findings: [] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.findings).toEqual([]);
    expect(result.report?.admitted).toBe(true);
    expect(result.attempts.at(-1)?.outcome).toBe("admitted");
  });

  it("resolves to the LOUD failed state when every turn fails (no fabricated floor)", async () => {
    const result = await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: () => Promise.resolve({ status: "failed", message: "the harness transport died" }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("failed");
    expect(result.findings).toEqual([]);
    expect(result.failureReason).toContain("transport");
  });

  it("refuses fail-closed when the budget is exhausted — no turn runs (R10)", async () => {
    let turns = 0;
    const result = await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: () => {
        turns += 1;
        return Promise.resolve({ status: "emitted", body: { findings: [modelFinding()] } });
      },
      budget: createInvocationBudget(0),
    });
    expect(result.status).toBe("failed");
    expect(result.budgetRefused).toBe(true);
    expect(turns).toBe(0);
  });

  it("runs UNGATED when NO budget is provided — an absent budget is no ceiling, not no spend (#260)", async () => {
    let turns = 0;
    const result = await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: () => {
        turns += 1;
        return Promise.resolve({ status: "emitted", body: { findings: [modelFinding()] } });
      },
      // budget omitted — #260: no ceiling, the turn runs.
    });
    expect(result.status).toBe("ok");
    expect(result.budgetRefused).toBe(false);
    expect(turns).toBe(1);
  });

  it("reasons over the change's stated intent — the PR body reaches the prompt (#136/#210)", async () => {
    let seenPrompt = "";
    await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      intent: {
        prTitle: "Guard the loop bound",
        prBody: "UNIQUE_FINDING_INTENT_MARKER: add a bound check before the copy loop.",
      },
      runTurn: (prompt) => {
        seenPrompt = prompt;
        return Promise.resolve({ status: "emitted", body: { findings: [] } });
      },
      budget: createInvocationBudget(5),
    });
    // The intent rides the `task` slot, so both the marker and the title reach the prompt.
    expect(seenPrompt).toContain("<<<rennet:layer task>>>");
    expect(seenPrompt).toContain("UNIQUE_FINDING_INTENT_MARKER");
    expect(seenPrompt).toContain("Guard the loop bound");
  });

  it("assembles NO task layer when no intent is supplied (byte-identical to before #210)", async () => {
    let seenPrompt = "";
    await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: (prompt) => {
        seenPrompt = prompt;
        return Promise.resolve({ status: "emitted", body: { findings: [] } });
      },
      budget: createInvocationBudget(5),
    });
    // Absent intent (and no retry report on the first attempt), the task slot is empty.
    expect(seenPrompt).not.toContain("<<<rennet:layer task>>>");
  });
});
