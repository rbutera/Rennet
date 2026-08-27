import type { DraftBoard, DraftElement, LensKind } from "@rennet/protocol";
import { parseDraft } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCAFFOLD_GLOBS,
  type LintContext,
  type LintHunk,
  lint,
  lintReviewDraft,
} from "./lint";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const author = { kind: "lens-agent" as const, id: "flagged-seat" };

const el = (id: string, kind: string, data: Record<string, unknown>): DraftElement =>
  ({ id, kind, data: { author, ...data } }) as DraftElement;

const codeRef = (id: string, path: string, start: number, end: number): DraftElement =>
  el(id, "code_ref", {
    patchset_id: "ps-1",
    path,
    side: "head",
    start_line: start,
    end_line: end,
  });

const board = (elements: DraftElement[], extra: Record<string, unknown> = {}): DraftBoard =>
  ({ elements, ...extra }) as DraftBoard;

const HUNKS: LintHunk[] = [
  { id: "h1", path: "src/auth.ts", newStart: 10, newLines: 5 },
  { id: "h2", path: "src/util.ts", newStart: 1, newLines: 3 },
];

const ctx = (over: Partial<LintContext> = {}): LintContext => ({
  lens: "flagged",
  hunks: HUNKS,
  files: new Map([
    ["src/auth.ts", 200],
    ["src/util.ts", 50],
  ]),
  ...over,
});

/** A board that passes every rule — the clean control each rule tests against. */
const cleanBoard = (over: Record<string, unknown> = {}): DraftBoard =>
  board(
    [
      el("f1", "finding", {
        severity: "high",
        concern: "The refresh token is classified as an error before its code is read.",
        code: ["c1"],
        concurrence: [],
        status: "open",
      }),
      codeRef("c1", "src/auth.ts", 11, 12),
    ],
    {
      skippedHunks: [
        { hunk: "h2", reason: "The util rename is mechanical — the Noise board owns it." },
      ],
      ...over,
    },
  );

const rulesHit = (violations: { ruleId: string }[]) => new Set(violations.map((v) => v.ruleId));

// ── The clean control ────────────────────────────────────────────────────────

describe("lint — the clean control", () => {
  it("a well-formed board raises zero violations", () => {
    expect(lint(cleanBoard(), ctx())).toEqual([]);
  });

  it("a Violation carries ruleId + elementRef + message", () => {
    const bad = board([el("p1", "prose", { markdown: "```ts\nconst x = 1;\n```" })], {
      skippedHunks: [],
    });
    const v = lint(bad, ctx())[0];
    expect(v).toBeDefined();
    expect(v?.ruleId).toBe("no-code-bytes");
    expect(v?.elementRef).toBe("p1/markdown");
    expect(typeof v?.message).toBe("string");
    expect((v?.message ?? "").length).toBeGreaterThan(0);
  });
});

// ── Parse-time KIND palette (S1/S2 — the frozen schema owns the kind gate) ────
//
// Parse-time enforces the KIND palette: an out-of-palette kind (`code`, or the
// curation-only `message`/`thread`) is rejected by `DraftBoardSchema`. It does
// NOT screen code bytes inside a *legal* prose element — that is the
// `no-code-bytes` lint rule's lane (P6: the earlier claim that R17 is enforced
// at parse time overclaimed; the parse gate only bars the illegal kinds).
describe("parse-time KIND palette (S1/S2)", () => {
  it("rejects an out-of-palette `code` element kind with ZodError-shaped issues", () => {
    const result = parseDraft({ elements: [{ id: "x", kind: "code", data: { author } }] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]).toHaveProperty("path");
  });

  it("rejects a `message` element kind (S1 — curation-only, never a drafter's)", () => {
    const result = parseDraft({
      elements: [{ id: "m", kind: "message", data: { author, role: "question" } }],
    });
    expect(result.ok).toBe(false);
  });

  it("does NOT reject code bytes in a legal prose element — that is the lint rule's lane (P6)", () => {
    const result = parseDraft({
      elements: [
        { id: "p", kind: "prose", data: { author, markdown: "```ts\nconst x = 1;\n```" } },
      ],
    });
    expect(result.ok).toBe(true); // parse accepts it; `no-code-bytes` lint fires on it
  });
});

