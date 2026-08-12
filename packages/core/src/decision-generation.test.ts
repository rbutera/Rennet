import type { PatchFile, Patchset, RspCapabilitySnapshot } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { buildOfferedManifest } from "./angle-generation";
import {
  type DecisionProvenanceSeed,
  type DecisionTurnResult,
  runDecisionAngle,
} from "./decision-generation";
import { decompose } from "./decomposition";
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
/** A real offered hunk id, so a decision anchored here is genuinely grounded. */
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

const SEED: DecisionProvenanceSeed = {
  harness: "claude-code",
  harnessVersion: "2.1.220",
  adapterVersion: "0.1.0",
  model: "claude-opus-4-8",
  modelReportedBy: "harness",
  capability: CAPABILITY,
};

/** A mocked harness turn that emits the given body on attempt 0, then fails. */
function emits(body: unknown): (prompt: string, attempt: number) => Promise<DecisionTurnResult> {
  return (_prompt, attempt) =>
    Promise.resolve(
      attempt === 0
        ? { status: "emitted", body }
        : { status: "failed", message: "no scripted body" },
    );
}

/** A model decision as the SDK would emit it (no decisionId — the runner mints it). */
function modelDecision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    anchor: `rennet:hunk/${OFFERED_HUNK}`,
    title: "Keyed the review store per repository root, not per branch",
    evidence: [
      { kind: "hunk", label: "store.ts +18", detail: "const key = repository.commonDir;" },
    ],
    // The model emits `{ text }`; the runner stamps `reconstructed: true`.
    why: { text: "Branch-keying drops the review the moment the branch is force-pushed." },
    alternatives: ["Key per branch ref (lost on force-push)"],
    ...overrides,
  };
}

