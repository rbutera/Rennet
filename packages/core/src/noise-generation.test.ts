import type { PatchFile, Patchset, RspCapabilitySnapshot } from "@rennet/protocol";
import { sha256Hex } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { decompose } from "./decomposition";
import { createInvocationBudget } from "./invocation-budget";
import { type NoiseProvenanceSeed, type NoiseTurnResult, runNoiseAngle } from "./noise-generation";
import { buildOfferedManifest } from "./offered-manifest";

// ── A tiny real changeset: a lockfile hunk + two source hunks ────────────────

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
    file("pnpm-lock.yaml", patch("pnpm-lock.yaml", ["+  resolution: {integrity: sha512-xxx}"])),
    file("src/a.ts", patch("src/a.ts", ["+export const a = 1;"])),
    file("src/b.ts", patch("src/b.ts", ['+import { a } from "./a";', "+export const b = a + 1;"])),
  ],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

const DECOMPOSITION = decompose(PATCHSET);
const MANIFEST = buildOfferedManifest(DECOMPOSITION);
/** Two real offered hunk ids, so items anchored here are genuinely grounded. */
const OFFERED_A = MANIFEST.occurrences[0]?.id ?? "h1";
const OFFERED_B = MANIFEST.occurrences[1]?.id ?? OFFERED_A;

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

const SEED: NoiseProvenanceSeed = {
  harness: "claude-code",
  harnessVersion: "2.1.220",
  adapterVersion: "0.1.0",
  model: "claude-opus-4-8",
  modelReportedBy: "harness",
  capability: CAPABILITY,
};

/** A mocked harness turn that emits the given body on attempt 0, then fails. */
function emits(body: unknown): (prompt: string, attempt: number) => Promise<NoiseTurnResult> {
  return (_prompt, attempt) =>
    Promise.resolve(
      attempt === 0
        ? { status: "emitted", body }
        : { status: "failed", message: "no scripted body" },
    );
}

/** A model group as the SDK would emit it (no groupId — the runner mints it). */
function ruleGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: "lockfile",
    summary: "Dependency graph unchanged; the lockfile was regenerated.",
    judgedBy: { kind: "rule", rule: "lockfile" },
    items: [{ anchor: `rennet:hunk/${OFFERED_A}`, detail: "pnpm-lock.yaml — hashes refreshed" }],
    ...overrides,
  };
}

/** A model group tagged noise-job (no model — the runner stamps it). */
function noiseJobGroup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: "import-order",
    summary: "Imports reordered; no symbol added or removed.",
    judgedBy: { kind: "noise-job" },
    items: [{ anchor: `rennet:hunk/${OFFERED_B}`, detail: "src/b.ts — imports sorted" }],
    ...overrides,
  };
}