// ── L1 no-code-bytes (R17/R26) + R20 backtick exemption ──────────────────────

describe("no-code-bytes (L1 / R17 / R20 exemption)", () => {
  it("fires on a fenced code block in prose", () => {
    const bad = board([el("p", "prose", { markdown: "See:\n```ts\nconst x = 1;\n```" })], {
      skippedHunks: [],
    });
    expect(rulesHit(lint(bad, ctx()))).toContain("no-code-bytes");
  });

  it("fires on an indented code block", () => {
    const bad = board([el("p", "prose", { markdown: "    const x = 1;\n    const y = 2;" })], {
      skippedHunks: [],
    });
    expect(rulesHit(lint(bad, ctx()))).toContain("no-code-bytes");
  });

  it("exempts single-backtick inline identifiers (R20)", () => {
    const ok = board([el("p", "prose", { markdown: "The `refreshToken` guard runs first." })], {
      skippedHunks: [],
    });
    expect(rulesHit(lint(ok, ctx()))).not.toContain("no-code-bytes");
  });
});

// ── L2 no-dialogue ───────────────────────────────────────────────────────────

describe("no-dialogue (L2 / R17)", () => {
  it("fires on two-turn authored dialogue", () => {
    const bad = board(
      [el("p", "prose", { markdown: "Reviewer: is this safe?\nAgent: yes, the guard covers it." })],
      { skippedHunks: [] },
    );
    expect(rulesHit(lint(bad, ctx()))).toContain("no-dialogue");
  });

  it("does not fire on a lone `Note:` label", () => {
    const ok = board([el("p", "prose", { markdown: "Note: the guard covers the refresh path." })], {
      skippedHunks: [],
    });
    expect(rulesHit(lint(ok, ctx()))).not.toContain("no-dialogue");
  });
});

// ── L3 citation-well-formed + L4 citation-resolves ───────────────────────────

describe("citations (L3 well-formed / L4 resolves)", () => {
  it("L3 fires on an absolute path citation", () => {
    const bad = board([el("p", "prose", { markdown: "See /src/auth.ts:11 for the guard." })], {
      skippedHunks: [],
    });
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-well-formed");
  });

  it("L3 fires on a bare-basename citation", () => {
    const bad = board([el("p", "prose", { markdown: "See auth.ts:11 for the guard." })], {
      skippedHunks: [],
    });
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-well-formed");
  });

  it("L4 fires when a prose citation names a file that does not resolve", () => {
    const bad = board([el("p", "prose", { markdown: "See src/ghost.ts:11 for the guard." })], {
      skippedHunks: [],
    });
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-resolves");
  });

  it("L4 fires when a prose citation overruns the file", () => {
    const bad = board([el("p", "prose", { markdown: "See src/util.ts:9000 there." })], {
      skippedHunks: [],
    });
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-resolves");
  });

  it("L4 fires on an unresolvable typed code_ref", () => {
    const bad = board([codeRef("c", "src/ghost.ts", 1, 2)], { skippedHunks: [] });
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-resolves");
  });

  it("passes a resolvable repo-relative citation", () => {
    const ok = board([el("p", "prose", { markdown: "See src/auth.ts:11 for the guard." })], {
      skippedHunks: [],
    });
    const hit = rulesHit(lint(ok, ctx()));
    expect(hit).not.toContain("citation-well-formed");
    expect(hit).not.toContain("citation-resolves");
  });
});

// ── L7 process-vocabulary (R20) + F2/F3 exemptions ───────────────────────────

