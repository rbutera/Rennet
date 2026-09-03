import {
  CI_CLASSIFICATION_CONTRACT,
  CONVENTIONS_PATH,
  FINDING_VERIFICATION_CONTRACT,
  hypothesisContextFile,
  renderCiClassificationPrompt,
  renderConventionLayer,
  renderFindingVerificationPrompt,
  renderHypothesisLayer,
} from "@rennet/prompts";
import type { ConventionCatalogue, ReviewHypothesis } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { inlineContextViolation } from "./harness-run-turn";
import { buildRefinePrompt } from "./refine-comment";

// ─────────────────────────────────────────────────────────────────────────────
// The no-inline-context rule, asserted for the four turns of tasks 3.6 and 3.9
// (session-context-files, D4): every prompt NAMES the file it wants read, and
// carries no JSON payload — `inlineContextViolation` is the mechanical reading of
// "never inline context" the send tap already records.
//
// The fixtures are deliberately the size the rule exists for: a hypothesis with
// four risks, an eight-rule convention catalogue, a 74-path changed set. Before
// this change those inputs rendered 1,391 / 3,199 / 11,496 / 3,881 / 9,324 bytes
// of prompt; the sizes below are what they render now.
// ─────────────────────────────────────────────────────────────────────────────

const DIR = ".rennet/context/sess_01JQ8F2K9V";

const HYPOTHESIS: ReviewHypothesis = {
  domain: "Session-bound workspace binding and the round worker's commit path.",
  scope: {
    inScope: ["round dispatch", "worktree binding", "patchset capture"],
    outOfScope: ["the app-ui coverage mosaic", "vendored T3 server code"],
  },
  designExpectation:
    "One workspace root per session, recorded on the session record, reused as the cwd of every child turn and as the worktreePath of every thread.",
  risks: [
    {
      riskId: "r1",
      severity: "high",
      statement: "A round commits into the wrong repository in a multi-repo workspace.",
      disconfirmer: "The dispatch carries owner/name from the row rather than project.openPath.",
    },
    {
      riskId: "r2",
      severity: "high",
      statement: "Context files are staged by the round's own commit.",
      disconfirmer: "The managed ignore block carries context/ before the first write.",
    },
    {
      riskId: "r3",
      severity: "medium",
      statement: "A purge removes a live session's files mid-turn.",
      disconfirmer: "Purge runs only on archive and the orphan sweep matches absent ids.",
    },
    {
      riskId: "r4",
      severity: "low",
      statement: "The WSL path translation is dropped without a replacement.",
      disconfirmer: "The locus helper translates the bound root once at thread creation.",
    },
  ],
  repoContextPresent: true,
};

const CATALOGUE: ConventionCatalogue = {
  source: "/repo/.rennet/conventions.json",
  rules: Array.from({ length: 8 }, (_, i) => ({
    id: `rule-${i}`,
    convention: `Convention ${i}: every cacheable Nx target declares the inputs that decide its verdict.`,
    rationale: `A target whose inputs omit a file that decides its verdict returns a stale pass, and a stale pass reads exactly like a real one (${i}).`,
    severity: (i % 2 === 0 ? "high" : "medium") as "high" | "medium",
    antiPattern: `A target with no inputs block at all, or one naming only root-owned globs (${i}).`,
  })),
};

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("the hypothesis layer points at a file (task 3.6)", () => {
  const layer = renderHypothesisLayer(HYPOTHESIS, `${DIR}/hypothesis.json`);

  it("names the written hypothesis and carries no risk statement", () => {
    expect(layer).toContain(`${DIR}/hypothesis.json`);
    expect(inlineContextViolation(layer)).toBeUndefined();
    // The prior's content is the thing that must NOT travel: no domain, no scope, no
    // risk statement, no disconfirmer.
    expect(layer).not.toContain(HYPOTHESIS.domain);
    expect(layer).not.toContain("round dispatch");
    expect(layer).not.toContain(HYPOTHESIS.risks[0]?.statement ?? "");
    expect(layer).not.toContain(HYPOTHESIS.risks[0]?.disconfirmer ?? "");
    expect(bytes(layer)).toBeLessThan(1_000);
  });

  it("keeps the standing disconfirm instruction, which IS the layer's job", () => {
    expect(layer).toContain("EXPECTATIONS to disconfirm");
    expect(layer).toContain("surface a finding where it does");
  });

  it("defaults to the bare file name, which resolves inside the context directory", () => {
    expect(renderHypothesisLayer(HYPOTHESIS)).toContain("`hypothesis.json`");
  });

  it("writes the whole prior as the file body, compact — the WRITER call", () => {
    const file = hypothesisContextFile(HYPOTHESIS);
    expect(file.name).toBe("hypothesis.json");
    // Byte-for-byte the prior, and NOT pretty-printed (the indent is a ~30% surcharge).
    expect(file.body).toBe(JSON.stringify(HYPOTHESIS));
    expect(file.body).not.toContain("\n");
    expect(JSON.parse(file.body)).toEqual(HYPOTHESIS);
    // The index needs both lines; an entry with either missing reads as a file nobody
    // knows when to open.
    expect(file.holds.length).toBeGreaterThan(0);
    expect(file.readWhen.length).toBeGreaterThan(0);
  });
});