describe("runNoiseAngle — the live noise runner (issue #34)", () => {
  it("feeds assembled context verbatim and preserves the absent-context prompt golden", async () => {
    const capture = async (assembledContext?: string): Promise<string> => {
      let prompt = "";
      await runNoiseAngle({
        patchsetId: PATCHSET.id,
        manifest: MANIFEST,
        provenance: SEED,
        noiseJobModel: "Claude",
        assembledContext,
        runTurn: (sent) => {
          prompt = sent;
          return Promise.resolve({ status: "emitted", body: { groups: [] } });
        },
        budget: createInvocationBudget(5),
      });
      return prompt;
    };
    const context = "shared context line one\nshared context line two";
    const absent = await capture();
    const present = await capture(context);

    expect(sha256Hex(absent)).toBe(
      "b42660d429e9d960e4fc49b208b02aa6d1ff811c179bb5117ac81b6ae8f4dcab",
    );
    expect(absent).not.toContain("<<<rennet:layer context>>>");
    expect(present).toContain(
      `<<<rennet:layer context>>>\n${context}\n\n<<<rennet:layer payload>>>`,
    );
  });

  it("admits grounded groups, minting the id and stamping the noise-job model", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      noiseJobModel: "Claude",
      runTurn: emits({ groups: [ruleGroup(), noiseJobGroup()] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups).toHaveLength(2);

    const ruleG = result.groups.find((g) => g.category === "lockfile");
    expect(ruleG?.judgedBy).toEqual({ kind: "rule", rule: "lockfile" });
    // The runner mints identity — the model never supplied a groupId.
    expect(typeof ruleG?.groupId).toBe("string");
    expect((ruleG?.groupId ?? "").length).toBeGreaterThan(0);

    const jobG = result.groups.find((g) => g.category === "import-order");
    // The runner OWNS the chip's model label — stamped, never the model's to assert.
    expect(jobG?.judgedBy).toEqual({ kind: "noise-job", model: "Claude" });
    expect(result.document?.docType).toBe("noise");
  });

  it("defaults the noise-job model to the provenance model when not overridden", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({ groups: [noiseJobGroup()] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups[0]?.judgedBy).toEqual({ kind: "noise-job", model: "claude-opus-4-8" });
  });

  it("culls an item whose anchor is not in the offered manifest (hallucinated)", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({
        groups: [
          ruleGroup({
            items: [
              { anchor: `rennet:hunk/${OFFERED_A}`, detail: "real hunk" },
              { anchor: "rennet:hunk/not-offered", detail: "hallucinated hunk" },
            ],
          }),
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.items).toHaveLength(1);
    expect(result.groups[0]?.items[0]?.detail).toBe("real hunk");
    expect(result.attempts[0]?.outcome).toBe("admitted");
  });

  it("drops a group left with no grounded items (nothing to collapse)", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({
        groups: [
          ruleGroup(),
          ruleGroup({ items: [{ anchor: "rennet:hunk/ghost", detail: "gone" }] }),
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups).toHaveLength(1);
    expect(result.attempts[0]?.culledCount).toBe(1);
  });

  it("drops a malformed group (bad category, empty summary, or junk judged-by)", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({
        groups: [
          ruleGroup({ category: "not-a-category" }),
          ruleGroup({ summary: "   " }),
          ruleGroup({ judgedBy: { kind: "rule", rule: "" } }),
          ruleGroup({ judgedBy: { kind: "nonsense" } }),
          noiseJobGroup(), // the one good group
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.category).toBe("import-order");
    expect(result.attempts[0]?.culledCount).toBe(4);
  });

  it("preserves the deviating flag so the derivation can eject the line", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({
        groups: [
          noiseJobGroup({
            items: [
              { anchor: `rennet:hunk/${OFFERED_A}`, detail: "sorted alphabetically" },
              {
                anchor: `rennet:hunk/${OFFERED_B}`,
                detail: "added a new import symbol",
                deviates: true,
              },
            ],
          }),
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    const items = result.groups[0]?.items ?? [];
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.deviates === true)?.detail).toBe("added a new import symbol");
  });

  it("culls an item whose detail smuggles a stray rennet: anchor", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({
        groups: [
          ruleGroup({
            items: [
              { anchor: `rennet:hunk/${OFFERED_A}`, detail: "clean detail" },
              { anchor: `rennet:hunk/${OFFERED_B}`, detail: "rennet:hunk/smuggled in prose" },
            ],
          }),
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups[0]?.items).toHaveLength(1);
    expect(result.groups[0]?.items[0]?.detail).toBe("clean detail");
  });

  it("returns status ok with an empty set when the model groups nothing (ran clean)", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({ groups: [] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups).toHaveLength(0);
    expect(result.budgetRefused).toBe(false);
  });

  // ── #158: a malformed body is not a clean review ─────────────────────────────
  // A model that returns a body which is not a noise document has NOT reviewed the
  // churn. Collapsing that to `{ groups: [] }` reports a clean review that grouped
  // nothing — indistinguishable from a genuine one. These two tests pin both
  // directions: a malformed body must FAIL, and a genuinely empty groups array
  // must still be OK. Emits the malformed body on EVERY attempt so the run resolves
  // to the terminal failed state (the original bug returned `ok` on attempt 0).

  it("treats a malformed body (not a noise document) as a failed turn, never a clean review (#158)", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: () =>
        Promise.resolve({
          status: "emitted",
          body: { result: "here is my prose review, nothing to group" },
        }),
      budget: createInvocationBudget(5),
    });
    // The bug's signature was `status: "ok"` with an empty groups set. The honest
    // outcome is the LOUD failed state — the model did not produce a noise document.
    expect(result.status).toBe("failed");
    expect(result.groups).toHaveLength(0);
    expect(result.report).toBeUndefined();
    expect(result.failureReason).toContain("malformed");
    // Recorded as its own fact, distinct from a turn that never emitted (turn-failed)
    // or an empty-but-valid review.
    expect(result.attempts.every((a) => a.outcome === "malformed-body")).toBe(true);
  });

  it.each([
    ["a bare string", "I reviewed the churn and it looks fine"],
    ["null", null],
    ["a bare array (the groups, un-wrapped)", []],
    ["an object whose groups is not an array", { groups: "none" }],
  ])("treats %s as malformed, not a clean review (#158)", async (_label, body) => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: () => Promise.resolve({ status: "emitted", body }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("failed");
    expect(result.groups).toHaveLength(0);
  });

  it("fails (not empty) when every turn fails — ran-clean is never faked from did-not-run", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: () => Promise.resolve({ status: "failed", message: "session died" }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("failed");
    expect(result.groups).toHaveLength(0);
    expect(result.failureReason).toBe("session died");
    expect(result.attempts.every((a) => a.outcome === "turn-failed")).toBe(true);
  });

  it("runs UNGATED when the budget is ABSENT — an absent budget is no ceiling, not no spend (#260)", async () => {
    let ran = false;
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: () => {
        ran = true;
        return Promise.resolve({ status: "emitted", body: { groups: [ruleGroup()] } });
      },
      // budget omitted — #260: no ceiling, the turn runs.
    });
    expect(ran).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.budgetRefused).toBe(false);
    expect(result.attempts[0]?.outcome).toBe("admitted");
  });

  it("refuses fail-closed on an exhausted (zero-ceiling) budget", async () => {
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({ groups: [ruleGroup()] }),
      budget: createInvocationBudget(0),
    });
    expect(result.status).toBe("failed");
    expect(result.budgetRefused).toBe(true);
  });

  it("retries after a turn failure and admits on a later successful turn", async () => {
    let attempts = 0;
    const result = await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.resolve({ status: "failed", message: "first turn transport error" })
          : Promise.resolve({ status: "emitted", body: { groups: [ruleGroup()] } });
      },
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.groups).toHaveLength(1);
    expect(result.attempts[0]?.outcome).toBe("turn-failed");
    expect(result.attempts[1]?.outcome).toBe("admitted");
  });
});