describe("process-vocabulary (L7 / R20 / F2 / F3)", () => {
  it("fires when a section title names the machinery", () => {
    const bad = board(
      [el("s", "section", { title: "What the lens agents drafted", children: [] })],
      {
        skippedHunks: [],
      },
    );
    expect(rulesHit(lint(bad, ctx()))).toContain("process-vocabulary");
  });

  it("exempts a backticked identifier (F2 exemption 1)", () => {
    const ok = board([el("s", "section", { title: "The `LensBoard` projection", children: [] })], {
      skippedHunks: [],
    });
    expect(rulesHit(lint(ok, ctx()))).not.toContain("process-vocabulary");
  });

  it("exempts an identifier the patchset itself defines (F2 exemption 2)", () => {
    const bad = board([el("s", "section", { title: "The lens registry", children: [] })], {
      skippedHunks: [],
    });
    // Without the allowlist it fires; with `lens` in the change's vocabulary it does not.
    expect(rulesHit(lint(bad, ctx()))).toContain("process-vocabulary");
    const exempt = ctx({ patchsetIdentifiers: new Set(["lens"]) });
    expect(rulesHit(lint(bad, exempt))).not.toContain("process-vocabulary");
  });

  it("does not screen body prose — only structural fields (§5)", () => {
    const ok = board(
      [
        el("f1", "finding", {
          severity: "low",
          concern: "The draft agents disagree on the seat, but the board stays coherent.",
          code: ["c1"],
          concurrence: [],
          status: "open",
        }),
        codeRef("c1", "src/auth.ts", 11, 12),
      ],
      {
        skippedHunks: [
          { hunk: "h2", reason: "mechanical rename owned by Noise, specifically the util move." },
        ],
      },
    );
    expect(rulesHit(lint(ok, ctx()))).not.toContain("process-vocabulary");
  });
});

// ── L9 no-remainder-narration ────────────────────────────────────────────────

describe("no-remainder-narration (L9 / R18)", () => {
  it("fires on remainder narration", () => {
    const bad = board(
      [el("p", "prose", { markdown: "The rest of the diff is covered elsewhere." })],
      {
        skippedHunks: [],
      },
    );
    expect(rulesHit(lint(bad, ctx()))).toContain("no-remainder-narration");
  });
});

// ── L10 scaffold-is-noise-lane (R22) ─────────────────────────────────────────

describe("scaffold-is-noise-lane (L10 / R22)", () => {
  it("fires when a non-Noise board cites a scaffold path", () => {
    const bad = board([codeRef("c", "packages/x/openspec/change.md", 1, 1)], { skippedHunks: [] });
    const scoped = ctx({ files: new Map([["packages/x/openspec/change.md", 10]]) });
    expect(rulesHit(lint(bad, scoped))).toContain("scaffold-is-noise-lane");
  });

  it("does not fire on the Noise board", () => {
    const noiseBoard = board([codeRef("c", "packages/x/openspec/change.md", 1, 1)], {
      skippedHunks: [],
    });
    const scoped = ctx({
      lens: "noise" as LensKind,
      files: new Map([["packages/x/openspec/change.md", 10]]),
    });
    expect(rulesHit(lint(noiseBoard, scoped))).not.toContain("scaffold-is-noise-lane");
  });

  it("ships a sane default scaffold glob set", () => {
    expect(DEFAULT_SCAFFOLD_GLOBS.length).toBeGreaterThan(0);
  });
});

// ── skippedHunks rules (S3-as-lint / L11 / L14 / L15) ────────────────────────

describe("skippedHunks rules (S3 / L11 / L14 / L15)", () => {
  it("skipped-hunks-present fires when the board omits the array", () => {
    const bad = board([el("p", "prose", { markdown: "A design note." })]); // no skippedHunks
    expect(rulesHit(lint(bad, ctx()))).toContain("skipped-hunks-present");
  });

  it("skip-reason-specific fires on a boilerplate reason", () => {
    const bad = board([el("p", "prose", { markdown: "note" })], {
      skippedHunks: [{ hunk: "h2", reason: "other lens" }],
    });
    expect(rulesHit(lint(bad, ctx()))).toContain("skip-reason-specific");
  });

  it("skipped-hunks-resolve fires when a skipped hunk is not in the patchset", () => {
    const bad = board([el("p", "prose", { markdown: "note" })], {
      skippedHunks: [
        { hunk: "ghost-hunk", reason: "The migration is boilerplate for the Noise board." },
      ],
    });
    expect(rulesHit(lint(bad, ctx()))).toContain("skipped-hunks-resolve");
  });

  it("no-taught-and-skipped fires when a hunk is both cited and skipped", () => {
    const bad = board([codeRef("c", "src/auth.ts", 11, 12)], {
      skippedHunks: [{ hunk: "h1", reason: "The auth change is trivial, owned by Noise here." }],
    });
    // c cites src/auth.ts:11-12, which overlaps h1 (newStart 10, 5 lines) → taught AND skipped.
    expect(rulesHit(lint(bad, ctx()))).toContain("no-taught-and-skipped");
  });
});