describe("the convention layer points at the repo's own file (task 3.6)", () => {
  const layer = renderConventionLayer(CATALOGUE);

  it("names `.rennet/conventions.json` and carries no rule", () => {
    expect(layer).toContain(CONVENTIONS_PATH);
    expect(CONVENTIONS_PATH).toBe(".rennet/conventions.json");
    expect(inlineContextViolation(layer)).toBeUndefined();
    expect(layer).not.toContain(CATALOGUE.rules[0]?.convention ?? "");
    expect(layer).not.toContain(CATALOGUE.rules[0]?.rationale ?? "");
    expect(layer).not.toContain(CATALOGUE.rules[0]?.antiPattern ?? "");
    expect(bytes(layer)).toBeLessThan(1_000);
  });

  it("keeps the never-cite-a-rule-number product rule", () => {
    expect(layer).toContain("NEVER a rule id or number");
    // The author-facing id must not reach the model at all — there is no rule-number
    // vocabulary to reach for.
    expect(layer).not.toContain("rule-0");
  });

  it("counts the rules, so a seat knows the file is worth opening", () => {
    expect(layer).toContain("8 conventions");
    expect(renderConventionLayer({ ...CATALOGUE, rules: CATALOGUE.rules.slice(0, 1) })).toContain(
      "1 convention and known anti-pattern in",
    );
  });
});

describe("the finding-verification prompt points at a file (task 3.9)", () => {
  const prompt = renderFindingVerificationPrompt(FINDING_VERIFICATION_CONTRACT, {
    pointersPath: `${DIR}/verification/f-1a2b3c.json`,
    findings: [
      {
        ref: "f1",
        severity: "high",
        summary:
          "The CI refinement turn is built before the council resolution is checked, so a codex-only machine spawns a claude session.",
      },
    ],
  });

  it("names its pointer file and carries no window, hunk or JSON", () => {
    expect(prompt).toContain(`${DIR}/verification/f-1a2b3c.json`);
    expect(inlineContextViolation(prompt)).toBeUndefined();
    expect(prompt).not.toContain("@@");
    expect(bytes(prompt)).toBeLessThan(4_000);
  });

  it("no longer claims a window was shown", () => {
    // The old discipline sentence said "You are shown a file window to start from".
    expect(prompt).not.toContain("You are shown");
    expect(prompt).toContain("NOTHING is shown to you inline");
  });

  it("keeps the finding it is verifying — the task, not the context", () => {
    expect(prompt).toContain("### f1 — severity: high");
    expect(prompt).toContain("Concern: The CI refinement turn is built");
  });
});

describe("the CI-classification prompt points at a file (task 3.9)", () => {
  const prompt = renderCiClassificationPrompt(CI_CLASSIFICATION_CONTRACT, {
    pointersPath: `${DIR}/ci-pointers.json`,
  });

  it("names its pointer file and carries no failure, evidence or path list", () => {
    expect(prompt).toContain(`${DIR}/ci-pointers.json`);
    expect(inlineContextViolation(prompt)).toBeUndefined();
    expect(bytes(prompt)).toBeLessThan(2_000);
  });

  it("no longer claims the check name and summary were supplied", () => {
    // The old discipline sentence said "Use only the supplied check name, failure
    // summary, and changed-path list".
    expect(prompt).not.toContain("the supplied check name");
    expect(prompt).toContain("Read the pointer file");
  });

  it("keeps the verdict vocabulary and the never-environmental rule", () => {
    expect(prompt).toContain('"change-caused" or "unclassified"');
    expect(prompt).toContain("may never produce that verdict");
  });
});

describe("the refine prompt points at a file (task 3.9)", () => {
  const prompt = buildRefinePrompt({
    raw: "this breaks per-key clients?? add note",
    type: "request-change",
    lens: "decisions",
    path: "packages/server/src/create-server.ts",
    pointersPath: `${DIR}/refine-pointers.json`,
  });

  it("names its pointer file and carries no diff fence", () => {
    expect(prompt).toContain(`${DIR}/refine-pointers.json`);
    expect(inlineContextViolation(prompt)).toBeUndefined();
    expect(prompt).not.toContain("diff --git");
    expect(bytes(prompt)).toBeLessThan(2_000);
  });
});