describe("runDecisionAngle — the live decision runner (issue #137)", () => {
  it("admits a grounded decision, minting the id and carrying evidence + alternatives", async () => {
    const result = await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({ decisions: [modelDecision()] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.decisions).toHaveLength(1);
    const decision = result.decisions[0];
    expect(decision?.anchor).toBe(`rennet:hunk/${OFFERED_HUNK}`);
    expect(decision?.title).toContain("per repository root");
    // The runner mints identity — the model never supplied a decisionId.
    expect(typeof decision?.decisionId).toBe("string");
    expect((decision?.decisionId ?? "").length).toBeGreaterThan(0);
    expect(decision?.evidence?.[0]?.kind).toBe("hunk");
    expect(decision?.alternatives).toEqual(["Key per branch ref (lost on force-push)"]);
    // The emitted document is a real admitted `decision.record` doc.
    expect(result.document?.docType).toBe("decision.record");
    expect(result.report?.admitted).toBe(true);
    expect(result.report?.rejectedItemCount).toBe(0);
  });

  it("stamps why.reconstructed=true (the runner owns it; the model only supplies the text)", async () => {
    const result = await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      // The model emits a why with NO `reconstructed` field, and even a smuggled
      // `reconstructed: false`; the runner overwrites it to the literal `true`.
      runTurn: emits({
        decisions: [
          modelDecision({ why: { text: "an inferred rationale", reconstructed: false } }),
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.decisions[0]?.why).toEqual({
      reconstructed: true,
      text: "an inferred rationale",
    });
  });

  it("omits the why when none is discernible — renders on title + evidence, never invents one", async () => {
    const noWhy = await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({ decisions: [modelDecision({ why: undefined })] }),
      budget: createInvocationBudget(5),
    });
    expect(noWhy.decisions[0]?.why).toBeUndefined();
    // A whitespace-only why is not a rationale: dropped, not carried as invented.
    const emptyWhy = await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({ decisions: [modelDecision({ why: { text: "   " } })] }),
      budget: createInvocationBudget(5),
    });
    expect(emptyWhy.decisions[0]?.why).toBeUndefined();
    expect(emptyWhy.decisions[0]?.title).toContain("per repository root");
  });

  it("culls an ungrounded decision (a hallucinated anchor) without sinking the grounded ones", async () => {
    const result = await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({
        decisions: [
          modelDecision({ anchor: "rennet:hunk/does-not-exist", title: "points at nothing" }),
          modelDecision({ title: "a real, grounded decision about the shown lines" }),
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.title).toBe("a real, grounded decision about the shown lines");
    expect(result.attempts.at(-1)?.culledCount).toBe(1);
    // The surviving, culled document still admits with a zero rejected count.
    expect(result.report?.admitted).toBe(true);
    expect(result.report?.rejectedItemCount).toBe(0);
  });

  it("culls a title-less decision (a decision needs a plain-language call)", async () => {
    const result = await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({ decisions: [modelDecision({ title: "   " })] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.decisions).toHaveLength(0);
  });

  it("keeps a decision with no discernible evidence (title + anchor still render)", async () => {
    const result = await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      // Malformed evidence chips are dropped; a bad `kind` and a non-string detail
      // both go, leaving a decision that stands on its title + anchor.
      runTurn: emits({
        decisions: [
          modelDecision({
            evidence: [
              { kind: "verdict", label: "x", detail: "y" },
              { kind: "hunk", detail: 7 },
            ],
            why: undefined,
          }),
        ],
      }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.evidence).toEqual([]);
  });

  it("strips any triage classification the model smuggles in (no evidenced/mechanical/contestable bucket)", async () => {
    // The grep control: the model DID emit triage keys, so the check can go red.
    const smuggled = modelDecision({
      triage: "contestable",
      classification: "mechanical",
      verdict: "evidenced",
    });
    expect(Object.keys(smuggled)).toEqual(expect.arrayContaining(["triage", "classification"]));

    const result = await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({ decisions: [smuggled] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    const decision = result.decisions[0];
    // The runner constructs a fresh element with ONLY the no-triage shape.
    const allowed = new Set(["decisionId", "anchor", "title", "evidence", "alternatives", "why"]);
    for (const key of Object.keys(decision ?? {})) expect(allowed.has(key)).toBe(true);
    // And the serialized emitted body carries none of the triage buckets.
    const serialized = JSON.stringify(result.document?.body ?? {});
    expect(/"triage"|"classification"|"verdict"/.test(serialized)).toBe(false);
    // Every evidence chip is source/label/detail only — never a verdict field.
    for (const chip of decision?.evidence ?? []) {
      expect(new Set(Object.keys(chip))).toEqual(new Set(["kind", "label", "detail"]));
    }
  });

  it("reasons over the change's stated intent — the PR body reaches the prompt", async () => {
    let seenPrompt = "";
    await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      intent: {
        prTitle: "Fail-closed carry on a truncated patch",
        prBody:
          "UNIQUE_INTENT_MARKER: refuse to carry a disposition over a patch we could not read.",
      },
      runTurn: (prompt) => {
        seenPrompt = prompt;
        return Promise.resolve({ status: "emitted", body: { decisions: [] } });
      },
      budget: createInvocationBudget(5),
    });
    expect(seenPrompt).toContain("UNIQUE_INTENT_MARKER");
    expect(seenPrompt).toContain("Fail-closed carry on a truncated patch");
  });

  it("is honestly empty when the model discerns nothing (ran clean, not failed)", async () => {
    const result = await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: emits({ decisions: [] }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.decisions).toEqual([]);
    expect(result.report?.admitted).toBe(true);
  });

  // ── #158: a malformed body is not a clean review ─────────────────────────────
  // A model that returns a body which is not a decision document has NOT reviewed
  // the code. Collapsing that to `{ decisions: [] }` reports a clean review that
  // discerned nothing — indistinguishable from a genuine one. These two tests pin
  // both directions: a malformed body must FAIL, and a genuinely empty decisions
  // array must still be OK. Emits the malformed body on EVERY attempt so the run
  // resolves to the terminal failed state (the original bug returned `ok` on
  // attempt 0).

  it("treats a malformed body (not a decision document) as a failed turn, never a clean review (#158)", async () => {
    const result = await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: () =>
        Promise.resolve({
          status: "emitted",
          body: { result: "here is my prose review, no decisions to report" },
        }),
      budget: createInvocationBudget(5),
    });
    // The bug's signature was `status: "ok"` with an empty decisions set. The honest
    // outcome is the LOUD failed state — the model did not produce a decision document.
    expect(result.status).toBe("failed");
    expect(result.decisions).toEqual([]);
    expect(result.document).toBeUndefined();
    expect(result.failureReason).toContain("malformed");
    // Recorded as its own fact, distinct from a turn that never emitted (turn-failed)
    // or an empty-but-valid review.
    expect(result.attempts.every((a) => a.outcome === "malformed-body")).toBe(true);
  });

  it.each([
    ["a bare string", "I reviewed the code and it looks fine"],
    ["null", null],
    ["a bare array (the decisions, un-wrapped)", []],
    ["an object whose decisions is not an array", { decisions: "none" }],
  ])("treats %s as malformed, not a clean review (#158)", async (_label, body) => {
    const result = await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: () => Promise.resolve({ status: "emitted", body }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("failed");
    expect(result.decisions).toEqual([]);
  });

  it("resolves to the LOUD failed state when every turn fails (no fabricated floor)", async () => {
    const result = await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: () => Promise.resolve({ status: "failed", message: "the harness transport died" }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("failed");
    expect(result.decisions).toEqual([]);
    expect(result.document).toBeUndefined();
    expect(result.failureReason).toContain("transport");
  });

  it("refuses fail-closed when the budget is exhausted — no turn runs (R10)", async () => {
    let turns = 0;
    const result = await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: () => {
        turns += 1;
        return Promise.resolve({ status: "emitted", body: { decisions: [modelDecision()] } });
      },
      budget: createInvocationBudget(0),
    });
    expect(result.status).toBe("failed");
    expect(result.budgetRefused).toBe(true);
    expect(turns).toBe(0);
  });

  it("runs UNGATED when NO budget is provided — an absent budget is no ceiling, not no spend (#260)", async () => {
    let turns = 0;
    const result = await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: () => {
        turns += 1;
        return Promise.resolve({ status: "emitted", body: { decisions: [modelDecision()] } });
      },
      // budget omitted — #260: no ceiling, the turn runs.
    });
    expect(result.status).toBe("ok");
    expect(result.budgetRefused).toBe(false);
    expect(turns).toBe(1);
  });
});