// ── L17 report-coherent (round_outcome, the report seat) ─────────────────────

describe("report-coherent (L17 / R57 — the report seat, S1)", () => {
  const outcome = (id: string, status: string, ask: { ref: string; text: string }, note: string) =>
    el(id, "round_outcome", { status, ask, note });
  // The report is its OWN lint target, not a lens board (S1) — kindAllowlist
  // admits round_outcome only here. Every ask carries a non-empty `ref` because
  // the frozen `askRefSchema.ref` is `.min(1)`; a `beyond` item is distinguished
  // by its `note`, not by an (impossible) empty ref.
  const reportCtx = ctx({ lens: "report" });

  it("a schema-valid round report (with `beyond`) passes lint end to end", () => {
    const ok = board([
      outcome("o1", "addressed", { ref: "a1", text: "fix auth" }, "Done, verified in the diff."),
      outcome(
        "o2",
        "beyond",
        { ref: "beyond:token-path", text: "hardened token path" },
        "Added a guard the asks did not request.",
      ),
    ]);
    expect(lint(ok, reportCtx)).toEqual([]);
  });

  it("fires when round items are out of sort order", () => {
    const bad = board([
      outcome("o1", "beyond", { ref: "beyond:tok", text: "x" }, "Hardened the token path."),
      outcome("o2", "addressed", { ref: "a1", text: "fix auth" }, "Done."),
    ]);
    expect(rulesHit(lint(bad, reportCtx))).toContain("report-coherent");
  });

  it("fires when a `beyond` item carries no accounting note", () => {
    const bad = board([outcome("o1", "beyond", { ref: "beyond:tok", text: "x" }, "  ")]);
    expect(rulesHit(lint(bad, reportCtx))).toContain("report-coherent");
  });

  it("passes well-sorted, status-coherent items", () => {
    const ok = board([
      outcome("o1", "addressed", { ref: "a1", text: "fix auth" }, "Done."),
      outcome(
        "o2",
        "beyond",
        { ref: "beyond:refresh", text: "refresh path" },
        "Also hardened the refresh path.",
      ),
    ]);
    expect(rulesHit(lint(ok, reportCtx))).not.toContain("report-coherent");
  });
});

// ── L13 requirement-verbatim (degrades without the source) ───────────────────

describe("requirement-verbatim (L13 / anti-paraphrase)", () => {
  const reqBoard = (shall: string) =>
    board([el("r", "requirement", { shall, coverage: "met", trace: [] })], { skippedHunks: [] });

  it("fires when the shall text is not a verbatim substring of the source", () => {
    const scoped = ctx({
      lens: "design" as LensKind,
      artifactText: "The system SHALL refresh the token before classifying an error.",
    });
    expect(rulesHit(lint(reqBoard("The system SHALL rotate tokens hourly"), scoped))).toContain(
      "requirement-verbatim",
    );
  });

  it("passes verbatim (whitespace-normalized) shall text", () => {
    const scoped = ctx({
      lens: "design" as LensKind,
      artifactText: "The system SHALL refresh the token before classifying an error.",
    });
    expect(rulesHit(lint(reqBoard("The system SHALL refresh the token"), scoped))).not.toContain(
      "requirement-verbatim",
    );
  });

  it("degrades to no-op when the caller supplies no artifact text", () => {
    const scoped = ctx({ lens: "design" as LensKind });
    expect(rulesHit(lint(reqBoard("anything at all"), scoped))).not.toContain(
      "requirement-verbatim",
    );
  });
});

// ── kind-allowlist (S1 residue at lint scope) ────────────────────────────────

