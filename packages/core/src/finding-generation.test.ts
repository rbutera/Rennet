import type { PatchFile, Patchset, RspCapabilitySnapshot } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { buildOfferedManifest } from "./angle-generation";
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

/** A mocked harness turn that emits the given body on attempt 0, then fails. */
function emits(body: unknown): (prompt: string, attempt: number) => Promise<FindingTurnResult> {
  return (_prompt, attempt) =>
    Promise.resolve(
      attempt === 0
        ? { status: "emitted", body }
        : { status: "failed", message: "no scripted body" },
    );
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

  it("refuses fail-closed when NO budget is provided (an absent budget is not authorization)", async () => {
    let turns = 0;
    const result = await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: () => {
        turns += 1;
        return Promise.resolve({ status: "emitted", body: { findings: [modelFinding()] } });
      },
    });
    expect(result.status).toBe("failed");
    expect(result.budgetRefused).toBe(true);
    expect(turns).toBe(0);
  });
});