describe("kind-allowlist (per-lens kinds)", () => {
  it("fires when a typed kind appears on the wrong lens board", () => {
    // A `finding` on the Noise board — findings belong to Flagged.
    const bad = board(
      [
        el("f", "finding", {
          severity: "low",
          concern: "x",
          code: [],
          concurrence: [],
          status: "open",
        }),
      ],
      {
        skippedHunks: [],
      },
    );
    const scoped = ctx({ lens: "noise" as LensKind });
    expect(rulesHit(lint(bad, scoped))).toContain("kind-allowlist");
  });

  it("fires when the report seat's round_outcome appears on a lens board", () => {
    const bad = board(
      [el("o", "round_outcome", { status: "addressed", ask: { ref: "a", text: "t" }, note: "n" })],
      {
        skippedHunks: [],
      },
    );
    expect(rulesHit(lint(bad, ctx()))).toContain("kind-allowlist");
  });

  it("allows shared structural kinds on every lens", () => {
    const ok = board(
      [el("p", "prose", { markdown: "A design note." }), codeRef("c", "src/auth.ts", 11, 12)],
      {
        skippedHunks: [
          { hunk: "h2", reason: "The util rename is owned by the Noise board specifically." },
        ],
      },
    );
    const scoped = ctx({ lens: "design" as LensKind });
    expect(rulesHit(lint(ok, scoped))).not.toContain("kind-allowlist");
  });

  // Spec-P1: the Design prompt renders BOTH requirement regions AND the
  // implementer's stated `decision` calls, so both are legal typed kinds there.
  it("admits both `decision` and `requirement` on the Design board (Spec-P1)", () => {
    const ok = board(
      [
        el("d", "decision", {
          statement: "Injected the clock instead of reading it module-level.",
          why: "Testability.",
          evidence: ["c1"],
          alternatives: ["A module-level `Date.now`."],
        }),
        el("r", "requirement", {
          shall: "The system SHALL refresh first",
          coverage: "met",
          trace: ["c1"],
        }),
        codeRef("c1", "src/auth.ts", 11, 12),
      ],
      { skippedHunks: [] },
    );
    const scoped = ctx({ lens: "design" as LensKind });
    expect(rulesHit(lint(ok, scoped))).not.toContain("kind-allowlist");
  });

  it("rejects a `requirement` on the Decisions board (requirement is Design's, S1)", () => {
    const bad = board([el("r", "requirement", { shall: "x", coverage: "gap", trace: [] })], {
      skippedHunks: [],
    });
    const scoped = ctx({ lens: "decisions" as LensKind });
    expect(rulesHit(lint(bad, scoped))).toContain("kind-allowlist");
  });
});

// ── S3/S8 — GitHub #L citations + inverted ranges ────────────────────────────

describe("citation range + form (S3 / S8)", () => {
  it("citation-well-formed fires on a GitHub `#L` citation (colon-less form)", () => {
    const bad = board([el("p", "prose", { markdown: "See src/auth.ts#L11 for the guard." })], {
      skippedHunks: [],
    });
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-well-formed");
  });

  it("citation-resolves fires on an inverted prose range (999-1)", () => {
    const bad = board([el("p", "prose", { markdown: "See src/auth.ts:999-1 there." })], {
      skippedHunks: [],
    });
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-resolves");
  });

  it("citation-resolves fires on an inverted typed code_ref span", () => {
    const bad = board(
      [
        el("c", "code_ref", {
          patchset_id: "ps-1",
          path: "src/auth.ts",
          side: "head",
          start_line: 20,
          end_line: 5,
        }),
      ],
      { skippedHunks: [] },
    );
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-resolves");
  });
});

// ── S2 — patchset identity + side-specific inventories ───────────────────────

describe("citation identity (S2 — patchset id + side)", () => {
  it("fires when a code_ref cites a different patchset than the board's", () => {
    const bad = board(
      [
        el("c", "code_ref", {
          patchset_id: "other-ps",
          path: "src/auth.ts",
          side: "head",
          start_line: 11,
          end_line: 12,
        }),
      ],
      { skippedHunks: [] },
    );
    const scoped = ctx({ patchsetId: "ps-1" });
    expect(rulesHit(lint(bad, scoped))).toContain("citation-resolves");
  });

  it("resolves a base-side ref against the BASE inventory, not head", () => {
    // The file exists at 200 lines on head but only 8 on base; a base-side ref to
    // line 40 overruns base though it fits head — checking the head inventory
    // would wrongly pass it.
    const bad = board(
      [
        el("c", "code_ref", {
          patchset_id: "ps-1",
          path: "src/auth.ts",
          side: "base",
          start_line: 40,
          end_line: 40,
        }),
      ],
      { skippedHunks: [] },
    );
    const scoped = ctx({ patchsetId: "ps-1", baseFiles: new Map([["src/auth.ts", 8]]) });
    expect(rulesHit(lint(bad, scoped))).toContain("citation-resolves");
  });

  it("passes a base-side ref that fits the base inventory", () => {
    const ok = board(
      [
        el("c", "code_ref", {
          patchset_id: "ps-1",
          path: "src/auth.ts",
          side: "base",
          start_line: 3,
          end_line: 5,
        }),
      ],
      { skippedHunks: [] },
    );
    const scoped = ctx({ patchsetId: "ps-1", baseFiles: new Map([["src/auth.ts", 8]]) });
    expect(rulesHit(lint(ok, scoped))).not.toContain("citation-resolves");
  });
});

// ── L12 (P2) — noise_verdict.hunk element reference resolves ──────────────────

describe("noise_verdict.hunk resolves (L12 / P2)", () => {
  const noiseCtx = ctx({ lens: "noise" as LensKind });

  it("fires when a noise verdict's `hunk` references no element on the board", () => {
    const bad = board(
      [
        el("n", "noise_verdict", {
          hunk: "ghost",
          verdict: "noise",
          reason: "Lockfile churn from the dep bump.",
          judge: "llm",
        }),
      ],
      { skippedHunks: [] },
    );
    expect(rulesHit(lint(bad, noiseCtx))).toContain("citation-resolves");
  });

  it("fires when a noise verdict's `hunk` references a non-code_ref element", () => {
    const bad = board(
      [
        el("n", "noise_verdict", {
          hunk: "p",
          verdict: "noise",
          reason: "Lockfile churn from the dep bump.",
          judge: "llm",
        }),
        el("p", "prose", { markdown: "not a code ref" }),
      ],
      { skippedHunks: [] },
    );
    expect(rulesHit(lint(bad, noiseCtx))).toContain("citation-resolves");
  });

  it("passes when a noise verdict's `hunk` points at a real code_ref", () => {
    const ok = board(
      [
        el("n", "noise_verdict", {
          hunk: "c1",
          verdict: "noise",
          reason: "Lockfile churn from the dep bump.",
          judge: "llm",
        }),
        codeRef("c1", "src/util.ts", 1, 3),
      ],
      { skippedHunks: [] },
    );
    expect(rulesHit(lint(ok, noiseCtx))).not.toContain("citation-resolves");
  });
});

// ── S6 (P4) — decision grounding ─────────────────────────────────────────────

describe("decision-grounded (S6 / P4)", () => {
  const designCtx = ctx({ lens: "design" as LensKind });
  const decision = (over: Record<string, unknown>) =>
    board(
      [
        el("d", "decision", {
          statement: "Injected the clock.",
          why: "Testability.",
          evidence: ["c1"],
          alternatives: ["A module-level `Date.now`."],
          ...over,
        }),
        codeRef("c1", "src/auth.ts", 11, 12),
      ],
      { skippedHunks: [] },
    );

  it("fires when a decision has no evidence anchors", () => {
    expect(rulesHit(lint(decision({ evidence: [] }), designCtx))).toContain("decision-grounded");
  });

  it("fires when a decision names no alternative", () => {
    expect(rulesHit(lint(decision({ alternatives: [] }), designCtx))).toContain(
      "decision-grounded",
    );
  });

  it("passes a decision that cites evidence and names an alternative", () => {
    expect(rulesHit(lint(decision({}), designCtx))).not.toContain("decision-grounded");
  });
});

// ── L16 (P5) — requirement order follows the source artifact ──────────────────

describe("requirement-order (L16 / P5)", () => {
  const source =
    "R1: The system SHALL authenticate the user. R2: The system SHALL refresh the token.";
  const req = (id: string, shall: string) =>
    el(id, "requirement", { shall, coverage: "met", trace: [] });

  it("fires when requirements are rendered out of the artifact's order", () => {
    const bad = board(
      [
        req("r1", "The system SHALL refresh the token"),
        req("r2", "The system SHALL authenticate the user"),
      ],
      { skippedHunks: [] },
    );
    const scoped = ctx({ lens: "design" as LensKind, artifactText: source });
    expect(rulesHit(lint(bad, scoped))).toContain("requirement-order");
  });

  it("passes requirements rendered in the artifact's order", () => {
    const ok = board(
      [
        req("r1", "The system SHALL authenticate the user"),
        req("r2", "The system SHALL refresh the token"),
      ],
      { skippedHunks: [] },
    );
    const scoped = ctx({ lens: "design" as LensKind, artifactText: source });
    expect(rulesHit(lint(ok, scoped))).not.toContain("requirement-order");
  });

  it("degrades to a no-op without the source artifact", () => {
    const bad = board(
      [
        req("r1", "The system SHALL refresh the token"),
        req("r2", "The system SHALL authenticate the user"),
      ],
      { skippedHunks: [] },
    );
    expect(rulesHit(lint(bad, ctx({ lens: "design" as LensKind })))).not.toContain(
      "requirement-order",
    );
  });
});

// ── P3 — the review-draft register entry point (review-draft-voice.md) ────────

describe("lintReviewDraft (P3 — living-review register: L3/L4/L7)", () => {
  const files = new Map([["src/auth.ts", 200]]);

  it("L3 fires on a bare-basename citation in the draft", () => {
    const hit = rulesHit(lintReviewDraft("I checked auth.ts:11 and it holds.", { files }));
    expect(hit).toContain("citation-well-formed");
  });

  it("L4 fires on an unresolvable citation in the draft", () => {
    const hit = rulesHit(lintReviewDraft("See src/ghost.ts:11 for the fix.", { files }));
    expect(hit).toContain("citation-resolves");
  });

  it("L7 fires when the draft names the pipeline's machinery", () => {
    const hit = rulesHit(lintReviewDraft("The lens agents flagged the token path.", { files }));
    expect(hit).toContain("process-vocabulary");
  });

  it("L7 does NOT fire on the reviewer speaking of their own review", () => {
    const hit = rulesHit(
      lintReviewDraft("In this review I focus on the refresh path at src/auth.ts:11.", { files }),
    );
    expect(hit).not.toContain("process-vocabulary");
  });

  it("passes a clean, well-cited review draft", () => {
    expect(lintReviewDraft("The refresh guard at src/auth.ts:11 is correct.", { files })).toEqual(
      [],
    );
  });
});

// ── S4 — root-level scaffold paths (glob `**/` matches zero dirs) ─────────────

describe("scaffold glob root-level (S4)", () => {
  it("fires on a root-level openspec path (no leading directory)", () => {
    const bad = board([codeRef("c", "openspec/changes/x/proposal.md", 1, 1)], { skippedHunks: [] });
    const scoped = ctx({ files: new Map([["openspec/changes/x/proposal.md", 10]]) });
    expect(rulesHit(lint(bad, scoped))).toContain("scaffold-is-noise-lane");
  });

  it("fires on a root-level lockfile and `.openspec.yaml`", () => {
    const lock = board([codeRef("c", "pnpm-lock.yaml", 1, 1)], { skippedHunks: [] });
    const lockCtx = ctx({ files: new Map([["pnpm-lock.yaml", 9000]]) });
    expect(rulesHit(lint(lock, lockCtx))).toContain("scaffold-is-noise-lane");

    const stamp = board([codeRef("c", ".openspec.yaml", 1, 1)], { skippedHunks: [] });
    const stampCtx = ctx({ files: new Map([[".openspec.yaml", 5]]) });
    expect(rulesHit(lint(stamp, stampCtx))).toContain("scaffold-is-noise-lane");
  });
});
