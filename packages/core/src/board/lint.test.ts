import type { DraftBoard, DraftElement, LensKind } from "@rennet/protocol";
import { parseDraft } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  type ChangedRegion,
  DEFAULT_SCAFFOLD_GLOBS,
  type LintContext,
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

const REGIONS: ChangedRegion[] = [
  { path: "src/auth.ts", side: "head", start: 10, end: 14 },
  { path: "src/util.ts", side: "head", start: 1, end: 3 },
];

const ctx = (over: Partial<LintContext> = {}): LintContext => ({
  lens: "flagged",
  regions: REGIONS,
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
    over,
  );

const rulesHit = (violations: { ruleId: string }[]) => new Set(violations.map((v) => v.ruleId));

// ── The clean control ────────────────────────────────────────────────────────

describe("lint — the clean control", () => {
  it("a well-formed board raises zero violations", () => {
    expect(lint(cleanBoard(), ctx())).toEqual([]);
  });

  it("a Violation carries ruleId + elementRef + message", () => {
    const bad = board([el("p1", "prose", { markdown: "```ts\nconst x = 1;\n```" })]);
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
    const bad = board([el("p", "prose", { markdown: "See:\n```ts\nconst x = 1;\n```" })]);
    expect(rulesHit(lint(bad, ctx()))).toContain("no-code-bytes");
  });

  it("fires on an indented code block", () => {
    const bad = board([el("p", "prose", { markdown: "    const x = 1;\n    const y = 2;" })]);
    expect(rulesHit(lint(bad, ctx()))).toContain("no-code-bytes");
  });

  it("exempts single-backtick inline identifiers (R20)", () => {
    const ok = board([el("p", "prose", { markdown: "The `refreshToken` guard runs first." })]);
    expect(rulesHit(lint(ok, ctx()))).not.toContain("no-code-bytes");
  });
});

// ── L2 no-dialogue ───────────────────────────────────────────────────────────

describe("no-dialogue (L2 / R17)", () => {
  it("fires on two-turn authored dialogue", () => {
    const bad = board([
      el("p", "prose", { markdown: "Reviewer: is this safe?\nAgent: yes, the guard covers it." }),
    ]);
    expect(rulesHit(lint(bad, ctx()))).toContain("no-dialogue");
  });

  it("does not fire on a lone `Note:` label", () => {
    const ok = board([el("p", "prose", { markdown: "Note: the guard covers the refresh path." })]);
    expect(rulesHit(lint(ok, ctx()))).not.toContain("no-dialogue");
  });
});

// ── L3 citation-well-formed + L4 citation-resolves ───────────────────────────

describe("citations (L3 well-formed / L4 resolves)", () => {
  it("L3 fires on an absolute path citation", () => {
    const bad = board([el("p", "prose", { markdown: "See /src/auth.ts:11 for the guard." })]);
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-well-formed");
  });

  it("L3 fires on a bare-basename citation", () => {
    const bad = board([el("p", "prose", { markdown: "See auth.ts:11 for the guard." })]);
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-well-formed");
  });

  it("L4 fires when a prose citation names a file that does not resolve", () => {
    const bad = board([el("p", "prose", { markdown: "See src/ghost.ts:11 for the guard." })]);
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-resolves");
  });

  it("L4 fires when a prose citation overruns the file", () => {
    const bad = board([el("p", "prose", { markdown: "See src/util.ts:9000 there." })]);
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-resolves");
  });

  it("L4 fires on an unresolvable typed code_ref", () => {
    const bad = board([codeRef("c", "src/ghost.ts", 1, 2)]);
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-resolves");
  });

  it("passes a resolvable repo-relative citation", () => {
    const ok = board([el("p", "prose", { markdown: "See src/auth.ts:11 for the guard." })]);
    const hit = rulesHit(lint(ok, ctx()));
    expect(hit).not.toContain("citation-well-formed");
    expect(hit).not.toContain("citation-resolves");
  });
});

// ── L7 process-vocabulary (R20) + F2/F3 exemptions ───────────────────────────

describe("process-vocabulary (L7 / R20 / F2 / F3)", () => {
  it("fires when a section title names the machinery", () => {
    const bad = board([
      el("s", "section", { title: "What the lens agents drafted", children: [] }),
    ]);
    expect(rulesHit(lint(bad, ctx()))).toContain("process-vocabulary");
  });

  it("exempts a backticked identifier (F2 exemption 1)", () => {
    const ok = board([el("s", "section", { title: "The `LensBoard` projection", children: [] })]);
    expect(rulesHit(lint(ok, ctx()))).not.toContain("process-vocabulary");
  });

  it("exempts an identifier the patchset itself defines (F2 exemption 2)", () => {
    const bad = board([el("s", "section", { title: "The lens registry", children: [] })]);
    // Without the allowlist it fires; with `lens` in the change's vocabulary it does not.
    expect(rulesHit(lint(bad, ctx()))).toContain("process-vocabulary");
    const exempt = ctx({ patchsetIdentifiers: new Set(["lens"]) });
    expect(rulesHit(lint(bad, exempt))).not.toContain("process-vocabulary");
  });

  it("does not screen body prose — only structural fields (§5)", () => {
    const ok = board([
      el("f1", "finding", {
        severity: "low",
        concern: "The draft agents disagree on the seat, but the board stays coherent.",
        code: ["c1"],
        concurrence: [],
        status: "open",
      }),
      codeRef("c1", "src/auth.ts", 11, 12),
    ]);
    expect(rulesHit(lint(ok, ctx()))).not.toContain("process-vocabulary");
  });
});

// ── L9 no-remainder-narration ────────────────────────────────────────────────

describe("no-remainder-narration (L9 / R18)", () => {
  it("fires on remainder narration", () => {
    const bad = board([
      el("p", "prose", { markdown: "The rest of the diff is covered elsewhere." }),
    ]);
    expect(rulesHit(lint(bad, ctx()))).toContain("no-remainder-narration");
  });
});

// ── L10 scaffold-is-noise-lane (R22) ─────────────────────────────────────────

describe("scaffold-is-noise-lane (L10 / R22)", () => {
  it("fires when a non-Noise board cites a scaffold path", () => {
    const bad = board([codeRef("c", "openspec/changes/auth/.openspec.yaml", 1, 1)]);
    const scoped = ctx({ files: new Map([["openspec/changes/auth/.openspec.yaml", 10]]) });
    expect(rulesHit(lint(bad, scoped))).toContain("scaffold-is-noise-lane");
  });

  it("does not fire on the Noise board", () => {
    const noiseBoard = board([codeRef("c", "openspec/changes/auth/.openspec.yaml", 1, 1)]);
    const scoped = ctx({
      lens: "noise" as LensKind,
      files: new Map([["openspec/changes/auth/.openspec.yaml", 10]]),
    });
    expect(rulesHit(lint(noiseBoard, scoped))).not.toContain("scaffold-is-noise-lane");
  });

  it("does not misclassify an OpenSpec source artifact as generated scaffold", () => {
    const path = "openspec/changes/auth/specs/session/spec.md";
    const design = board([codeRef("c", path, 1, 1)]);
    const scoped = ctx({ lens: "design", files: new Map([[path, 10]]) });

    expect(rulesHit(lint(design, scoped))).not.toContain("scaffold-is-noise-lane");
  });

  it("ships a sane default scaffold glob set", () => {
    expect(DEFAULT_SCAFFOLD_GLOBS.length).toBeGreaterThan(0);
  });
});

// ── unresolvable-citation (D5 — every code_ref overlaps a changed region on its side) ──

describe("unresolvable-citation (D5)", () => {
  it("control: a citation entirely outside the change reddens, naming the nearest changed range", () => {
    // src/auth.ts changed on 10..14; a head-side citation of 40..41 overlaps nothing.
    const bad = board([codeRef("c", "src/auth.ts", 40, 41)]);
    const hit = lint(bad, ctx()).filter((v) => v.ruleId === "unresolvable-citation");
    expect(hit.map((v) => v.elementRef)).toEqual(["c"]);
    expect(hit[0]?.message).toContain("src/auth.ts:40-41");
    expect(hit[0]?.message).toContain("src/auth.ts:10-14");
  });

  it("resolves only when EVERY cited line is inside a region — the reader's own test", () => {
    const hit = (start: number, end: number) =>
      rulesHit(lint(board([codeRef("c", "src/auth.ts", start, end)]), ctx()));
    // src/auth.ts changed on 10..14: its exact first line, its exact last line, and the
    // whole region resolve.
    expect(hit(10, 10)).not.toContain("unresolvable-citation");
    expect(hit(14, 14)).not.toContain("unresolvable-citation");
    expect(hit(10, 14)).not.toContain("unresolvable-citation");
    // One line past either end overlaps the region and still fails: `patchset.readSpan`
    // serves the capture line by line and would refuse line 15 (or 9), so lint says so first.
    expect(hit(13, 15)).toContain("unresolvable-citation");
    expect(hit(9, 10)).toContain("unresolvable-citation");
  });

  it("two regions: a citation spanning the gap between them fails; adjacent regions read as one", () => {
    const split = ctx({
      regions: [
        { path: "src/auth.ts", side: "head", start: 10, end: 14 },
        { path: "src/auth.ts", side: "head", start: 20, end: 24 },
        { path: "src/util.ts", side: "head", start: 1, end: 3 },
        { path: "src/util.ts", side: "head", start: 4, end: 6 },
      ],
    });
    // 12..22 touches both auth regions and the uncaptured 15..19 between them.
    expect(rulesHit(lint(board([codeRef("c", "src/auth.ts", 12, 22)]), split))).toContain(
      "unresolvable-citation",
    );
    // 2..5 crosses two util regions that meet with no gap: every line is captured.
    expect(rulesHit(lint(board([codeRef("c", "src/util.ts", 2, 5)]), split))).not.toContain(
      "unresolvable-citation",
    );
  });

  it("resolves on the cited SIDE: a base-side citation never resolves against head regions", () => {
    const base = el("c", "code_ref", {
      patchset_id: "ps-1",
      path: "src/auth.ts",
      side: "base",
      start_line: 11,
      end_line: 12,
    });
    const hit = lint(board([base]), ctx({ baseFiles: new Map([["src/auth.ts", 200]]) })).filter(
      (v) => v.ruleId === "unresolvable-citation",
    );
    expect(hit.map((v) => v.elementRef)).toEqual(["c"]);
    expect(hit[0]?.message).toContain("no changed lines on the base side");
    const withBase = ctx({
      baseFiles: new Map([["src/auth.ts", 200]]),
      regions: [...REGIONS, { path: "src/auth.ts", side: "base", start: 11, end: 12 }],
    });
    expect(rulesHit(lint(board([base]), withBase))).not.toContain("unresolvable-citation");
  });

  it("leaves an inverted or overrunning citation to citation-resolves (no double report)", () => {
    const inverted = board([codeRef("c", "src/auth.ts", 12, 11)]);
    const hit = rulesHit(lint(inverted, ctx()));
    expect(hit).toContain("citation-resolves");
    expect(hit).not.toContain("unresolvable-citation");
    // 300..301 on a 200-line file is outside every region AND past the end of the file.
    // One pointer — the overrun — not two telling the seat two different things.
    const overrun = lint(board([codeRef("c", "src/auth.ts", 300, 301)]), ctx());
    expect(overrun.filter((v) => v.ruleId === "citation-resolves")).toHaveLength(1);
    expect(overrun.filter((v) => v.ruleId === "unresolvable-citation")).toEqual([]);
    // Control: the same overrun on the BASE side is judged against the base inventory.
    const baseOverrun = el("c", "code_ref", {
      patchset_id: "ps-1",
      path: "src/auth.ts",
      side: "base",
      start_line: 300,
      end_line: 301,
    });
    const baseHits = lint(
      board([baseOverrun]),
      ctx({ baseFiles: new Map([["src/auth.ts", 200]]) }),
    );
    expect(baseHits.map((v) => v.ruleId).filter((r) => r.includes("citation"))).toEqual([
      "citation-resolves",
    ]);
  });

  it("an EMPTY region list is a change with no lines to cite (an absent one is a type error)", () => {
    const cited = board([codeRef("c", "src/auth.ts", 40, 41)]);
    expect(rulesHit(lint(cited, ctx({ regions: [] })))).toContain("unresolvable-citation");
  });

  it("does not apply to the round-report seat, which cites the round's own diff", () => {
    const report = board([codeRef("c", "src/auth.ts", 40, 41)]);
    expect(rulesHit(lint(report, ctx({ lens: "report" })))).not.toContain("unresolvable-citation");
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
    board([el("r", "requirement", { shall, coverage: "met", trace: [] })]);

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

  it("checks a requirement only against the exact source artifact it names", () => {
    const bad = board([
      el("r", "requirement", {
        shall: "The system SHALL refresh the token",
        source: { path: "specs/session.md" },
      }),
    ]);
    const scoped = ctx({
      lens: "design" as LensKind,
      artifacts: [
        { path: "specs/auth.md", text: "The system SHALL refresh the token." },
        { path: "specs/session.md", text: "The system SHALL preserve the session." },
      ],
    });

    expect(rulesHit(lint(bad, scoped))).toContain("requirement-verbatim");
  });

  it("passes source-indexed verbatim text from the named artifact", () => {
    const ok = board([
      el("r", "requirement", {
        shall: "The system SHALL preserve the session",
        source: { path: "specs/session.md" },
      }),
    ]);
    const scoped = ctx({
      lens: "design" as LensKind,
      artifacts: [
        { path: "specs/auth.md", text: "The system SHALL refresh the token." },
        { path: "specs/session.md", text: "The system SHALL preserve the session." },
      ],
    });

    expect(rulesHit(lint(ok, scoped))).not.toContain("requirement-verbatim");
  });

  it("rejects a requirement whose source path is not in the discovered artifact set", () => {
    const bad = board([
      el("r", "requirement", {
        shall: "The system SHALL preserve the session",
        source: { path: "specs/typo.md" },
      }),
    ]);
    const scoped = ctx({
      lens: "design" as LensKind,
      artifacts: [{ path: "specs/session.md", text: "The system SHALL preserve the session." }],
    });

    expect(rulesHit(lint(bad, scoped))).toContain("requirement-source-known");
  });

  it("rejects a sourceless requirement when discovery supplied exact artifacts", () => {
    const bad = board([el("r", "requirement", { shall: "The system SHALL preserve the session" })]);
    const scoped = ctx({
      lens: "design" as LensKind,
      artifacts: [{ path: "specs/session.md", text: "The system SHALL preserve the session." }],
    });

    expect(rulesHit(lint(bad, scoped))).toContain("requirement-source-known");
  });

  it("rejects a paraphrased scenario even when the SHALL text is verbatim", () => {
    const bad = board([
      el("r", "requirement", {
        shall: "The system SHALL preserve the session",
        scenarios: ["scenario"],
        source: { path: "specs/session.md" },
      }),
      el("scenario", "prose", { markdown: "WHEN it expires THEN refresh everything." }),
    ]);
    const scoped = ctx({
      lens: "design" as LensKind,
      artifacts: [
        {
          path: "specs/session.md",
          text: "The system SHALL preserve the session. WHEN the token expires THEN refresh the session.",
        },
      ],
    });

    const violations = lint(bad, scoped).filter(
      (violation) => violation.ruleId === "requirement-verbatim",
    );
    expect(violations).toEqual([expect.objectContaining({ elementRef: "scenario/markdown" })]);
  });

  it("accepts a verbatim scenario anchored through its requirement", () => {
    const scenario = "WHEN the token expires THEN refresh the session.";
    const ok = board([
      el("r", "requirement", {
        shall: "The system SHALL preserve the session",
        scenarios: ["scenario"],
        source: { path: "specs/session.md" },
      }),
      el("scenario", "prose", { markdown: scenario }),
    ]);
    const scoped = ctx({
      lens: "design" as LensKind,
      artifacts: [
        {
          path: "specs/session.md",
          text: `The system SHALL preserve the session. ${scenario}`,
        },
      ],
    });

    expect(rulesHit(lint(ok, scoped))).not.toContain("requirement-verbatim");
  });

  it("rejects a requirement scenario ref that resolves to a non-narrative element", () => {
    const bad = board([
      el("r", "requirement", {
        shall: "The system SHALL preserve the session",
        scenarios: ["not-a-scenario"],
        source: { path: "specs/session.md" },
      }),
      codeRef("not-a-scenario", "src/auth.ts", 10, 11),
    ]);
    const scoped = ctx({
      lens: "design",
      artifacts: [{ path: "specs/session.md", text: "The system SHALL preserve the session." }],
    });

    expect(rulesHit(lint(bad, scoped))).toContain("requirement-scenario-narrative");
  });
});

describe("Design source navigation grounding", () => {
  const artifacts = [{ path: "specs/session.md", text: "The system SHALL preserve it." }];
  const scoped = ctx({
    lens: "design",
    artifacts,
    files: new Map([
      ["specs/session.md", 10],
      ["src/session.ts", 100],
    ]),
  });

  it("rejects invented document/section source chips and related files", () => {
    const bad = board(
      [
        el("section", "section", {
          title: "Session",
          children: ["requirement"],
          sources: [{ path: "specs/invented.md" }],
        }),
        el("requirement", "requirement", {
          shall: "The system SHALL preserve it.",
          source: { path: "specs/session.md" },
          related_files: ["src/invented.ts"],
        }),
      ],
      {
        document: {
          title: "Session",
          introMarkdown: "Why it changes.",
          measure: "structured",
          sources: [{ path: "specs/invented.md" }],
        },
      },
    );

    const hit = rulesHit(lint(bad, scoped));
    expect(hit).toContain("design-source-known");
    expect(hit).toContain("design-related-file-known");
  });

  it("accepts source chips and related files that resolve in the reviewed repository", () => {
    const ok = board(
      [
        el("section", "section", {
          title: "Session",
          children: ["requirement"],
          sources: [{ path: "specs/session.md" }],
        }),
        el("requirement", "requirement", {
          shall: "The system SHALL preserve it.",
          source: { path: "specs/session.md" },
          related_files: ["src/session.ts"],
        }),
      ],
      {
        document: {
          title: "Session",
          introMarkdown: "Why it changes.",
          measure: "structured",
          sources: [{ path: "specs/session.md" }],
        },
      },
    );

    const hit = rulesHit(lint(ok, scoped));
    expect(hit).not.toContain("design-source-known");
    expect(hit).not.toContain("design-related-file-known");
  });

  it("rejects source-chip lines outside the reviewed artifact", () => {
    const bad = board(
      [
        el("section", "section", {
          title: "Session",
          children: ["requirement"],
          sources: [{ path: "specs/session.md", line: 11 }],
        }),
        el("requirement", "requirement", {
          shall: "The system SHALL preserve it.",
          source: { path: "specs/session.md", line: 11 },
        }),
      ],
      {
        document: {
          title: "Session",
          introMarkdown: "Why it changes.",
          measure: "structured",
          sources: [{ path: "specs/session.md", line: 11 }],
        },
      },
    );

    expect(
      lint(bad, scoped).filter((violation) => violation.ruleId === "design-source-line-known"),
    ).toHaveLength(3);
  });

  it("accepts the last reviewed line for document, section, and requirement sources", () => {
    const ok = board(
      [
        el("section", "section", {
          title: "Session",
          children: ["requirement"],
          sources: [{ path: "specs/session.md", line: 10 }],
        }),
        el("requirement", "requirement", {
          shall: "The system SHALL preserve it.",
          source: { path: "specs/session.md", line: 10 },
        }),
      ],
      {
        document: {
          title: "Session",
          introMarkdown: "Why it changes.",
          measure: "structured",
          sources: [{ path: "specs/session.md", line: 10 }],
        },
      },
    );

    expect(rulesHit(lint(ok, scoped))).not.toContain("design-source-line-known");
  });

  it("grounds source lines from discovered text when the whole-tree inventory is unavailable", () => {
    const artifactOnly = ctx({
      lens: "design",
      artifacts: [
        {
          path: "specs/session.md",
          text: "Session\nThe system SHALL preserve it.",
        },
      ],
      files: new Map(),
    });
    const ok = board(
      [
        el("section", "section", {
          title: "Session",
          children: ["requirement"],
          sources: [{ path: "specs/session.md", line: 2 }],
        }),
        el("requirement", "requirement", {
          shall: "The system SHALL preserve it.",
          source: { path: "specs/session.md", line: 2 },
        }),
      ],
      {
        document: {
          title: "Session",
          introMarkdown: "Why it changes.",
          measure: "structured",
          sources: [{ path: "specs/session.md", line: 2 }],
        },
      },
    );

    expect(rulesHit(lint(ok, artifactOnly))).not.toContain("design-source-line-known");
  });

  it("requires every strongly relevant artifact in the header and a named section", () => {
    const proposal = "specs/proposal.md";
    const design = "specs/design.md";
    const incomplete = board(
      [
        el("proposal", "section", {
          title: "Proposal",
          children: [],
          sources: [{ path: proposal }],
        }),
      ],
      {
        document: {
          title: "Session",
          introMarkdown: "Why it changes.",
          measure: "structured",
          sources: [{ path: proposal }],
        },
      },
    );
    const complete = board(
      [
        el("proposal", "section", {
          title: "Proposal",
          children: [],
          sources: [{ path: proposal }],
        }),
        el("design", "section", {
          title: "Design",
          children: [],
          sources: [{ path: design }],
        }),
      ],
      {
        document: {
          title: "Session",
          introMarkdown: "Why it changes.",
          measure: "structured",
          sources: [{ path: proposal }, { path: design }],
        },
      },
    );
    const completeCtx = ctx({
      lens: "design",
      artifacts: [
        { path: proposal, text: "Why" },
        { path: design, text: "How" },
      ],
      artifactCandidates: [{ id: "candidate-1", paths: [proposal, design] }],
      files: new Map([
        [proposal, 10],
        [design, 10],
      ]),
    });

    expect(rulesHit(lint(incomplete, completeCtx))).toContain("design-artifact-set-complete");
    expect(rulesHit(lint(complete, completeCtx))).not.toContain("design-artifact-set-complete");
  });

  it("does not force a same-path-reference decoy candidate into the selected design", () => {
    const targetProposal = "specs/target/proposal.md";
    const targetDesign = "specs/target/design.md";
    const decoyProposal = "specs/decoy/proposal.md";
    const decoyDesign = "specs/decoy/design.md";
    const selected = board(
      [
        el("proposal", "section", {
          title: "Proposal",
          children: [],
          sources: [{ path: targetProposal, candidate: "candidate-target" }],
        }),
        el("design", "section", {
          title: "Design",
          children: [],
          sources: [{ path: targetDesign, candidate: "candidate-target" }],
        }),
      ],
      {
        document: {
          title: "Target",
          introMarkdown: "Why it changes.",
          measure: "structured",
          sources: [
            { path: targetProposal, candidate: "candidate-target" },
            { path: targetDesign, candidate: "candidate-target" },
          ],
        },
      },
    );
    const decoyCtx = ctx({
      lens: "design",
      artifacts: [
        { path: targetProposal, text: "Target proposal mentions src/auth.ts" },
        { path: targetDesign, text: "Target design mentions src/auth.ts" },
        { path: decoyProposal, text: "Old proposal also mentions src/auth.ts" },
        { path: decoyDesign, text: "Old design also mentions src/auth.ts" },
      ],
      artifactCandidates: [
        { id: "candidate-target", paths: [targetProposal, targetDesign] },
        { id: "candidate-decoy", paths: [decoyProposal, decoyDesign] },
      ],
      files: new Map([
        [targetProposal, 1],
        [targetDesign, 1],
        [decoyProposal, 1],
        [decoyDesign, 1],
      ]),
    });

    expect(rulesHit(lint(selected, decoyCtx))).not.toContain("design-artifact-set-complete");
  });

  it("rejects source-bearing typed elements from another candidate", () => {
    const targetPath = "specs/target/design.md";
    const decoyPath = "specs/decoy/design.md";
    const selected = board(
      [
        el("target-design", "section", {
          title: "Target design",
          children: ["decoy-decision"],
          sources: [{ path: targetPath, candidate: "candidate-target" }],
        }),
        el("decoy-decision", "decision", {
          statement: "Use the decoy store",
          why: "The decoy already owns writes.",
          alternatives: [],
          evidence: [],
          inferred: false,
          source: { path: decoyPath, candidate: "candidate-decoy", line: 3 },
        }),
      ],
      {
        document: {
          title: "Target",
          introMarkdown: "Keep the target design isolated.",
          measure: "structured",
          sources: [{ path: targetPath, candidate: "candidate-target" }],
        },
      },
    );
    const scoped = ctx({
      lens: "design",
      artifacts: [
        {
          candidate: "candidate-target",
          format: "openspec",
          role: "design",
          path: targetPath,
          text: "# Target design",
        },
        {
          candidate: "candidate-decoy",
          format: "openspec",
          role: "design",
          path: decoyPath,
          text: ["## Decisions", "### Use the decoy store", "The decoy already owns writes."].join(
            "\n",
          ),
        },
      ],
      artifactCandidates: [
        { id: "candidate-target", paths: [targetPath] },
        { id: "candidate-decoy", paths: [decoyPath] },
      ],
      files: new Map([
        [targetPath, 1],
        [decoyPath, 3],
      ]),
    });

    const violations = lint(selected, scoped);
    expect(rulesHit(violations)).not.toContain("design-source-candidate-known");
    expect(
      violations.filter(
        ({ ruleId, message }) =>
          ruleId === "design-artifact-set-complete" &&
          message.includes(`Rendered artifact \`${decoyPath}\``),
      ),
    ).toEqual([expect.objectContaining({ elementRef: "/document/sources" })]);
  });

  it("keeps partial-overlap candidates separate by their stable identity", () => {
    const shared = "specs/shared.md";
    const targetOnly = "plans/target.md";
    const decoyOnly = "plans/decoy.md";
    const selected = board(
      [
        el("shared", "section", {
          title: "Shared design",
          children: [],
          sources: [{ path: shared, candidate: "candidate-target" }],
        }),
        el("target", "section", {
          title: "Target plan",
          children: [],
          sources: [{ path: targetOnly, candidate: "candidate-target" }],
        }),
      ],
      {
        document: {
          title: "Target",
          introMarkdown: "Why it changes.",
          measure: "structured",
          sources: [
            { path: shared, candidate: "candidate-target" },
            { path: targetOnly, candidate: "candidate-target" },
          ],
        },
      },
    );
    const overlapCtx = ctx({
      lens: "design",
      artifacts: [
        { path: shared, text: "Shared architecture" },
        { path: targetOnly, text: "Target plan" },
        { path: decoyOnly, text: "Unrelated plan" },
      ],
      artifactCandidates: [
        { id: "candidate-target", paths: [shared, targetOnly] },
        { id: "candidate-decoy", paths: [shared, decoyOnly] },
      ],
      files: new Map([
        [shared, 1],
        [targetOnly, 1],
        [decoyOnly, 1],
      ]),
    });

    const hit = rulesHit(lint(selected, overlapCtx));
    expect(hit).not.toContain("design-source-candidate-known");
    expect(hit).not.toContain("design-artifact-set-complete");
  });

  it("rejects an unqualified source when discovery returned overlapping candidates", () => {
    const shared = "specs/shared.md";
    const ambiguous = board(
      [
        el("shared", "section", {
          title: "Shared design",
          children: [],
          sources: [{ path: shared }],
        }),
      ],
      {
        document: {
          title: "Ambiguous",
          introMarkdown: "Why it changes.",
          measure: "structured",
          sources: [{ path: shared }],
        },
      },
    );
    const overlapCtx = ctx({
      lens: "design",
      artifacts: [{ path: shared, text: "Shared architecture" }],
      artifactCandidates: [
        { id: "candidate-target", paths: [shared, "plans/target.md"] },
        { id: "candidate-decoy", paths: [shared, "plans/decoy.md"] },
      ],
      files: new Map([[shared, 1]]),
    });

    expect(rulesHit(lint(ambiguous, overlapCtx))).toContain("design-source-candidate-known");
  });

  it("requires the candidate id even when discovery returned one candidate", () => {
    const path = "specs/session.md";
    const unqualified = board(
      [
        el("session", "section", {
          title: "Session",
          children: ["session-copy"],
          sources: [{ path }],
        }),
        el("session-copy", "prose", { markdown: "Session specification." }),
      ],
      {
        document: {
          title: "Session",
          introMarkdown: "Session specification.",
          measure: "structured",
          sources: [{ path, candidate: "only" }],
        },
      },
    );
    const scoped = ctx({
      lens: "design",
      artifacts: [{ candidate: "only", path, text: "Session specification." }],
      artifactCandidates: [{ id: "only", paths: [path] }],
      files: new Map([[path, 1]]),
    });

    expect(rulesHit(lint(unqualified, scoped))).toContain("design-source-candidate-known");
  });

  describe("reverse completeness and derived anatomy", () => {
    const candidate = "openspec-session";
    const path = "openspec/changes/session/specs/session/spec.md";
    const tasksPath = "openspec/changes/session/tasks.md";
    const text = [
      "## ADDED Requirements",
      "",
      "### Requirement: Preserve the session",
      "",
      "The system SHALL preserve the session.",
      "",
      "#### Scenario: Refresh an expired session",
      "- **WHEN** the token expires",
      "- **THEN** refresh the session",
      "",
      "### Requirement: Recover after restart",
      "",
      "The system SHALL recover the session after restart.",
      "",
      "#### Scenario: Reopen the application",
      "- **WHEN** the application restarts",
      "- **THEN** restore the session",
    ].join("\n");
    const tasksText = [
      "# Tasks",
      "",
      "## 1. Delivery",
      "- [x] Persist the session",
      "- [ ] Prove restart recovery",
    ].join("\n");
    const source = { path, candidate };
    const requirementOneSource = { ...source, line: 3 };
    const requirementTwoSource = { ...source, line: 11 };
    const tasksSource = { path: tasksPath, candidate };
    const scenarioOne =
      "Scenario: Refresh an expired session - **WHEN** the token expires - **THEN** refresh the session";
    const scenarioTwo =
      "Scenario: Reopen the application - **WHEN** the application restarts - **THEN** restore the session";
    const completeDesign = (): DraftBoard =>
      board(
        [
          el("source", "section", {
            title: "Session specification",
            children: ["capability"],
            sources: [source],
          }),
          el("capability", "section", {
            title: "Session",
            children: ["added-operation"],
            spec_delta: "added",
          }),
          el("added-operation", "section", {
            title: "ADDED Requirements",
            children: ["requirement-1", "requirement-2"],
            spec_delta: "added",
          }),
          el("requirement-1", "requirement", {
            shall: "The system SHALL preserve the session.",
            capability: "session",
            spec_delta: "added",
            scenarios: ["scenario-1"],
            source: requirementOneSource,
          }),
          el("scenario-1", "prose", { markdown: scenarioOne }),
          el("requirement-2", "requirement", {
            shall: "The system SHALL recover the session after restart.",
            capability: "session",
            spec_delta: "added",
            scenarios: ["scenario-2"],
            source: requirementTwoSource,
          }),
          el("scenario-2", "prose", { markdown: scenarioTwo }),
          el("tasks", "section", {
            title: "Tasks",
            children: ["task-group"],
            sources: [tasksSource],
          }),
          el("task-group", "section", {
            title: "1. Delivery",
            children: ["task-1", "task-2"],
          }),
          el("task-1", "prose", { markdown: "- [x] Persist the session" }),
          el("task-2", "prose", { markdown: "- [ ] Prove restart recovery" }),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "Keep sessions across restarts.",
            measure: "structured",
            sources: [source, tasksSource],
            stats: [
              { label: "Format", value: "OpenSpec" },
              { label: "Requirements", value: "2" },
              { label: "Capabilities", value: "1 new / 0 modified" },
              { label: "Tasks", value: "1/2" },
            ],
          },
        },
      );
    const completeCtx = (over: Partial<LintContext> = {}): LintContext =>
      ctx({
        lens: "design",
        regions: [],
        artifacts: [
          { candidate, format: "openspec", path, role: "spec-delta", text },
          { candidate, format: "openspec", path: tasksPath, role: "tasks", text: tasksText },
        ],
        artifactCandidates: [
          {
            id: candidate,
            name: "Session",
            format: "openspec",
            paths: [path, tasksPath],
            relevance: "changed-artifact",
          },
        ],
        files: new Map([
          [path, text.split("\n").length],
          [tasksPath, tasksText.split("\n").length],
        ]),
        ...over,
      });
    const reverseRules = new Set([
      "design-artifact-content-complete",
      "design-artifact-content-hierarchy",
      "design-artifact-content-order",
      "design-artifact-anatomy",
      "design-header-complete",
      "design-incompleteness-visible",
      "requirement-scenario-parenting",
    ]);

    it("accepts an exact, source-ordered requirement, scenario, and task projection", () => {
      const violations = lint(completeDesign(), completeCtx()).filter((violation) =>
        reverseRules.has(violation.ruleId),
      );

      expect(violations).toEqual([]);
    });

    it("binds each typed source anchor to the obligation line and delta group", () => {
      const wrong = completeDesign();
      wrong.elements = wrong.elements.map((element) => {
        if (element.id === "requirement-1") {
          return el("requirement-1", "requirement", {
            ...element.data,
            source: { ...requirementOneSource, line: 4 },
          });
        }
        if (element.id === "requirement-2") {
          return el("requirement-2", "requirement", {
            ...element.data,
            capability: "restart",
            spec_delta: "modified",
          });
        }
        if (element.id === "added-operation") {
          return el("added-operation", "section", {
            ...element.data,
            spec_delta: "modified",
          });
        }
        return element;
      });

      const violations = lint(wrong, completeCtx());
      expect(
        violations.some(
          ({ ruleId, message }) =>
            ruleId === "design-artifact-content-complete" && message.includes("line 3"),
        ),
      ).toBe(true);
      expect(
        violations.some(
          ({ ruleId, message }) =>
            ruleId === "design-artifact-content-hierarchy" &&
            message.includes("requirements:added"),
        ),
      ).toBe(true);
      expect(
        violations.some(
          ({ ruleId, message }) =>
            ruleId === "design-artifact-content-hierarchy" &&
            message.includes("capability `session`"),
        ),
      ).toBe(true);
    });

    it("keeps OpenSpec requirement labels and group and capability titles source-exact", () => {
      const labelled = completeDesign();
      labelled.elements = labelled.elements.map((element) =>
        element.id === "requirement-1"
          ? el("requirement-1", "requirement", {
              ...element.data,
              name: "Preserve the session",
            })
          : element,
      );
      expect(
        lint(labelled, completeCtx()).filter(
          (violation) => violation.ruleId === "design-artifact-content-hierarchy",
        ),
      ).toEqual([]);

      for (const [id, field, value] of [
        ["requirement-1", "name", "Invented label"],
        ["added-operation", "title", "Changed Requirements"],
        ["capability", "title", "Billing"],
        ["task-group", "title", "Delivery"],
      ] as const) {
        const mutated = structuredClone(labelled);
        mutated.elements = mutated.elements.map((element) =>
          element.id === id ? el(id, element.kind, { ...element.data, [field]: value }) : element,
        );
        expect(
          lint(mutated, completeCtx()).filter(
            (violation) => violation.ruleId === "design-artifact-content-hierarchy",
          ),
        ).not.toEqual([]);
      }
    });

    it("rejects source obligations rendered out of total source order", () => {
      const reordered = completeDesign();
      reordered.elements = reordered.elements.map((element) =>
        element.id === "added-operation"
          ? el("added-operation", "section", {
              ...element.data,
              children: ["requirement-2", "requirement-1"],
            })
          : element,
      );

      expect(rulesHit(lint(reordered, completeCtx()))).toContain("design-artifact-content-order");
    });

    it("rejects invented requirement, scenario, decision, and task anchors", () => {
      const invented = completeDesign();
      invented.elements = invented.elements.map((element) => {
        if (element.id === "added-operation") {
          return el("added-operation", "section", {
            ...element.data,
            children: [...(element.data.children as string[]), "invented-requirement"],
          });
        }
        if (element.id === "tasks") {
          return el("tasks", "section", {
            ...element.data,
            children: [...(element.data.children as string[]), "invented-decision"],
          });
        }
        if (element.id === "task-group") {
          return el("task-group", "section", {
            ...element.data,
            children: [...(element.data.children as string[]), "invented-task"],
          });
        }
        return element;
      });
      invented.elements.push(
        el("invented-requirement", "requirement", {
          shall: "The system SHALL invent a requirement.",
          capability: "session",
          spec_delta: "added",
          scenarios: ["invented-scenario"],
          source: requirementOneSource,
        }),
        el("invented-scenario", "prose", {
          markdown: "Scenario: Invent behavior - **WHEN** asked - **THEN** invent it",
        }),
        el("invented-decision", "decision", {
          statement: "Invent a decision",
          why: "It was not stated.",
          evidence: [],
          alternatives: [],
          inferred: false,
          source: { ...tasksSource, line: 1 },
        }),
        el("invented-task", "prose", { markdown: "- [ ] Invent another task" }),
      );

      const extras = lint(invented, completeCtx()).filter(
        ({ ruleId, message }) =>
          ruleId === "design-artifact-content-complete" && message.includes("not present in"),
      );
      expect(extras.map(({ message }) => message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("requirement"),
          expect.stringContaining("scenario"),
          expect.stringContaining("decision"),
          expect.stringContaining("task"),
        ]),
      );
    });

    it("rejects unmatched checkboxes anywhere in a Tasks artifact", () => {
      const exact = completeDesign();
      const taskExtras = (draft: DraftBoard) =>
        lint(draft, completeCtx()).filter(
          ({ ruleId, message }) =>
            ruleId === "design-artifact-content-complete" && message.includes("Rendered task"),
        );
      expect(taskExtras(exact)).toEqual([]);

      const invented = structuredClone(exact);
      invented.elements = [
        ...invented.elements.map((element) =>
          element.id === "tasks"
            ? el("tasks", "section", {
                ...element.data,
                children: [
                  ...(element.data as { children: readonly string[] }).children,
                  "invented-task-group",
                ],
              })
            : element,
        ),
        el("invented-task-group", "section", {
          title: "2. Invented delivery",
          children: ["invented-task-step"],
        }),
        el("invented-task-step", "prose", {
          markdown: "- [ ] 2.1 Invent another task",
        }),
      ];

      expect(taskExtras(invented)).toEqual([
        expect.objectContaining({ elementRef: "invented-task-step" }),
      ]);
    });

    it("keeps a non-task Design checklist legible without inventing task semantics", () => {
      const designPath = "docs/superpowers/specs/2026-08-29-session-design.md";
      const designSource = { path: designPath, candidate };
      const designText = [
        "# Session design",
        "",
        "- [ ] Revisit the storage alternative after launch.",
      ].join("\n");
      const projected = board(
        [
          el("design", "section", {
            title: "Session design",
            children: ["follow-up"],
            sources: [designSource],
          }),
          el("follow-up", "prose", {
            markdown: "- [ ] Revisit the storage alternative after launch.",
          }),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "The design records a follow-up question.",
            measure: "structured",
            sources: [designSource],
            stats: [
              { label: "Requirements", value: "0" },
              { label: "Capabilities", value: "0 new / 0 modified" },
            ],
          },
        },
      );

      expect(
        lint(
          projected,
          completeCtx({
            artifacts: [
              {
                candidate,
                format: "superpowers",
                path: designPath,
                role: "design",
                text: designText,
              },
            ],
            artifactCandidates: [
              { id: candidate, paths: [designPath], relevance: "changed-artifact" },
            ],
            files: new Map([[designPath, designText.split("\n").length]]),
          }),
        ).filter(
          ({ ruleId, message }) =>
            ruleId === "design-artifact-content-complete" && message.includes("Rendered task"),
        ),
      ).toEqual([]);
    });

    it("limits invented-task checks to parser-recognized task groups", () => {
      const planPath = "docs/superpowers/plans/2026-08-29-session.md";
      const planSource = { path: planPath, candidate };
      const planText = [
        "# Session Implementation Plan",
        "",
        "## Global Constraints",
        "- [ ] Revisit the rollout window after launch.",
        "",
        "### Task 1: Persist sessions",
        "- [ ] **Step 1: Write persistence**",
      ].join("\n");
      const exact = board(
        [
          el("plan", "section", {
            title: "Session Implementation Plan",
            children: ["constraints", "task-1"],
            sources: [planSource],
          }),
          el("constraints", "section", {
            title: "Global Constraints",
            children: ["constraint-check"],
          }),
          el("constraint-check", "prose", {
            markdown: "- [ ] Revisit the rollout window after launch.",
          }),
          el("task-1", "section", {
            title: "Task 1: Persist sessions",
            children: ["task-step"],
          }),
          el("task-step", "prose", { markdown: "- [ ] **Step 1: Write persistence**" }),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "Persist sessions.",
            measure: "structured",
            sources: [planSource],
            stats: [
              { label: "Format", value: "Superpowers" },
              { label: "Requirements", value: "0" },
              { label: "Capabilities", value: "0 new / 0 modified" },
              { label: "Tasks", value: "0/1" },
            ],
          },
        },
      );
      const scoped = completeCtx({
        artifacts: [
          { candidate, format: "superpowers", path: planPath, role: "plan", text: planText },
        ],
        artifactCandidates: [
          {
            id: candidate,
            name: "Session",
            format: "superpowers",
            paths: [planPath],
            relevance: "changed-artifact",
          },
        ],
        files: new Map([[planPath, planText.split("\n").length]]),
      });

      expect(
        lint(exact, scoped).filter(
          ({ ruleId, message }) =>
            ruleId === "design-artifact-content-complete" && message.includes("Rendered task"),
        ),
      ).toEqual([]);

      const invented = structuredClone(exact);
      invented.elements = invented.elements.map((element) =>
        element.id === "task-1"
          ? el("task-1", "section", {
              ...element.data,
              children: [
                ...(element.data as { children: string[] }).children,
                "invented-task-step",
              ],
            })
          : element,
      );
      invented.elements.push(
        el("invented-task-step", "prose", { markdown: "- [ ] Invent another task step" }),
      );
      expect(
        lint(invented, scoped).filter(
          ({ ruleId, message }) =>
            ruleId === "design-artifact-content-complete" && message.includes("Rendered task"),
        ),
      ).toEqual([expect.objectContaining({ elementRef: "invented-task-step" })]);

      const inventedGroup = structuredClone(exact);
      inventedGroup.elements = [
        ...inventedGroup.elements.map((element) =>
          element.id === "plan"
            ? el("plan", "section", {
                ...element.data,
                children: [
                  ...(element.data as { children: readonly string[] }).children,
                  "invented-task-group",
                ],
              })
            : element,
        ),
        el("invented-task-group", "section", {
          title: "Task 2: Invent work",
          children: ["invented-group-step"],
        }),
        el("invented-group-step", "prose", {
          markdown: "- [ ] **Step 1: Do invented work**",
        }),
      ];
      expect(
        lint(inventedGroup, scoped).filter(
          ({ ruleId, message }) =>
            ruleId === "design-artifact-content-complete" && message.includes("Rendered task"),
        ),
      ).toEqual([expect.objectContaining({ elementRef: "invented-group-step" })]);
    });

    it("requires the exact Format stat and discovered source sequence", () => {
      const missingFormat = completeDesign();
      missingFormat.document = {
        ...missingFormat.document,
        stats: missingFormat.document?.stats?.filter(({ label }) => label !== "Format"),
      } as NonNullable<DraftBoard["document"]>;
      expect(
        lint(missingFormat, completeCtx()).filter(
          (violation) => violation.ruleId === "design-header-complete",
        ),
      ).toEqual([expect.objectContaining({ message: expect.stringContaining("format") })]);

      const swapped = completeDesign();
      swapped.document = {
        ...swapped.document,
        sources: [tasksSource, source],
      } as NonNullable<DraftBoard["document"]>;
      expect(
        lint(swapped, completeCtx()).filter(
          (violation) => violation.ruleId === "design-artifact-set-complete",
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining("exactly once") }),
        ]),
      );

      const duplicated = completeDesign();
      duplicated.document = {
        ...duplicated.document,
        sources: [source, tasksSource, source],
      } as NonNullable<DraftBoard["document"]>;
      expect(
        lint(duplicated, completeCtx()).filter(
          (violation) => violation.ruleId === "design-artifact-set-complete",
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining("exactly once") }),
        ]),
      );

      const regionSwap = completeDesign();
      regionSwap.elements = [
        ...regionSwap.elements.filter((element) => element.id === "tasks"),
        ...regionSwap.elements.filter((element) => element.id !== "tasks"),
      ];
      expect(
        lint(regionSwap, completeCtx()).filter(
          (violation) => violation.ruleId === "design-artifact-set-complete",
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("first source-linked region"),
          }),
        ]),
      );

      const presentationOnlyLabels = completeDesign();
      presentationOnlyLabels.document = {
        ...presentationOnlyLabels.document,
        sources: [
          { ...source, label: "Capability specification" },
          { ...tasksSource, label: "Delivery checklist" },
        ],
      } as NonNullable<DraftBoard["document"]>;
      presentationOnlyLabels.elements = presentationOnlyLabels.elements.map((element) =>
        element.id === "capability"
          ? el("capability", "section", {
              ...element.data,
              sources: [{ ...source, label: "Repeated nested navigation" }],
            })
          : element,
      );
      expect(
        lint(presentationOnlyLabels, completeCtx()).filter(
          (violation) => violation.ruleId === "design-artifact-set-complete",
        ),
      ).toEqual([]);

      const duplicateFormat = completeDesign();
      duplicateFormat.document = {
        ...duplicateFormat.document,
        stats: [...(duplicateFormat.document?.stats ?? []), { label: "Format", value: "OpenSpec" }],
      } as NonNullable<DraftBoard["document"]>;
      expect(
        lint(duplicateFormat, completeCtx()).filter(
          ({ ruleId, message }) =>
            ruleId === "design-header-complete" && message.includes("exactly once"),
        ),
      ).toEqual([expect.objectContaining({ message: expect.stringContaining("format") })]);
    });

    it("requires exact canonical header stat label spelling", () => {
      const lowercaseFormat = completeDesign();
      lowercaseFormat.document = {
        ...lowercaseFormat.document,
        stats: lowercaseFormat.document?.stats?.map((stat) =>
          stat.label === "Format" ? { ...stat, label: "format" } : stat,
        ),
      } as NonNullable<DraftBoard["document"]>;

      expect(
        lint(lowercaseFormat, completeCtx()).filter(
          (violation) => violation.ruleId === "design-header-complete",
        ),
      ).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("exact label `Format`"),
        }),
      ]);
    });

    it("keeps each selected artifact in a distinct first source-linked region", () => {
      expect(
        lint(completeDesign(), completeCtx()).filter(
          (violation) => violation.ruleId === "design-artifact-set-complete",
        ),
      ).toEqual([]);

      const collapsed = completeDesign();
      collapsed.elements = collapsed.elements
        .filter((element) => element.id !== "tasks")
        .map((element) =>
          element.id === "source"
            ? el("source", "section", {
                ...element.data,
                children: ["capability", "task-group"],
                sources: [source, tasksSource],
              })
            : element,
        );

      expect(
        lint(collapsed, completeCtx()).filter(
          ({ ruleId, message }) =>
            ruleId === "design-artifact-set-complete" &&
            message.includes("distinct first named source-linked region"),
        ),
      ).toEqual([expect.objectContaining({ elementRef: "/elements" })]);
    });

    it("requires every first artifact region to be a top-level topology root", () => {
      const nestedTasks = completeDesign();
      nestedTasks.elements = nestedTasks.elements.map((element) =>
        element.id === "source"
          ? el("source", "section", {
              ...element.data,
              children: [...(element.data as { children: readonly string[] }).children, "tasks"],
            })
          : element,
      );

      expect(
        lint(nestedTasks, completeCtx()).filter(
          ({ ruleId, message }) =>
            ruleId === "design-artifact-set-complete" &&
            message.includes("top-level board topology root"),
        ),
      ).toEqual([expect.objectContaining({ elementRef: "tasks" })]);
    });

    it("keeps mixed OpenSpec delta operations under one capability root", () => {
      const mixedText = [
        "## MODIFIED Requirements",
        "",
        "### Requirement: Retain the refreshed session",
        "The daemon SHALL retain the refreshed session.",
        "",
        "## ADDED Requirements",
        "",
        "### Requirement: Report recovery",
        "The daemon SHALL report session recovery.",
      ].join("\n");
      const exact = board(
        [
          el("session-capability", "section", {
            title: "Session",
            children: ["modified-operation", "added-operation"],
            sources: [source],
          }),
          el("modified-operation", "section", {
            title: "MODIFIED Requirements",
            children: ["modified-requirement"],
            spec_delta: "modified",
          }),
          el("modified-requirement", "requirement", {
            shall: "The daemon SHALL retain the refreshed session.",
            capability: "session",
            spec_delta: "modified",
            scenarios: [],
            source: { ...source, line: 3 },
          }),
          el("added-operation", "section", {
            title: "ADDED Requirements",
            children: ["added-requirement"],
            spec_delta: "added",
          }),
          el("added-requirement", "requirement", {
            shall: "The daemon SHALL report session recovery.",
            capability: "session",
            spec_delta: "added",
            scenarios: [],
            source: { ...source, line: 8 },
          }),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "The session capability changes in two ways.",
            measure: "structured",
            sources: [source],
            stats: [
              { label: "Format", value: "OpenSpec" },
              { label: "Requirements", value: "2" },
              { label: "Capabilities", value: "0 new / 1 modified" },
            ],
          },
        },
      );
      const scoped = completeCtx({
        artifacts: [{ candidate, format: "openspec", path, role: "spec-delta", text: mixedText }],
        artifactCandidates: [
          {
            id: candidate,
            name: "Session",
            format: "openspec",
            paths: [path],
            relevance: "changed-artifact",
          },
        ],
        files: new Map([[path, mixedText.split("\n").length]]),
      });

      expect(lint(exact, scoped).filter(({ ruleId }) => ruleId.startsWith("design-"))).toEqual([]);

      const wrongOperation = structuredClone(exact);
      wrongOperation.elements = wrongOperation.elements
        .filter((element) => element.id !== "added-operation")
        .map((element) => {
          if (element.id === "session-capability") {
            return el("session-capability", "section", {
              ...element.data,
              children: ["modified-operation"],
            });
          }
          return element.id === "modified-operation"
            ? el("modified-operation", "section", {
                ...element.data,
                children: ["modified-requirement", "added-requirement"],
              })
            : element;
        });
      expect(
        lint(wrongOperation, scoped).filter(
          ({ ruleId, elementRef }) =>
            ruleId === "design-artifact-content-hierarchy" &&
            elementRef === "modified-operation/spec_delta",
        ),
      ).toEqual([expect.objectContaining({ message: expect.stringContaining("added") })]);

      const splitCapabilitySections = structuredClone(exact);
      splitCapabilitySections.elements = [
        ...splitCapabilitySections.elements.map((element) =>
          element.id === "session-capability"
            ? el("session-capability", "section", {
                ...element.data,
                title: "Session specification",
                children: ["modified-capability", "added-capability"],
              })
            : element,
        ),
        el("modified-capability", "section", {
          title: "Session",
          children: ["modified-operation"],
        }),
        el("added-capability", "section", {
          title: "Session",
          children: ["added-operation"],
        }),
      ];
      expect(
        lint(splitCapabilitySections, scoped).filter(
          ({ ruleId, message }) =>
            ruleId === "design-artifact-content-hierarchy" &&
            message.includes("share one exact capability section"),
        ),
      ).toEqual([expect.objectContaining({ elementRef: "added-capability" })]);

      const scalarMixedRoot = structuredClone(exact);
      scalarMixedRoot.elements = scalarMixedRoot.elements.map((element) =>
        element.id === "session-capability"
          ? el("session-capability", "section", {
              ...element.data,
              spec_delta: "modified",
            })
          : element,
      );
      expect(
        lint(scalarMixedRoot, scoped).filter(
          ({ ruleId, elementRef }) =>
            ruleId === "design-artifact-content-hierarchy" &&
            elementRef === "session-capability/spec_delta",
        ),
      ).toEqual([expect.objectContaining({ message: expect.stringContaining("must omit") })]);

      const splitRoots = structuredClone(exact);
      splitRoots.elements = splitRoots.elements
        .filter((element) => element.id !== "session-capability")
        .map((element) =>
          element.id === "modified-operation" || element.id === "added-operation"
            ? el(element.id, "section", { ...element.data, sources: [source] })
            : element,
        );
      expect(
        lint(splitRoots, scoped).filter(
          ({ ruleId, message }) =>
            ruleId === "design-artifact-set-complete" &&
            message.includes("one named source-linked root"),
        ),
      ).toEqual([expect.objectContaining({ elementRef: "/elements" })]);
    });

    it("requires capability sections to carry their exact source spec delta", () => {
      const missing = completeDesign();
      missing.elements = missing.elements.map((element) => {
        if (element.id !== "added-operation") return element;
        const data = { ...element.data };
        delete data.spec_delta;
        return el("added-operation", "section", data);
      });

      expect(
        lint(missing, completeCtx()).filter(
          ({ ruleId, elementRef }) =>
            ruleId === "design-artifact-content-hierarchy" &&
            elementRef === "added-operation/spec_delta",
        ),
      ).toEqual([expect.objectContaining({ message: expect.stringContaining("added") })]);
    });

    it("rejects spec deltas on sections without a matched source operation", () => {
      const planPath = "docs/superpowers/plans/2026-08-29-session.md";
      const planSource = { path: planPath, candidate };
      const planText = [
        "# Session Implementation Plan",
        "",
        "### Task 1: Persist sessions",
        "- [ ] Write the failing test",
      ].join("\n");
      const inventedPlanDelta = board(
        [
          el("plan", "section", {
            title: "Session Implementation Plan",
            children: ["plan-task"],
            sources: [planSource],
            spec_delta: "added",
          }),
          el("plan-task", "section", {
            title: "Task 1: Persist sessions",
            children: ["plan-step"],
          }),
          el("plan-step", "prose", { markdown: "- [ ] Write the failing test" }),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "Persist sessions.",
            measure: "structured",
            sources: [planSource],
            stats: [
              { label: "Requirements", value: "0" },
              { label: "Tasks", value: "0/1" },
            ],
          },
        },
      );
      const planCtx = completeCtx({
        artifacts: [
          { candidate, format: "superpowers", path: planPath, role: "plan", text: planText },
        ],
        artifactCandidates: [
          { id: candidate, name: "Session", paths: [planPath], relevance: "changed-artifact" },
        ],
        files: new Map([[planPath, planText.split("\n").length]]),
      });

      const unusedOpenSpecDelta = completeDesign();
      unusedOpenSpecDelta.elements = [
        ...unusedOpenSpecDelta.elements.map((element) =>
          element.id === "source"
            ? el("source", "section", {
                ...element.data,
                children: [
                  ...(element.data as { children: readonly string[] }).children,
                  "unused-delta",
                ],
              })
            : element,
        ),
        el("unused-delta", "section", {
          title: "Unused operation",
          children: [],
          spec_delta: "removed",
        }),
      ];

      for (const [draft, context, elementRef] of [
        [inventedPlanDelta, planCtx, "plan/spec_delta"],
        [unusedOpenSpecDelta, completeCtx(), "unused-delta/spec_delta"],
      ] as const) {
        expect(
          lint(draft, context).filter(
            (violation) => violation.ruleId === "design-artifact-content-hierarchy",
          ),
        ).toEqual([expect.objectContaining({ elementRef })]);
      }
    });

    it("owns scenario children only through requirement.scenarios", () => {
      const redundant = completeDesign();
      redundant.elements = redundant.elements.map((element) =>
        element.id === "added-operation"
          ? el("added-operation", "section", {
              ...element.data,
              children: ["requirement-1", "scenario-1", "requirement-2"],
            })
          : element,
      );

      expect(
        lint(redundant, completeCtx()).filter(
          (violation) => violation.ruleId === "requirement-scenario-parenting",
        ),
      ).toEqual([expect.objectContaining({ elementRef: "scenario-1" })]);

      const duplicate = completeDesign();
      duplicate.elements = duplicate.elements.map((element) =>
        element.id === "requirement-1"
          ? el("requirement-1", "requirement", {
              ...element.data,
              scenarios: ["scenario-1", "scenario-1"],
            })
          : element,
      );
      expect(
        lint(duplicate, completeCtx()).filter(
          (violation) => violation.ruleId === "requirement-scenario-parenting",
        ),
      ).toEqual([
        expect.objectContaining({
          elementRef: "requirement-1/scenarios/1",
          message: expect.stringContaining("exactly once"),
        }),
      ]);
    });

    it("derives header counts from source obligations rather than invented board rows", () => {
      const inflated = completeDesign();
      inflated.document = {
        ...inflated.document,
        stats: [
          { label: "Format", value: "OpenSpec" },
          { label: "Requirements", value: "3" },
          { label: "Capabilities", value: "2 new / 0 modified" },
          { label: "Tasks", value: "1/2" },
        ],
      } as NonNullable<DraftBoard["document"]>;

      expect(
        lint(inflated, completeCtx()).filter(
          (violation) => violation.ruleId === "design-header-complete",
        ),
      ).toEqual([
        expect.objectContaining({ message: expect.stringContaining("requirements") }),
        expect.objectContaining({ message: expect.stringContaining("capabilities") }),
      ]);
    });

    it("rejects header stats that no selected artifact can support", () => {
      const invented = completeDesign();
      invented.document = {
        ...invented.document,
        stats: [...(invented.document?.stats ?? []), { label: "Coverage", value: "100%" }],
      } as NonNullable<DraftBoard["document"]>;

      expect(
        lint(invented, completeCtx()).filter(
          (violation) => violation.ruleId === "design-header-complete",
        ),
      ).toEqual([
        expect.objectContaining({ message: expect.stringContaining("unexpected stat `coverage`") }),
      ]);
    });

    it("binds the header title to the selected candidate name", () => {
      const misnamed = completeDesign();
      misnamed.document = {
        ...misnamed.document,
        title: "Billing",
      } as NonNullable<DraftBoard["document"]>;

      expect(
        lint(
          misnamed,
          completeCtx({
            artifactCandidates: [
              {
                id: candidate,
                name: "Session",
                format: "openspec",
                paths: [path, tasksPath],
                relevance: "changed-artifact",
              },
            ],
          }),
        ).filter((violation) => violation.ruleId === "design-header-complete"),
      ).toEqual([
        expect.objectContaining({ message: expect.stringContaining("must be `Session`") }),
      ]);
    });

    it("accepts a fully grounded Kiro requirement capability without invented deltas", () => {
      const kiroPath = ".kiro/specs/session/requirements.md";
      const kiroSource = { path: kiroPath, candidate: "kiro-session" };
      const story = "**User Story:** As a reviewer, I want sessions to survive restarts.";
      const criterionOne =
        "WHEN the application restarts THEN the system SHALL restore the session";
      const criterionTwo =
        "IF the session is expired THEN the system SHALL show the sign-in screen";
      const kiroText = [
        "# Requirements Document",
        "",
        "### Requirement 1",
        "",
        story,
        "",
        "#### Acceptance Criteria",
        "",
        `1. ${criterionOne}`,
        `2. ${criterionTwo}`,
      ].join("\n");
      const projected = board(
        [
          el("kiro-source", "section", {
            title: "session",
            children: ["kiro-requirement"],
            sources: [kiroSource],
          }),
          el("kiro-requirement", "requirement", {
            name: "Requirement 1",
            shall: story,
            capability: "session",
            scenarios: ["kiro-criterion-1", "kiro-criterion-2"],
            source: { ...kiroSource, line: 3 },
          }),
          el("kiro-criterion-1", "prose", { markdown: criterionOne }),
          el("kiro-criterion-2", "prose", { markdown: criterionTwo }),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "Keep sessions across restarts.",
            measure: "structured",
            sources: [kiroSource],
            stats: [
              { label: "Format", value: "Kiro" },
              { label: "Requirements", value: "1" },
            ],
          },
        },
      );

      const violations = lint(
        projected,
        completeCtx({
          artifacts: [
            {
              candidate: "kiro-session",
              format: "kiro",
              path: kiroPath,
              role: "requirements",
              text: kiroText,
            },
          ],
          artifactCandidates: [
            {
              id: "kiro-session",
              name: "Session",
              format: "kiro",
              paths: [kiroPath],
              relevance: "changed-artifact",
            },
          ],
          files: new Map([[kiroPath, kiroText.split("\n").length]]),
        }),
      ).filter(
        (violation) =>
          violation.ruleId.startsWith("design-") || violation.ruleId.startsWith("requirement-"),
      );

      expect(violations).toEqual([]);

      for (const [field, value] of [
        ["capability", "billing"],
        ["name", "A model-invented label"],
        ["spec_delta", "added"],
      ] as const) {
        const mutated = structuredClone(projected);
        mutated.elements = mutated.elements.map((element) =>
          element.id === "kiro-requirement"
            ? el("kiro-requirement", "requirement", { ...element.data, [field]: value })
            : element,
        );
        expect(
          lint(
            mutated,
            completeCtx({
              artifacts: [
                {
                  candidate: "kiro-session",
                  format: "kiro",
                  path: kiroPath,
                  role: "requirements",
                  text: kiroText,
                },
              ],
              artifactCandidates: [
                {
                  id: "kiro-session",
                  name: "Session",
                  format: "kiro",
                  paths: [kiroPath],
                  relevance: "changed-artifact",
                },
              ],
              files: new Map([[kiroPath, kiroText.split("\n").length]]),
            }),
          ).filter((violation) => violation.ruleId === "design-artifact-content-hierarchy"),
        ).not.toEqual([]);
      }
    });

    it("keeps canonical Kiro task requirement references exact and task-owned", () => {
      const tasksPath = ".kiro/specs/session/tasks.md";
      const tasksSource = { path: tasksPath, candidate: "kiro-session" };
      const tasksText = [
        "# Implementation Plan",
        "",
        "- [ ] 1. Set up project structure",
        "  - Define module boundaries",
        "- [ ] 1.1 Create data model interfaces",
        "  - _Requirements: 2.1, 3.3, 1.2_",
        "- [ ] 2. Wire persistence",
        "  - _Requirements: 2.4_",
      ].join("\n");
      const projected = board(
        [
          el("kiro-tasks", "section", {
            title: "Implementation Plan",
            children: ["kiro-group-1", "kiro-group-2"],
            sources: [tasksSource],
          }),
          el("kiro-group-1", "section", {
            title: "1. Set up project structure",
            children: ["kiro-task-1", "kiro-task-1-1"],
          }),
          el("kiro-task-1", "prose", { markdown: "- [ ] 1. Set up project structure" }),
          el("kiro-task-1-1", "prose", {
            markdown: "- [ ] 1.1 Create data model interfaces",
            requirement_refs: ["2.1", "3.3", "1.2"],
          }),
          el("kiro-group-2", "section", {
            title: "2. Wire persistence",
            children: ["kiro-task-2"],
          }),
          el("kiro-task-2", "prose", {
            markdown: "- [ ] 2. Wire persistence",
            requirement_refs: ["2.4"],
          }),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "The exact implementation plan.",
            measure: "structured",
            sources: [tasksSource],
            stats: [
              { label: "Format", value: "Kiro" },
              { label: "Requirements", value: "0" },
              { label: "Tasks", value: "0/3" },
            ],
          },
        },
      );
      const scoped = completeCtx({
        artifacts: [
          {
            candidate: "kiro-session",
            format: "kiro",
            path: tasksPath,
            role: "tasks",
            text: tasksText,
          },
        ],
        artifactCandidates: [
          {
            id: "kiro-session",
            name: "Session",
            format: "kiro",
            paths: [tasksPath],
            relevance: "changed-artifact",
          },
        ],
        files: new Map([[tasksPath, tasksText.split("\n").length]]),
      });
      const exactViolations = (draft: DraftBoard) =>
        lint(draft, scoped).filter(
          (violation) => violation.ruleId === "design-artifact-content-complete",
        );

      expect(exactViolations(projected)).toEqual([]);
      for (const [id, refs] of [
        ["kiro-task-1-1", undefined],
        ["kiro-task-1-1", ["3.3", "2.1", "1.2"]],
        ["kiro-task-1", ["9.9"]],
      ] as const) {
        const mutated = structuredClone(projected);
        mutated.elements = mutated.elements.map((element) => {
          if (element.id !== id) return element;
          const data = { ...element.data };
          delete data.requirement_refs;
          return el(id, element.kind, {
            ...data,
            ...(refs === undefined ? {} : { requirement_refs: refs }),
          });
        });
        expect(exactViolations(mutated)).toEqual([
          expect.objectContaining({ elementRef: expect.stringContaining(id) }),
        ]);
      }
    });

    it("requires each Kiro bugfix behavior section as an exact nested source region", () => {
      const bugfixPath = ".kiro/specs/session/bugfix.md";
      const bugfixSource = { path: bugfixPath, candidate: "kiro-session" };
      const bugfixText = [
        "# Session restart bugfix",
        "",
        "## Current Behavior",
        "A restart drops the active session.",
        "",
        "## Expected Behavior",
        "A restart restores the active session.",
        "",
        "## Unchanged Behavior",
        "Expired sessions still open sign-in.",
      ].join("\n");
      const projected = board(
        [
          el("bugfix", "section", {
            title: "Session restart bugfix",
            children: ["current", "expected", "unchanged"],
            sources: [bugfixSource],
          }),
          el("current", "section", {
            title: "Current Behavior",
            children: ["current-copy"],
          }),
          el("current-copy", "prose", { markdown: "A restart drops the active session." }),
          el("expected", "section", {
            title: "Expected Behavior",
            children: ["expected-copy"],
          }),
          el("expected-copy", "prose", { markdown: "A restart restores the active session." }),
          el("unchanged", "section", {
            title: "Unchanged Behavior",
            children: ["unchanged-copy"],
          }),
          el("unchanged-copy", "prose", {
            markdown: "Expired sessions still open sign-in.",
          }),
        ],
        {
          document: {
            title: "Session restart bugfix",
            introMarkdown: "The exact current, expected, and unchanged behavior.",
            measure: "structured",
            sources: [bugfixSource],
            stats: [{ label: "Requirements", value: "0" }],
          },
        },
      );
      const scoped = completeCtx({
        artifacts: [
          {
            candidate: "kiro-session",
            format: "kiro",
            path: bugfixPath,
            role: "bugfix",
            text: bugfixText,
          },
        ],
        artifactCandidates: [{ id: "kiro-session", paths: [bugfixPath] }],
        files: new Map([[bugfixPath, bugfixText.split("\n").length]]),
      });

      expect(
        lint(projected, scoped).filter((violation) => reverseRules.has(violation.ruleId)),
      ).toEqual([]);

      projected.elements = projected.elements.map((element) =>
        element.id === "expected"
          ? el("expected", "section", {
              ...element.data,
              title: "Current Behavior",
            })
          : element,
      );
      expect(rulesHit(lint(projected, scoped))).toContain("design-artifact-content-hierarchy");
    });

    it("keeps two inline BMAD stories in distinct exact source groups", () => {
      const epicPath = "planning/epic-1.md";
      const epicSource = { path: epicPath, candidate: "bmad-epic" };
      const storyOne = "As a reviewer, I want sessions restored, so that I can resume work.";
      const storyTwo = "As a reviewer, I want expiry handled, so that sign-in stays honest.";
      const epicText = [
        "## Story 1.1 Restore sessions",
        storyOne,
        "",
        "## Story 1.2 Handle expiry",
        storyTwo,
      ].join("\n");
      const projected = board(
        [
          el("epic", "section", {
            title: "Epic 1",
            children: ["story-1-section", "story-2-section"],
            sources: [epicSource],
          }),
          el("story-1-section", "section", {
            title: "Story 1.1 Restore sessions",
            children: ["story-1"],
          }),
          el("story-1", "requirement", {
            name: "Story 1.1 Restore sessions",
            shall: storyOne,
            capability: "story:1.1",
            scenarios: [],
            source: { ...epicSource, line: 1 },
          }),
          el("story-2-section", "section", {
            title: "Story 1.2 Handle expiry",
            children: ["story-2"],
          }),
          el("story-2", "requirement", {
            name: "Story 1.2 Handle expiry",
            shall: storyTwo,
            capability: "story:1.2",
            scenarios: [],
            source: { ...epicSource, line: 4 },
          }),
        ],
        {
          document: {
            title: "Epic 1",
            introMarkdown: "Two source-owned stories.",
            measure: "structured",
            sources: [epicSource],
            stats: [
              { label: "Format", value: "BMAD" },
              { label: "Requirements", value: "2" },
            ],
          },
        },
      );
      const scoped = completeCtx({
        artifacts: [
          {
            candidate: "bmad-epic",
            format: "bmad",
            path: epicPath,
            role: "epic",
            text: epicText,
          },
        ],
        artifactCandidates: [
          {
            id: "bmad-epic",
            name: "Epic 1",
            format: "bmad",
            paths: [epicPath],
            relevance: "changed-artifact",
          },
        ],
        files: new Map([[epicPath, epicText.split("\n").length]]),
      });
      const hierarchy = (draft: DraftBoard) =>
        lint(draft, scoped).filter(
          (violation) => violation.ruleId === "design-artifact-content-hierarchy",
        );

      expect(hierarchy(projected)).toEqual([]);

      const collapsed = structuredClone(projected);
      collapsed.elements = collapsed.elements
        .filter((element) => element.id !== "story-2-section")
        .map((element) =>
          element.id === "story-1-section"
            ? el("story-1-section", "section", {
                ...element.data,
                children: ["story-1", "story-2"],
              })
            : element.id === "epic"
              ? el("epic", "section", {
                  ...element.data,
                  children: ["story-1-section"],
                })
              : element,
        );
      expect(hierarchy(collapsed)).not.toEqual([]);

      const renamed = structuredClone(projected);
      renamed.elements = renamed.elements.map((element) =>
        element.id === "story-2-section"
          ? el("story-2-section", "section", {
              ...element.data,
              title: "Story 1.2 Invented title",
            })
          : element,
      );
      expect(hierarchy(renamed)).toEqual([
        expect.objectContaining({ elementRef: expect.stringContaining("story-2-section") }),
      ]);

      const inventedStatus = structuredClone(projected);
      inventedStatus.elements = inventedStatus.elements.map((element) =>
        element.id === "story-1"
          ? el("story-1", "requirement", { ...element.data, status: "Draft" })
          : element,
      );
      expect(
        lint(inventedStatus, scoped).filter(
          (violation) =>
            violation.ruleId === "design-artifact-content-complete" &&
            violation.elementRef.includes("status"),
        ),
      ).toHaveLength(1);
    });

    it("keeps BMAD story Status and task AC references exact", () => {
      const storyPath = "planning/stories/1.1.restore-sessions.md";
      const storySource = { path: storyPath, candidate: "bmad-story" };
      const statement =
        "**As a** reviewer, **I want** sessions restored, **so that** I can resume work.";
      const storyText = [
        "# Story 1.1: Restore sessions",
        "",
        "## Status",
        "Approved",
        "",
        "## Story",
        statement,
        "",
        "## Tasks / Subtasks",
        "- [ ] Task 1 (AC: 3, 1)",
        "  - [ ] Persist the session (AC: 2)",
        "- [ ] Task 2",
      ].join("\n");
      const projected = board(
        [
          el("story-root", "section", {
            title: "Story 1.1: Restore sessions",
            children: ["story-requirement", "story-notes", "story-tasks"],
            sources: [storySource],
          }),
          el("story-requirement", "requirement", {
            name: "Story 1.1: Restore sessions",
            shall: statement,
            capability: "story:1.1",
            scenarios: [],
            status: "Approved",
            source: { ...storySource, line: 6 },
          }),
          el("story-notes", "section", {
            title: "Notes",
            children: ["story-note-check"],
          }),
          el("story-note-check", "prose", {
            markdown: "- [ ] Revisit rollout timing after launch.",
          }),
          el("story-tasks", "section", {
            title: "Tasks / Subtasks",
            children: ["story-task-1", "story-task-2"],
          }),
          el("story-task-1", "section", {
            title: "Task 1 (AC: 3, 1)",
            children: ["story-task-1-root", "story-task-1-step"],
          }),
          el("story-task-1-root", "prose", {
            markdown: "- [ ] Task 1 (AC: 3, 1)",
            acceptance_criteria: ["3", "1"],
          }),
          el("story-task-1-step", "prose", {
            markdown: "- [ ] Persist the session (AC: 2)",
            acceptance_criteria: ["2"],
          }),
          el("story-task-2", "section", {
            title: "Task 2",
            children: ["story-task-2-root"],
          }),
          el("story-task-2-root", "prose", { markdown: "- [ ] Task 2" }),
        ],
        {
          document: {
            title: "Story 1.1: Restore sessions",
            introMarkdown: "The exact story state and traceability.",
            measure: "structured",
            sources: [storySource],
            stats: [
              { label: "Format", value: "BMAD" },
              { label: "Requirements", value: "1" },
              { label: "Tasks", value: "0/3" },
            ],
          },
        },
      );
      const scoped = completeCtx({
        artifacts: [
          {
            candidate: "bmad-story",
            format: "bmad",
            path: storyPath,
            role: "story",
            text: storyText,
          },
        ],
        artifactCandidates: [
          {
            id: "bmad-story",
            name: "Story 1.1: Restore sessions",
            format: "bmad",
            paths: [storyPath],
            relevance: "changed-artifact",
          },
        ],
        files: new Map([[storyPath, storyText.split("\n").length]]),
      });
      const exact = (draft: DraftBoard) =>
        lint(draft, scoped).filter(
          (violation) => violation.ruleId === "design-artifact-content-complete",
        );

      expect(exact(projected)).toEqual([]);
      const inventedTask = structuredClone(projected);
      inventedTask.elements = [
        ...inventedTask.elements.map((element) =>
          element.id === "story-tasks"
            ? el("story-tasks", "section", {
                ...element.data,
                children: [
                  ...(element.data as { children: readonly string[] }).children,
                  "story-task-invented",
                ],
              })
            : element,
        ),
        el("story-task-invented", "section", {
          title: "Task 99",
          children: ["story-task-invented-step"],
        }),
        el("story-task-invented-step", "prose", {
          markdown: "- [ ] Invent work (AC: 99)",
        }),
      ];
      expect(exact(inventedTask)).toEqual([
        expect.objectContaining({
          elementRef: "story-task-invented-step",
          message: expect.stringContaining("Rendered task"),
        }),
      ]);
      for (const [id, field, value] of [
        ["story-requirement", "status", undefined],
        ["story-requirement", "status", "Done"],
        ["story-task-1-root", "acceptance_criteria", undefined],
        ["story-task-1-root", "acceptance_criteria", ["1", "3"]],
        ["story-task-2-root", "acceptance_criteria", ["9"]],
      ] as const) {
        const mutated = structuredClone(projected);
        mutated.elements = mutated.elements.map((element) => {
          if (element.id !== id) return element;
          const data = Object.fromEntries(
            Object.entries(element.data).filter(([key]) => key !== field),
          );
          return el(id, element.kind, {
            ...data,
            ...(value === undefined ? {} : { [field]: value }),
          });
        });
        expect(exact(mutated)).toEqual([
          expect.objectContaining({ elementRef: expect.stringContaining(field) }),
        ]);
      }
    });

    it("accepts grounded BMAD registry groups without capability or delta header claims", () => {
      const prdPath = "planning/prd.md";
      const prdSource = { path: prdPath, candidate: "bmad-product" };
      const prdText = [
        "# Product",
        "",
        "## Requirements",
        "",
        "### Functional",
        "",
        "1. FR1: The application restores the last session.",
        "",
        "### Non Functional",
        "",
        "1. NFR1: Session restoration completes within 500 ms.",
      ].join("\n");
      const projected = board(
        [
          el("prd", "section", {
            title: "Product requirements",
            children: ["functional", "non-functional"],
            sources: [prdSource],
          }),
          el("functional", "section", {
            title: "Functional",
            children: ["fr1"],
          }),
          el("fr1", "requirement", {
            name: "FR1",
            shall: "The application restores the last session.",
            capability: "functional",
            scenarios: [],
            source: { ...prdSource, line: 7 },
          }),
          el("non-functional", "section", {
            title: "Non Functional",
            children: ["nfr1"],
          }),
          el("nfr1", "requirement", {
            name: "NFR1",
            shall: "Session restoration completes within 500 ms.",
            capability: "non-functional",
            scenarios: [],
            source: { ...prdSource, line: 11 },
          }),
        ],
        {
          document: {
            title: "Product",
            introMarkdown: "The product restores sessions within its performance budget.",
            measure: "structured",
            sources: [prdSource],
            stats: [
              { label: "Format", value: "BMAD" },
              { label: "Requirements", value: "2" },
            ],
          },
        },
      );
      const scoped = completeCtx({
        artifacts: [
          { candidate: "bmad-product", format: "bmad", path: prdPath, role: "prd", text: prdText },
        ],
        artifactCandidates: [
          {
            id: "bmad-product",
            name: "Product",
            format: "bmad",
            paths: [prdPath],
            relevance: "changed-artifact",
          },
        ],
        files: new Map([[prdPath, prdText.split("\n").length]]),
      });

      expect(
        lint(projected, scoped).filter(
          (violation) =>
            violation.ruleId.startsWith("design-") || violation.ruleId.startsWith("requirement-"),
        ),
      ).toEqual([]);

      const inventedHeader = structuredClone(projected);
      inventedHeader.document = {
        ...inventedHeader.document,
        stats: [
          ...(inventedHeader.document?.stats ?? []),
          { label: "Capabilities", value: "2 new / 0 modified" },
        ],
      } as NonNullable<DraftBoard["document"]>;
      expect(
        lint(inventedHeader, scoped).filter(
          ({ ruleId, message }) =>
            ruleId === "design-header-complete" &&
            message.includes("unexpected stat `capabilities`"),
        ),
      ).toHaveLength(1);

      for (const [field, value] of [
        ["capability", "invented"],
        ["name", "Invented FR"],
        ["spec_delta", "modified"],
      ] as const) {
        const mutated = structuredClone(projected);
        mutated.elements = mutated.elements.map((element) =>
          element.id === "fr1"
            ? el("fr1", "requirement", { ...element.data, [field]: value })
            : element,
        );
        expect(
          lint(mutated, scoped).filter(
            (violation) => violation.ruleId === "design-artifact-content-hierarchy",
          ),
        ).not.toEqual([]);
      }
    });

    it("preserves grill-with-docs glossary triples, groups, and ADR rationale", () => {
      const contextPath = "CONTEXT.md";
      const adrPath = "docs/adr/0001-store-events.md";
      const grillCandidate = "grill-context";
      const contextSource = { path: contextPath, candidate: grillCandidate };
      const adrSource = { path: adrPath, candidate: grillCandidate };
      const contextText = [
        "# Context",
        "",
        "Defines the repository's exact review language.",
        "",
        "## Language",
        "",
        "### Review objects",
        "",
        "**Round**: One immutable review generation.",
        "_Avoid_: session, run",
      ].join("\n");
      const adrText = [
        "---",
        "status: accepted",
        "---",
        "",
        "# Store events",
        "",
        "Keep the event store as the atomic-write owner.",
        "",
        "## Considered Options",
        "- Store events remotely.",
        "- Keep events in memory only.",
        "",
        "## Consequences",
        "The event store remains load-bearing.",
      ].join("\n");
      const projected = board(
        [
          el("context", "section", {
            title: "Context language",
            children: ["context-copy", "language-group"],
            sources: [contextSource],
          }),
          el("context-copy", "prose", {
            markdown: "Defines the repository's exact review language.",
          }),
          el("language-group", "section", {
            title: "Review objects",
            children: ["round-term"],
          }),
          el("round-term", "prose", {
            markdown: "**Round**: One immutable review generation. _Avoid_: session, run",
            glossary_term: {
              term: "Round",
              definition: "One immutable review generation.",
              avoid: ["session", "run"],
            },
          }),
          el("adr", "section", {
            title: "Architecture decision",
            children: ["store-decision"],
            sources: [adrSource],
          }),
          el("store-decision", "decision", {
            statement: "Store events",
            why: "Keep the event store as the atomic-write owner.",
            evidence: [],
            alternatives: ["Store events remotely.", "Keep events in memory only."],
            inferred: false,
            source: { ...adrSource, line: 5 },
          }),
        ],
        {
          document: {
            title: "Review context",
            introMarkdown: "Repository language and stated decisions.",
            measure: "structured",
            sources: [contextSource, adrSource],
            stats: [
              { label: "Format", value: "grill-with-docs" },
              { label: "Requirements", value: "0" },
            ],
          },
        },
      );
      const scoped = completeCtx({
        artifacts: [
          {
            candidate: grillCandidate,
            format: "grill-with-docs",
            path: contextPath,
            role: "context",
            text: contextText,
          },
          {
            candidate: grillCandidate,
            format: "grill-with-docs",
            path: adrPath,
            role: "adr",
            text: adrText,
          },
        ],
        artifactCandidates: [
          {
            id: grillCandidate,
            name: "Review context",
            format: "grill-with-docs",
            paths: [contextPath, adrPath],
            relevance: "changed-artifact",
          },
        ],
        files: new Map([
          [contextPath, contextText.split("\n").length],
          [adrPath, adrText.split("\n").length],
        ]),
      });

      expect(
        lint(projected, scoped).filter((violation) => reverseRules.has(violation.ruleId)),
      ).toEqual([]);

      const exact = (draft: DraftBoard) =>
        lint(draft, scoped).filter(
          (violation) => violation.ruleId === "design-artifact-content-complete",
        );
      for (const glossary of [
        undefined,
        {
          term: "Round",
          definition: "One immutable review generation.",
          avoid: ["run", "session"],
        },
        {
          term: "Iteration",
          definition: "One immutable review generation.",
          avoid: ["session", "run"],
        },
      ]) {
        const mutated = structuredClone(projected);
        mutated.elements = mutated.elements.map((element) => {
          if (element.id !== "round-term") return element;
          const data = { ...element.data };
          delete data.glossary_term;
          return el(element.id, element.kind, {
            ...data,
            ...(glossary === undefined ? {} : { glossary_term: glossary }),
          });
        });
        expect(exact(mutated)).toHaveLength(1);
      }

      const inventedGlossary = structuredClone(projected);
      inventedGlossary.elements = inventedGlossary.elements.map((element) =>
        element.id === "context-copy"
          ? el(element.id, element.kind, {
              ...element.data,
              glossary_term: {
                term: "Context",
                definition: "An invented structured term.",
                avoid: [],
              },
            })
          : element,
      );
      expect(exact(inventedGlossary)).toHaveLength(1);

      const inventedGlossaryAnchor = structuredClone(projected);
      inventedGlossaryAnchor.elements = [
        ...inventedGlossaryAnchor.elements.map((element) =>
          element.id === "language-group"
            ? el(element.id, element.kind, {
                ...element.data,
                children: [
                  ...(element.data as { children: readonly string[] }).children,
                  "invented-term",
                ],
              })
            : element,
        ),
        el("invented-term", "prose", {
          markdown: "**Iteration**: An invented unit of work. _Avoid_: round",
        }),
      ];
      expect(exact(inventedGlossaryAnchor)).toEqual([
        expect.objectContaining({ elementRef: "invented-term/glossary_term" }),
      ]);

      const renamedGroup = structuredClone(projected);
      renamedGroup.elements = renamedGroup.elements.map((element) =>
        element.id === "language-group"
          ? el(element.id, element.kind, { ...element.data, title: "Invented terms" })
          : element,
      );
      expect(
        lint(renamedGroup, scoped).filter(
          (violation) => violation.ruleId === "design-artifact-content-hierarchy",
        ),
      ).toHaveLength(1);

      for (const decisionData of [
        {
          why: "A rationale the ADR never stated.",
          alternatives: ["Store events remotely.", "Keep events in memory only."],
        },
        {
          why: "Keep the event store as the atomic-write owner.",
          alternatives: ["Keep events in memory only.", "Store events remotely."],
        },
      ]) {
        const mutated = structuredClone(projected);
        mutated.elements = mutated.elements.map((element) =>
          element.id === "store-decision"
            ? el(element.id, element.kind, { ...element.data, ...decisionData })
            : element,
        );
        expect(exact(mutated)).toHaveLength(1);
      }
    });

    it("rejects an empty source-linked region even when the header names the artifact", () => {
      const empty = completeDesign();
      empty.elements = [
        el("source", "section", {
          title: "Session specification",
          children: [],
          sources: [source],
        }),
      ];

      expect(rulesHit(lint(empty, completeCtx()))).toContain("design-artifact-content-complete");
    });

    it("rejects missing source requirements, scenarios, and tasks", () => {
      const missing = completeDesign();
      missing.elements = missing.elements.filter(
        (element) => !["requirement-2", "scenario-2", "task-2"].includes(element.id),
      );

      const violations = lint(missing, completeCtx()).filter(
        (violation) => violation.ruleId === "design-artifact-content-complete",
      );
      expect(violations.map((violation) => violation.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("recover the session"),
          expect.stringContaining("Reopen the application"),
          expect.stringContaining("Prove restart recovery"),
        ]),
      );
    });

    it("keeps repeated source tasks as separate disposition anchors", () => {
      const repeatedText = `${tasksText}\n- [ ] Prove restart recovery`;
      const violations = lint(
        completeDesign(),
        completeCtx({
          artifacts: [
            { candidate, format: "openspec", path, role: "spec-delta", text },
            {
              candidate,
              format: "openspec",
              path: tasksPath,
              role: "tasks",
              text: repeatedText,
            },
          ],
          files: new Map([
            [path, text.split("\n").length],
            [tasksPath, repeatedText.split("\n").length],
          ]),
        }),
      ).filter((violation) => violation.ruleId === "design-artifact-content-complete");

      expect(violations).toEqual([
        expect.objectContaining({ message: expect.stringContaining("Prove restart recovery") }),
      ]);
    });

    it("rejects scenarios attached to the wrong source requirement", () => {
      const swapped = completeDesign();
      swapped.elements = swapped.elements.map((element) => {
        if (element.id === "requirement-1") {
          return el("requirement-1", "requirement", {
            ...element.data,
            scenarios: ["scenario-2"],
          });
        }
        if (element.id === "requirement-2") {
          return el("requirement-2", "requirement", {
            ...element.data,
            scenarios: ["scenario-1"],
          });
        }
        return element;
      });

      const violations = lint(swapped, completeCtx()).filter(
        (violation) => violation.ruleId === "design-artifact-content-complete",
      );
      expect(violations.map(({ message }) => message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Refresh an expired session"),
          expect.stringContaining("Reopen the application"),
        ]),
      );
    });

    it("rejects two source task groups collapsed into one rendered group", () => {
      const planPath = "docs/superpowers/plans/2026-08-29-session.md";
      const planSource = { path: planPath, candidate };
      const planText = [
        "# Session Implementation Plan",
        "",
        "### Task 1: Persist sessions",
        "- [ ] **Step 1: Write persistence**",
        "",
        "### Task 2: Restore sessions",
        "- [ ] **Step 1: Write recovery**",
      ].join("\n");
      const collapsed = board(
        [
          el("plan", "section", {
            title: "Session Implementation Plan",
            children: ["one-group"],
            sources: [planSource],
          }),
          el("one-group", "section", {
            title: "Delivery",
            children: ["persist-step", "restore-step"],
          }),
          el("persist-step", "prose", { markdown: "- [ ] **Step 1: Write persistence**" }),
          el("restore-step", "prose", { markdown: "- [ ] **Step 1: Write recovery**" }),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "Persist and restore sessions.",
            measure: "structured",
            sources: [planSource],
            stats: [
              { label: "Requirements", value: "0" },
              { label: "Capabilities", value: "0 new / 0 modified" },
              { label: "Tasks", value: "0/2" },
            ],
          },
        },
      );

      expect(
        rulesHit(
          lint(
            collapsed,
            completeCtx({
              artifacts: [
                {
                  candidate,
                  format: "superpowers",
                  path: planPath,
                  role: "plan",
                  text: planText,
                },
              ],
              artifactCandidates: [
                { id: candidate, paths: [planPath], relevance: "changed-artifact" },
              ],
              files: new Map([[planPath, planText.split("\n").length]]),
            }),
          ),
        ),
      ).toContain("design-artifact-content-hierarchy");
    });

    it("requires each source-stated Design decision", () => {
      const designPath = "openspec/changes/session/design.md";
      const designSource = { path: designPath, candidate };
      const designText = [
        "# Design",
        "",
        "## Decisions",
        "",
        "### Keep session state in the existing store",
        "The store already owns atomic writes.",
      ].join("\n");
      const missingDecision = board(
        [
          el("design", "section", {
            title: "Design",
            children: ["context"],
            sources: [designSource],
          }),
          el("context", "prose", { markdown: "The store already owns atomic writes." }),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "Keep session state local.",
            measure: "structured",
            sources: [designSource],
            stats: [
              { label: "Requirements", value: "0" },
              { label: "Capabilities", value: "0 new / 0 modified" },
            ],
          },
        },
      );

      const violations = lint(
        missingDecision,
        completeCtx({
          artifacts: [
            {
              candidate,
              format: "openspec",
              path: designPath,
              role: "design",
              text: designText,
            },
          ],
          artifactCandidates: [
            { id: candidate, paths: [designPath], relevance: "changed-artifact" },
          ],
          files: new Map([[designPath, designText.split("\n").length]]),
        }),
      ).filter((violation) => violation.ruleId === "design-artifact-content-complete");

      expect(violations).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("Keep session state in the existing store"),
        }),
      ]);
    });

    it("keeps stated decision rationale, alternatives, and evidence source-exact", () => {
      const designPath = "openspec/changes/session/design.md";
      const designSource = { path: designPath, candidate };
      const designText = [
        "## Decisions",
        "",
        "### Keep event state in the existing store",
        "",
        "#### Why",
        "The store already owns atomic writes.",
        "",
        "#### Alternatives not taken",
        "- Write a second store.",
        "- Keep state in memory only.",
        "",
        "#### Evidence",
        "- src/store.ts:12-14",
      ].join("\n");
      const exact = board(
        [
          el("design", "section", {
            title: "Design",
            children: ["store-decision", "store-evidence"],
            sources: [designSource],
          }),
          el("store-decision", "decision", {
            statement: "Keep event state in the existing store",
            why: "The store already owns atomic writes.",
            alternatives: ["Write a second store.", "Keep state in memory only."],
            evidence: ["store-evidence"],
            inferred: false,
            source: { ...designSource, line: 3 },
          }),
          codeRef("store-evidence", "src/store.ts", 12, 14),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "Keep event state atomic.",
            measure: "structured",
            sources: [designSource],
            stats: [{ label: "Requirements", value: "0" }],
          },
        },
      );
      const scoped = completeCtx({
        artifacts: [
          {
            candidate,
            format: "openspec",
            path: designPath,
            role: "design",
            text: designText,
          },
        ],
        artifactCandidates: [{ id: candidate, paths: [designPath] }],
        files: new Map([
          [designPath, designText.split("\n").length],
          ["src/store.ts", 20],
        ]),
      });

      expect(
        lint(exact, scoped).filter(
          (violation) => violation.ruleId === "design-artifact-content-complete",
        ),
      ).toEqual([]);

      const unsourced = structuredClone(exact);
      unsourced.elements = [
        ...unsourced.elements.map((element) =>
          element.id === "design"
            ? el("design", "section", {
                ...element.data,
                children: [
                  ...(element.data as { children: readonly string[] }).children,
                  "unsourced-decision",
                ],
              })
            : element,
        ),
        el("unsourced-decision", "decision", {
          statement: "Write a second session store",
          why: "Separate writes by lifecycle.",
          alternatives: ["Keep the existing store."],
          evidence: ["store-evidence"],
          inferred: false,
        }),
      ];
      expect(
        lint(unsourced, scoped).filter((violation) => violation.ruleId === "design-source-known"),
      ).toEqual([
        expect.objectContaining({
          elementRef: "unsourced-decision/source",
          message: expect.stringContaining("candidate, artifact path, and positive source line"),
        }),
      ]);

      exact.elements = exact.elements.map((element) =>
        element.id === "store-decision"
          ? el("store-decision", "decision", {
              ...element.data,
              why: "An invented rationale.",
              alternatives: ["An invented alternative."],
              evidence: [],
            })
          : element,
      );
      expect(
        lint(exact, scoped).filter(
          (violation) => violation.ruleId === "design-artifact-content-complete",
        ),
      ).toHaveLength(3);
    });

    it("keeps OpenSpec paragraph and explicit Kiro decisions source-exact", () => {
      const cases = [
        {
          candidate: "openspec-choice",
          format: "openspec" as const,
          role: "design",
          path: "openspec/changes/session/design.md",
          text: "## Decisions\n\n**Use SQLite.** It keeps writes local.",
          statement: "Use SQLite.",
          why: "It keeps writes local.",
          alternatives: [] as string[],
          line: 3,
        },
        {
          candidate: "kiro-choice",
          format: "kiro" as const,
          role: "design",
          path: ".kiro/specs/session/design.md",
          text: [
            "## Architecture",
            "",
            "### Decision: Keep event state in the existing store",
            "#### Why",
            "The store already owns atomic writes.",
            "#### Alternatives",
            "- Write a second store.",
          ].join("\n"),
          statement: "Keep event state in the existing store",
          why: "The store already owns atomic writes.",
          alternatives: ["Write a second store."],
          line: 3,
        },
      ];

      for (const sourceCase of cases) {
        const sourceRef = { path: sourceCase.path, candidate: sourceCase.candidate };
        const projected = board(
          [
            el(`${sourceCase.candidate}-root`, "section", {
              title: "Session design",
              children: [`${sourceCase.candidate}-decision`],
              sources: [sourceRef],
            }),
            el(`${sourceCase.candidate}-decision`, "decision", {
              statement: sourceCase.statement,
              why: sourceCase.why,
              alternatives: sourceCase.alternatives,
              evidence: [],
              inferred: false,
              source: { ...sourceRef, line: sourceCase.line },
            }),
          ],
          {
            document: {
              title: "Session",
              introMarkdown: "Exact stated choices.",
              measure: "structured",
              sources: [sourceRef],
              stats: [
                {
                  label: "Format",
                  value: sourceCase.format === "openspec" ? "OpenSpec" : "Kiro",
                },
                { label: "Requirements", value: "0" },
              ],
            },
          },
        );
        const scoped = completeCtx({
          artifacts: [
            {
              candidate: sourceCase.candidate,
              format: sourceCase.format,
              path: sourceCase.path,
              role: sourceCase.role,
              text: sourceCase.text,
            },
          ],
          artifactCandidates: [
            {
              id: sourceCase.candidate,
              name: "Session",
              format: sourceCase.format,
              paths: [sourceCase.path],
              relevance: "changed-artifact",
            },
          ],
          files: new Map([[sourceCase.path, sourceCase.text.split("\n").length]]),
        });
        const exact = (draft: DraftBoard) =>
          lint(draft, scoped).filter(
            (violation) => violation.ruleId === "design-artifact-content-complete",
          );
        expect(exact(projected)).toEqual([]);

        const mutated = structuredClone(projected);
        mutated.elements = mutated.elements.map((element) =>
          element.kind === "decision"
            ? el(element.id, "decision", {
                ...element.data,
                why: "Invented rationale.",
                alternatives: [...sourceCase.alternatives].reverse().concat("Invented option."),
              })
            : element,
        );
        expect(exact(mutated)).toHaveLength(2);
      }
    });

    it("keeps BMAD Tech Stack cells ordered and exact", () => {
      const path = "docs/architecture.md";
      const sourceRef = { path, candidate: "bmad-architecture" };
      const text = [
        "## Tech Stack",
        "| Category | Technology | Version | Rationale |",
        "| --- | --- | --- | --- |",
        "| Language | TypeScript | 5.6 | Shared types |",
      ].join("\n");
      const projected = board(
        [
          el("architecture-root", "section", {
            title: "Architecture",
            children: ["tech-stack-choice"],
            sources: [sourceRef],
          }),
          el("tech-stack-choice", "decision", {
            statement: "Language · TypeScript · 5.6",
            why: "Shared types",
            alternatives: [],
            evidence: [],
            source_cells: ["Language", "TypeScript", "5.6", "Shared types"],
            inferred: false,
            source: { ...sourceRef, line: 4 },
          }),
        ],
        {
          document: {
            title: "Architecture",
            introMarkdown: "The definitive stack.",
            measure: "structured",
            sources: [sourceRef],
            stats: [
              { label: "Format", value: "BMAD" },
              { label: "Requirements", value: "0" },
            ],
          },
        },
      );
      const scoped = completeCtx({
        artifacts: [
          { candidate: "bmad-architecture", format: "bmad", path, role: "architecture", text },
        ],
        artifactCandidates: [
          {
            id: "bmad-architecture",
            name: "Architecture",
            format: "bmad",
            paths: [path],
            relevance: "changed-artifact",
          },
        ],
        files: new Map([[path, text.split("\n").length]]),
      });
      const exact = (draft: DraftBoard) =>
        lint(draft, scoped).filter(
          (violation) => violation.ruleId === "design-artifact-content-complete",
        );

      expect(exact(projected)).toEqual([]);
      for (const cells of [
        ["Language", "TypeScript", "Shared types"],
        ["TypeScript", "Language", "5.6", "Shared types"],
      ]) {
        const mutated = structuredClone(projected);
        mutated.elements = mutated.elements.map((element) =>
          element.id === "tech-stack-choice"
            ? el(element.id, element.kind, { ...element.data, source_cells: cells })
            : element,
        );
        expect(exact(mutated)).toEqual([
          expect.objectContaining({ elementRef: "tech-stack-choice/source_cells" }),
        ]);
      }
    });

    it("keeps Superpowers Architecture and Tech Stack header choices exact", () => {
      const path = "docs/superpowers/plans/2026-08-29-session.md";
      const sourceRef = { path, candidate: "superpowers-choices" };
      const text = [
        "**Goal:** Restore sessions after restart.",
        "**Architecture:** Keep event state in the existing store.",
        "**Tech Stack:** TypeScript 5.6 and SQLite",
        "**Spec:** docs/superpowers/specs/session.md",
      ].join("\n");
      const choice = (id: string, statement: string, label: string, line: number): DraftElement =>
        el(id, "decision", {
          statement,
          why: "",
          alternatives: [],
          evidence: [],
          source_cells: [label, statement],
          inferred: false,
          source: { ...sourceRef, line },
        });
      const projected = board(
        [
          el("plan-choices", "section", {
            title: "Plan choices",
            children: ["architecture-choice", "stack-choice"],
            sources: [sourceRef],
          }),
          choice(
            "architecture-choice",
            "Keep event state in the existing store.",
            "Architecture",
            2,
          ),
          choice("stack-choice", "TypeScript 5.6 and SQLite", "Tech Stack", 3),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "The exact plan header choices.",
            measure: "structured",
            sources: [sourceRef],
            stats: [
              { label: "Format", value: "Superpowers" },
              { label: "Requirements", value: "0" },
            ],
          },
        },
      );
      const scoped = completeCtx({
        artifacts: [
          { candidate: "superpowers-choices", format: "superpowers", path, role: "plan", text },
        ],
        artifactCandidates: [
          {
            id: "superpowers-choices",
            name: "Session",
            format: "superpowers",
            paths: [path],
            relevance: "changed-artifact",
          },
        ],
        files: new Map([[path, text.split("\n").length]]),
      });
      const exact = (draft: DraftBoard) =>
        lint(draft, scoped).filter(
          (violation) => violation.ruleId === "design-artifact-content-complete",
        );

      expect(exact(projected)).toEqual([]);
      const dropped = structuredClone(projected);
      dropped.elements = dropped.elements.filter((element) => element.id !== "stack-choice");
      expect(exact(dropped)).toHaveLength(1);

      const changed = structuredClone(projected);
      changed.elements = changed.elements.map((element) =>
        element.id === "stack-choice"
          ? choice("stack-choice", "JavaScript", "Tech Stack", 3)
          : element,
      );
      expect(exact(changed)).not.toEqual([]);
    });

    it("rejects reversed scenario and task disposition anchors", () => {
      const reversed = completeDesign();
      reversed.elements = reversed.elements.map((element) => {
        if (element.id === "added-operation") {
          return el("added-operation", "section", {
            title: "Session",
            children: ["requirement-2", "requirement-1"],
            spec_delta: "added",
          });
        }
        if (element.id === "task-group") {
          return el("task-group", "section", {
            title: "1. Delivery",
            children: ["task-2", "task-1"],
          });
        }
        return element;
      });

      const orderViolations = lint(reversed, completeCtx()).filter(
        (violation) => violation.ruleId === "design-artifact-content-order",
      );
      expect(orderViolations.length).toBeGreaterThanOrEqual(2);
    });

    it("derives header counts from the rendered source projection", () => {
      const wrong = completeDesign();
      wrong.document = {
        ...wrong.document,
        stats: [
          { label: "Format", value: "OpenSpec" },
          { label: "Requirements", value: "1" },
          { label: "Capabilities", value: "2 new / 0 modified" },
          { label: "Tasks", value: "2/2" },
        ],
      } as NonNullable<DraftBoard["document"]>;

      expect(
        lint(wrong, completeCtx()).filter(
          (violation) => violation.ruleId === "design-header-complete",
        ),
      ).toHaveLength(3);
    });

    it("uses the OpenSpec proposal to classify capabilities with added requirements", () => {
      const proposalPath = "openspec/changes/session/proposal.md";
      const proposalSource = { path: proposalPath, candidate };
      const proposalText = [
        "# Session",
        "",
        "## Capabilities",
        "",
        "### New Capabilities",
        "",
        "### Modified Capabilities",
        "",
        "- `session`: Gains restart recovery.",
      ].join("\n");
      const projected = completeDesign();
      projected.elements = projected.elements.map((element) =>
        element.id === "requirement-2"
          ? el("requirement-2", "requirement", {
              shall: "The system SHALL recover the session after restart.",
              capability: "session",
              spec_delta: "added",
              scenarios: ["scenario-2"],
              source: requirementTwoSource,
            })
          : element,
      );
      projected.document = {
        ...projected.document,
        sources: [source, tasksSource, proposalSource],
        stats: [
          { label: "Requirements", value: "2" },
          { label: "Capabilities", value: "0 new / 1 modified" },
          { label: "Tasks", value: "1/2" },
        ],
      } as NonNullable<DraftBoard["document"]>;

      const violations = lint(
        projected,
        completeCtx({
          artifacts: [
            { candidate, format: "openspec", path, role: "spec-delta", text },
            {
              candidate,
              format: "openspec",
              path: tasksPath,
              role: "tasks",
              text: tasksText,
            },
            {
              candidate,
              format: "openspec",
              path: proposalPath,
              role: "proposal",
              text: proposalText,
            },
          ],
          artifactCandidates: [
            {
              id: candidate,
              paths: [path, tasksPath, proposalPath],
              relevance: "changed-artifact",
            },
          ],
          files: new Map([
            [path, text.split("\n").length],
            [tasksPath, tasksText.split("\n").length],
            [proposalPath, proposalText.split("\n").length],
          ]),
        }),
      ).filter((violation) => violation.ruleId === "design-header-complete");

      expect(violations).toEqual([]);
    });

    it("counts Superpowers task groups instead of partially checked steps", () => {
      const planPath = "docs/superpowers/plans/2026-08-29-session.md";
      const planSource = { path: planPath, candidate };
      const planText = [
        "# Session Implementation Plan",
        "",
        "### Task 1: Persist sessions",
        "",
        "- [x] Write the failing test",
        "- [ ] Prove restart recovery",
      ].join("\n");
      const projected = board(
        [
          el("plan", "section", {
            title: "Session Implementation Plan",
            children: ["task-group"],
            sources: [planSource],
          }),
          el("task-group", "section", {
            title: "Task 1: Persist sessions",
            children: ["step-1", "step-2"],
          }),
          el("step-1", "prose", { markdown: "- [x] Write the failing test" }),
          el("step-2", "prose", { markdown: "- [ ] Prove restart recovery" }),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "Persist sessions across restarts.",
            measure: "structured",
            sources: [planSource],
            stats: [
              { label: "Requirements", value: "0" },
              { label: "Tasks", value: "0/1" },
            ],
          },
        },
      );

      const violations = lint(
        projected,
        completeCtx({
          artifacts: [{ candidate, path: planPath, role: "plan", text: planText }],
          artifactCandidates: [{ id: candidate, paths: [planPath], relevance: "changed-artifact" }],
          files: new Map([[planPath, planText.split("\n").length]]),
        }),
      ).filter((violation) => violation.ruleId === "design-header-complete");

      expect(violations).toEqual([]);
    });

    it("keeps each Superpowers task manifest exact and unique to its source group", () => {
      const planPath = "docs/superpowers/plans/2026-08-29-session.md";
      const planSource = { path: planPath, candidate };
      const taskManifest = {
        files: [
          { operation: "modify", value: "`src/store.ts:12-30`" },
          { operation: "test", value: "`src/store.test.ts`" },
        ],
        interfaces: [
          { direction: "consumes", value: "`Clock.now(): number`" },
          { direction: "produces", value: "`SessionStore.write(session): void`" },
        ],
        verifications: [{ run: "`pnpm test store`", expected: 'FAIL with "write is not defined"' }],
      };
      const planText = [
        "### Task 1: Store sessions",
        "**Files:**",
        "- Modify: `src/store.ts:12-30`",
        "- Test: `src/store.test.ts`",
        "**Interfaces:**",
        "- Consumes: `Clock.now(): number`",
        "- Produces: `SessionStore.write(session): void`",
        "- [ ] **Step 1: Run the failing test**",
        "Run: `pnpm test store`",
        'Expected: FAIL with "write is not defined"',
        "",
        "### Task 2: Restore sessions",
        "- [ ] **Step 1: Add restart coverage**",
      ].join("\n");
      const projected = board(
        [
          el("manifest-plan", "section", {
            title: "Session Implementation Plan",
            children: ["manifest-task-1", "manifest-task-2"],
            sources: [planSource],
          }),
          el("manifest-task-1", "section", {
            title: "Task 1: Store sessions",
            children: ["manifest-step-1"],
            task_manifest: taskManifest,
          }),
          el("manifest-step-1", "prose", {
            markdown: "- [ ] **Step 1: Run the failing test**",
          }),
          el("manifest-task-2", "section", {
            title: "Task 2: Restore sessions",
            children: ["manifest-step-2"],
          }),
          el("manifest-step-2", "prose", {
            markdown: "- [ ] **Step 1: Add restart coverage**",
          }),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "Exact task manifests and steps.",
            measure: "structured",
            sources: [planSource],
            stats: [
              { label: "Format", value: "Superpowers" },
              { label: "Requirements", value: "0" },
              { label: "Tasks", value: "0/2" },
            ],
          },
        },
      );
      const scoped = completeCtx({
        artifacts: [
          {
            candidate,
            format: "superpowers",
            path: planPath,
            role: "plan",
            text: planText,
          },
        ],
        artifactCandidates: [
          {
            id: candidate,
            name: "Session",
            format: "superpowers",
            paths: [planPath],
            relevance: "changed-artifact",
          },
        ],
        files: new Map([[planPath, planText.split("\n").length]]),
      });
      const exact = (draft: DraftBoard) =>
        lint(draft, scoped).filter(
          (violation) => violation.ruleId === "design-artifact-content-complete",
        );

      expect(exact(projected)).toEqual([]);

      const faults: DraftBoard[] = [];
      for (const replacement of [
        undefined,
        {
          ...taskManifest,
          files: [...taskManifest.files].reverse(),
        },
        {
          ...taskManifest,
          interfaces: [
            ...taskManifest.interfaces,
            { direction: "produces", value: "InventedInterface" },
          ],
        },
      ]) {
        const mutated = structuredClone(projected);
        mutated.elements = mutated.elements.map((element) => {
          if (element.id !== "manifest-task-1") return element;
          const data = { ...element.data };
          delete data.task_manifest;
          return el(element.id, element.kind, {
            ...data,
            ...(replacement === undefined ? {} : { task_manifest: replacement }),
          });
        });
        faults.push(mutated);
      }
      const duplicate = structuredClone(projected);
      duplicate.elements = duplicate.elements.map((element) =>
        element.id === "manifest-plan"
          ? el(element.id, element.kind, { ...element.data, task_manifest: taskManifest })
          : element,
      );
      faults.push(duplicate);
      const stepLocal = structuredClone(projected);
      stepLocal.elements = stepLocal.elements.map((element) =>
        element.id === "manifest-step-1"
          ? el(element.id, element.kind, { ...element.data, task_manifest: taskManifest })
          : element,
      );
      faults.push(stepLocal);
      const invented = structuredClone(projected);
      invented.elements = invented.elements.map((element) =>
        element.id === "manifest-task-2"
          ? el(element.id, element.kind, {
              ...element.data,
              task_manifest: { files: [], interfaces: [], verifications: [] },
            })
          : element,
      );
      faults.push(invented);

      for (const fault of faults) expect(exact(fault)).toHaveLength(1);
    });

    it("grounds every Superpowers ledger line without treating fix notes as completion", () => {
      const planPath = "docs/superpowers/plans/2026-08-29-session.md";
      const progressPath = ".superpowers/sdd/2026-08-29-session/progress.md";
      const planSource = { path: planPath, candidate };
      const progressSource = { path: progressPath, candidate };
      const planText = [
        "# Session Implementation Plan",
        "",
        "### Task 1: Persist sessions",
        "- [ ] Write the failing test",
        "",
        "### Task 2: Restore sessions",
        "- [ ] Prove restart recovery",
      ].join("\n");
      const progressLines = [
        `# SDD ledger — plan: ${planPath}`,
        "Task 1: complete (commits abc1234..def5678, review clean)",
        "Task 2: fix round 1/5 (1 addressed, 1 open — retry; commits def5678..fed4321)",
        "Task 2: minor (deferred): tighten the copy",
        "Ruling: keep the old route — callers depend on it — removal would break links",
      ];
      const progressText = progressLines.join("\n");
      const projected = board(
        [
          el("plan", "section", {
            title: "Session Implementation Plan",
            children: ["task-1", "task-2"],
            sources: [planSource],
          }),
          el("task-1", "section", {
            title: "Task 1: Persist sessions",
            children: ["step-1"],
          }),
          el("step-1", "prose", { markdown: "- [ ] Write the failing test" }),
          el("task-2", "section", {
            title: "Task 2: Restore sessions",
            children: ["step-2"],
          }),
          el("step-2", "prose", { markdown: "- [ ] Prove restart recovery" }),
          el("progress", "section", {
            title: "Execution progress",
            children: progressLines.map((_, index) => `progress-${index + 1}`),
            sources: [progressSource],
          }),
          ...progressLines.map((markdown, index) =>
            el(`progress-${index + 1}`, "prose", { markdown }),
          ),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "Persist and restore sessions.",
            measure: "structured",
            sources: [planSource, progressSource],
            stats: [
              { label: "Requirements", value: "0" },
              { label: "Tasks", value: "1/2" },
            ],
          },
        },
      );
      const scoped = completeCtx({
        artifacts: [
          { candidate, format: "superpowers", path: planPath, role: "plan", text: planText },
          {
            candidate,
            format: "superpowers",
            path: progressPath,
            role: "progress",
            text: progressText,
          },
        ],
        artifactCandidates: [
          { id: candidate, paths: [planPath, progressPath], relevance: "changed-artifact" },
        ],
        files: new Map([
          [planPath, planText.split("\n").length],
          [progressPath, progressLines.length],
        ]),
      });

      expect(
        lint(projected, scoped).filter(
          (violation) => violation.ruleId === "design-artifact-content-complete",
        ),
      ).toEqual([]);
      expect(
        lint(projected, scoped).filter(
          (violation) => violation.ruleId === "design-header-complete",
        ),
      ).toEqual([]);

      const wrongGroupTitle = structuredClone(projected);
      wrongGroupTitle.elements = wrongGroupTitle.elements.map((element) =>
        element.id === "task-1"
          ? el("task-1", "section", { ...element.data, title: "Persist sessions" })
          : element,
      );
      expect(
        lint(wrongGroupTitle, scoped).filter(
          ({ ruleId, elementRef }) =>
            ruleId === "design-artifact-content-hierarchy" && elementRef === "task-1/title",
        ),
      ).toHaveLength(1);

      const withUnmatchedProgress = (id: string, markdown: string): DraftBoard => {
        const mutated = structuredClone(projected);
        mutated.elements = [
          ...mutated.elements.map((element) =>
            element.id === "progress"
              ? el("progress", "section", {
                  ...element.data,
                  children: [...(element.data.children as string[]), id],
                })
              : element,
          ),
          el(id, "prose", { markdown }),
        ];
        return mutated;
      };
      for (const [id, markdown] of [
        ["progress-invented", "Task 9: complete (invented)"],
        ["progress-duplicate", progressLines[4] ?? ""],
      ] as const) {
        expect(
          lint(withUnmatchedProgress(id, markdown), scoped).filter(
            (violation) => violation.ruleId === "design-artifact-content-complete",
          ),
        ).toEqual([
          expect.objectContaining({
            elementRef: id,
            message: expect.stringContaining("progress line"),
          }),
        ]);
      }

      projected.elements = projected.elements.filter(({ id }) => id !== "progress-3");
      expect(
        lint(projected, scoped).filter(
          (violation) => violation.ruleId === "design-artifact-content-complete",
        ),
      ).toEqual([
        expect.objectContaining({ message: expect.stringContaining("Task 2: fix round 1/5") }),
      ]);
    });

    it("requires proposal why, what-changes, and impact regions", () => {
      const proposalPath = "openspec/changes/session/proposal.md";
      const proposalSource = { path: proposalPath, candidate };
      const proposalCtx = completeCtx({
        artifacts: [
          {
            candidate,
            path: proposalPath,
            role: "proposal",
            text: [
              "# Session",
              "",
              "## Why",
              "",
              "Sessions currently disappear after restart.",
              "",
              "## What Changes",
              "",
              "- Change session persistence.",
              "- Preserve restart recovery.",
              "",
              "## Impact",
              "",
              "Restart recovery changes.",
            ].join("\n"),
          },
        ],
        artifactCandidates: [
          { id: candidate, paths: [proposalPath], relevance: "changed-artifact" },
        ],
        files: new Map([[proposalPath, 3]]),
      });
      const proposal = board(
        [
          el("proposal", "section", {
            title: "Proposal",
            children: ["what-changes", "impact"],
            sources: [proposalSource],
          }),
          el("what-changes", "section", { title: "What Changes", children: ["change"] }),
          el("change", "prose", { markdown: "Change session persistence." }),
          el("impact", "section", { title: "Impact", children: ["impact-copy"] }),
          el("impact-copy", "prose", { markdown: "Restart recovery changes." }),
        ],
        {
          document: {
            title: "Session",
            introMarkdown: "Persist sessions.",
            measure: "structured",
            sources: [proposalSource],
            stats: [
              { label: "Requirements", value: "0" },
              { label: "Capabilities", value: "0 new / 0 modified" },
            ],
          },
        },
      );

      expect(rulesHit(lint(proposal, proposalCtx))).toContain("design-artifact-anatomy");
      proposal.elements = [
        el("proposal", "section", {
          title: "Proposal",
          children: ["why", "what-changes", "impact"],
          sources: [proposalSource],
        }),
        el("why", "section", { title: "Why", children: ["why-copy"] }),
        el("why-copy", "prose", { markdown: "Sessions currently disappear after restart." }),
        el("what-changes", "section", {
          title: "What Changes",
          children: ["change", "change-recovery"],
        }),
        el("change", "prose", { markdown: "Change session persistence." }),
        el("change-recovery", "prose", { markdown: "Preserve restart recovery." }),
        el("impact", "section", { title: "Impact", children: ["impact-copy"] }),
        el("impact-copy", "prose", { markdown: "Restart recovery changes." }),
      ];
      expect(rulesHit(lint(proposal, proposalCtx))).not.toContain("design-artifact-anatomy");

      proposal.elements = proposal.elements.map((element) =>
        element.id === "what-changes"
          ? el("what-changes", "section", {
              title: "What Changes",
              children: ["change-recovery", "change"],
            })
          : element,
      );
      expect(rulesHit(lint(proposal, proposalCtx))).toContain("design-artifact-anatomy");
    });

    it("requires bounded discovery to be visible in the document", () => {
      expect(
        rulesHit(lint(completeDesign(), completeCtx({ artifactBundleIncomplete: true }))),
      ).toContain("design-incompleteness-visible");

      const visible = completeDesign();
      visible.elements = [
        ...visible.elements,
        el("incomplete", "callout", {
          variant: "warning",
          body: "The discovered source bundle is incomplete because one artifact was truncated.",
        }),
      ];
      expect(
        rulesHit(lint(visible, completeCtx({ artifactBundleIncomplete: true }))),
      ).not.toContain("design-incompleteness-visible");
    });

    it("leaves final semantic candidate selection to agent judgment", () => {
      const companion = "docs/decisions/session-recovery.md";
      const companionSource = { path: companion, candidate: "companion" };
      const selected = board(
        [
          el("companion", "section", {
            title: "Session recovery decision",
            children: ["decision-copy"],
            sources: [companionSource],
          }),
          el("decision-copy", "prose", {
            markdown: "Session recovery remains local to the desktop process.",
          }),
        ],
        {
          document: {
            title: "Session recovery decision",
            introMarkdown: "The repository decision is relevant despite having no path overlap.",
            measure: "structured",
            sources: [companionSource],
            stats: [
              { label: "Requirements", value: "0" },
              { label: "Capabilities", value: "0 new / 0 modified" },
            ],
          },
        },
      );
      const relevanceCtx = ctx({
        lens: "design",
        regions: [],
        artifacts: [
          {
            candidate: "companion",
            path: companion,
            text: "Session recovery remains local to the desktop process.",
          },
          { candidate, path, text },
        ],
        artifactCandidates: [
          { id: "companion", paths: [companion], relevance: "repository-candidate" },
          { id: candidate, paths: [path], relevance: "changed-artifact" },
        ],
        files: new Map([
          [companion, 1],
          [path, text.split("\n").length],
        ]),
      });

      expect(rulesHit(lint(selected, relevanceCtx))).not.toContain("design-candidate-relevant");
    });
  });
});

// ── kind-allowlist (S1 residue at lint scope) ────────────────────────────────

describe("kind-allowlist (per-lens kinds)", () => {
  it("fires when a typed kind appears on the wrong lens board", () => {
    // A `finding` on the Noise board — findings belong to Flagged.
    const bad = board([
      el("f", "finding", {
        severity: "low",
        concern: "x",
        code: [],
        concurrence: [],
        status: "open",
      }),
    ]);
    const scoped = ctx({ lens: "noise" as LensKind });
    expect(rulesHit(lint(bad, scoped))).toContain("kind-allowlist");
  });

  it("fires when the report seat's round_outcome appears on a lens board", () => {
    const bad = board([
      el("o", "round_outcome", { status: "addressed", ask: { ref: "a", text: "t" }, note: "n" }),
    ]);
    expect(rulesHit(lint(bad, ctx()))).toContain("kind-allowlist");
  });

  it("allows shared structural kinds on every lens", () => {
    const ok = board([
      el("p", "prose", { markdown: "A design note." }),
      codeRef("c", "src/auth.ts", 11, 12),
    ]);
    const scoped = ctx({ lens: "design" as LensKind });
    expect(rulesHit(lint(ok, scoped))).not.toContain("kind-allowlist");
  });

  // Spec-P1: the Design prompt renders BOTH requirement regions AND the
  // implementer's stated `decision` calls, so both are legal typed kinds there.
  it("admits both `decision` and `requirement` on the Design board (Spec-P1)", () => {
    const ok = board([
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
    ]);
    const scoped = ctx({ lens: "design" as LensKind });
    expect(rulesHit(lint(ok, scoped))).not.toContain("kind-allowlist");
  });

  it("rejects a `requirement` on the Decisions board (requirement is Design's, S1)", () => {
    const bad = board([el("r", "requirement", { shall: "x", coverage: "gap", trace: [] })]);
    const scoped = ctx({ lens: "decisions" as LensKind });
    expect(rulesHit(lint(bad, scoped))).toContain("kind-allowlist");
  });
});

// ── S3/S8 — GitHub #L citations + inverted ranges ────────────────────────────

describe("citation range + form (S3 / S8)", () => {
  it("citation-well-formed fires on a GitHub `#L` citation (colon-less form)", () => {
    const bad = board([el("p", "prose", { markdown: "See src/auth.ts#L11 for the guard." })]);
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-well-formed");
  });

  it("citation-resolves fires on an inverted prose range (999-1)", () => {
    const bad = board([el("p", "prose", { markdown: "See src/auth.ts:999-1 there." })]);
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-resolves");
  });

  it("citation-resolves fires on an inverted typed code_ref span", () => {
    const bad = board([
      el("c", "code_ref", {
        patchset_id: "ps-1",
        path: "src/auth.ts",
        side: "head",
        start_line: 20,
        end_line: 5,
      }),
    ]);
    expect(rulesHit(lint(bad, ctx()))).toContain("citation-resolves");
  });
});

// ── S2 — patchset identity + side-specific inventories ───────────────────────

describe("citation identity (S2 — patchset id + side)", () => {
  it("fires when a code_ref cites a different patchset than the board's", () => {
    const bad = board([
      el("c", "code_ref", {
        patchset_id: "other-ps",
        path: "src/auth.ts",
        side: "head",
        start_line: 11,
        end_line: 12,
      }),
    ]);
    const scoped = ctx({ patchsetId: "ps-1" });
    expect(rulesHit(lint(bad, scoped))).toContain("citation-resolves");
  });

  it("resolves a base-side ref against the BASE inventory, not head", () => {
    // The file exists at 200 lines on head but only 8 on base; a base-side ref to
    // line 40 overruns base though it fits head — checking the head inventory
    // would wrongly pass it.
    const bad = board([
      el("c", "code_ref", {
        patchset_id: "ps-1",
        path: "src/auth.ts",
        side: "base",
        start_line: 40,
        end_line: 40,
      }),
    ]);
    const scoped = ctx({ patchsetId: "ps-1", baseFiles: new Map([["src/auth.ts", 8]]) });
    expect(rulesHit(lint(bad, scoped))).toContain("citation-resolves");
  });

  it("passes a base-side ref that fits the base inventory", () => {
    const ok = board([
      el("c", "code_ref", {
        patchset_id: "ps-1",
        path: "src/auth.ts",
        side: "base",
        start_line: 3,
        end_line: 5,
      }),
    ]);
    const scoped = ctx({ patchsetId: "ps-1", baseFiles: new Map([["src/auth.ts", 8]]) });
    expect(rulesHit(lint(ok, scoped))).not.toContain("citation-resolves");
  });

  // `side` is a schema-declared enum, and the SCHEMA is what reports a value outside it. The
  // span reader used to coerce anything that was not "base" to head instead, so `side: "old"`
  // was linted against the head inventory, resolved against head regions, and rendered on
  // the head side — a citation checked on a side its author never named, silently.
  it("an unknown side is the schema's report, and is never linted as head", () => {
    const raw = {
      elements: [
        {
          id: "c",
          kind: "code_ref",
          data: {
            author,
            patchset_id: "ps-1",
            path: "src/ghost.ts",
            side: "old",
            start_line: 40,
            end_line: 41,
          },
        },
      ],
    };
    // The pointer that fires: the schema refuses the element and names the field.
    const parsed = parseDraft(raw);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed.ok === false ? parsed.issues : [])).toContain("side");

    // Control that this element is one lint WOULD have reported on the head side: with
    // `side: "head"` it fires BOTH citation rules (no such file, and outside every changed
    // region). With the side unknown neither fires — the element is the schema's business,
    // and lint no longer answers a question about a side its author never named.
    const asHead = board([
      el("c", "code_ref", {
        patchset_id: "ps-1",
        path: "src/ghost.ts",
        side: "head",
        start_line: 40,
        end_line: 41,
      }),
    ]);
    expect(rulesHit(lint(asHead, ctx({ patchsetId: "ps-1" })))).toContain("citation-resolves");
    expect(rulesHit(lint(asHead, ctx({ patchsetId: "ps-1" })))).toContain("unresolvable-citation");
    const unknownSide = board(raw.elements as unknown as DraftElement[]);
    const hit = rulesHit(lint(unknownSide, ctx({ patchsetId: "ps-1" })));
    expect(hit).not.toContain("unresolvable-citation");
    expect(hit).not.toContain("citation-resolves");
  });
});

// ── Schema-declared element references resolve and are orderable ──────────────

describe("schema-declared element references", () => {
  const referenceViolations = (draft: DraftBoard, lens: LensKind) =>
    lint(draft, ctx({ lens })).filter(({ ruleId }) => ruleId === "element-reference-resolves");

  it("rejects the dangling span and evidence shapes emitted by Sequence and Decisions", () => {
    const sequence = board([
      el("step", "order_step", {
        title: "Read the entry point",
        span: "missing-sequence-code",
        children: [],
      }),
    ]);
    const decisions = board([
      el("decision", "decision", {
        statement: "Keep writes atomic.",
        evidence: ["missing-decision-code"],
        alternatives: ["alternative"],
        why: "Readers never observe a partial batch.",
      }),
      el("alternative", "prose", { markdown: "Write each event independently." }),
    ]);

    expect(referenceViolations(sequence, "sequence")).toMatchObject([{ elementRef: "step/span" }]);
    expect(referenceViolations(decisions, "decisions")).toMatchObject([
      { elementRef: "decision/evidence" },
    ]);
  });

  it("uses the authored schema, so ordinary strings that equal element ids are not references", () => {
    const draft = board([
      el("decision", "decision", {
        statement: "Keep writes atomic.",
        evidence: [],
        alternatives: ["alternative"],
        why: "alternative",
      }),
      el("alternative", "prose", { markdown: "Write each event independently." }),
    ]);

    expect(referenceViolations(draft, "decisions")).toEqual([]);
  });

  it("rejects a cycle that no create-op ordering can make acceptable", () => {
    const draft = board([
      el("chapter", "section", { title: "Start here", children: ["step"] }),
      el("step", "order_step", {
        title: "Read the entry point",
        span: "code",
        children: ["chapter"],
      }),
      codeRef("code", "src/auth.ts", 11, 12),
    ]);

    expect(referenceViolations(draft, "sequence")).toMatchObject([{ elementRef: "step/children" }]);
  });
});

// ── L12 (P2) — noise_verdict.hunk element reference resolves ──────────────────

describe("noise_verdict.hunk resolves (L12 / P2)", () => {
  const noiseCtx = ctx({ lens: "noise" as LensKind });

  it("fires when a noise verdict's `hunk` references no element on the board", () => {
    const bad = board([
      el("n", "noise_verdict", {
        hunk: "ghost",
        verdict: "noise",
        reason: "Lockfile churn from the dep bump.",
        judge: "llm",
      }),
    ]);
    expect(rulesHit(lint(bad, noiseCtx))).toContain("citation-resolves");
  });

  it("fires when a noise verdict's `hunk` references a non-code_ref element", () => {
    const bad = board([
      el("n", "noise_verdict", {
        hunk: "p",
        verdict: "noise",
        reason: "Lockfile churn from the dep bump.",
        judge: "llm",
      }),
      el("p", "prose", { markdown: "not a code ref" }),
    ]);
    expect(rulesHit(lint(bad, noiseCtx))).toContain("citation-resolves");
  });

  it("passes when a noise verdict's `hunk` points at a real code_ref", () => {
    const ok = board([
      el("n", "noise_verdict", {
        hunk: "c1",
        verdict: "noise",
        reason: "Lockfile churn from the dep bump.",
        judge: "llm",
      }),
      codeRef("c1", "src/util.ts", 1, 3),
    ]);
    expect(rulesHit(lint(ok, noiseCtx))).not.toContain("citation-resolves");
  });
});

// ── S6 (P4) — decision grounding ─────────────────────────────────────────────

describe("decision-grounded (S6 / P4)", () => {
  const designCtx = ctx({ lens: "design" as LensKind });
  const decision = (over: Record<string, unknown>) =>
    board([
      el("d", "decision", {
        statement: "Injected the clock.",
        why: "Testability.",
        evidence: ["c1"],
        alternatives: ["A module-level `Date.now`."],
        ...over,
      }),
      codeRef("c1", "src/auth.ts", 11, 12),
    ]);

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

  it("accepts an honestly sparse stated ADR without invented alternatives", () => {
    const adrPath = "docs/adr/0001-store.md";
    const statedCtx = ctx({
      lens: "design",
      artifacts: [
        { candidate: "grill-adr", path: adrPath, text: "# Store events\n\nKeep the event store." },
      ],
      artifactCandidates: [{ id: "grill-adr", paths: [adrPath] }],
      files: new Map([[adrPath, 3]]),
    });
    const stated = decision({
      evidence: [],
      alternatives: [],
      inferred: false,
      source: { path: adrPath, candidate: "grill-adr", line: 1 },
    });

    const hit = rulesHit(lint(stated, statedCtx));
    expect(hit).not.toContain("decision-grounded");
    expect(hit).not.toContain("design-decision-stated");
    expect(hit).not.toContain("design-source-known");
  });
});

// ── L16 (P5) — requirement order follows the source artifact ──────────────────

describe("requirement-order (L16 / P5)", () => {
  const source =
    "R1: The system SHALL authenticate the user. R2: The system SHALL refresh the token.";
  const req = (id: string, shall: string) =>
    el(id, "requirement", { shall, coverage: "met", trace: [] });

  it("fires when requirements are rendered out of the artifact's order", () => {
    const bad = board([
      req("r1", "The system SHALL refresh the token"),
      req("r2", "The system SHALL authenticate the user"),
    ]);
    const scoped = ctx({ lens: "design" as LensKind, artifactText: source });
    expect(rulesHit(lint(bad, scoped))).toContain("requirement-order");
  });

  it("passes requirements rendered in the artifact's order", () => {
    const ok = board([
      req("r1", "The system SHALL authenticate the user"),
      req("r2", "The system SHALL refresh the token"),
    ]);
    const scoped = ctx({ lens: "design" as LensKind, artifactText: source });
    expect(rulesHit(lint(ok, scoped))).not.toContain("requirement-order");
  });

  it("tracks ordering independently for each source artifact", () => {
    const sourceReq = (id: string, shall: string, path: string) =>
      el(id, "requirement", { shall, source: { path } });
    const ok = board([
      sourceReq("a1", "The system SHALL authenticate the user", "specs/auth.md"),
      sourceReq("a2", "The system SHALL refresh the token", "specs/auth.md"),
      sourceReq("s1", "The system SHALL create a session", "specs/session.md"),
      sourceReq("s2", "The system SHALL expire the session", "specs/session.md"),
    ]);
    const scoped = ctx({
      lens: "design" as LensKind,
      artifacts: [
        {
          path: "specs/auth.md",
          text: "The system SHALL authenticate the user. Later, the system SHALL refresh the token.",
        },
        {
          path: "specs/session.md",
          text: "The system SHALL create a session. Later, the system SHALL expire the session.",
        },
      ],
    });

    expect(rulesHit(lint(ok, scoped))).not.toContain("requirement-order");
  });

  it("checks the section child order the reader actually renders", () => {
    const bad = board([
      el("section", "section", { title: "Requirements", children: ["r2", "r1"] }),
      req("r1", "The system SHALL authenticate the user"),
      req("r2", "The system SHALL refresh the token"),
    ]);
    const scoped = ctx({ lens: "design" as LensKind, artifactText: source });

    expect(rulesHit(lint(bad, scoped))).toContain("requirement-order");
  });

  it("passes visible source order even when pool storage order differs", () => {
    const ok = board([
      el("section", "section", { title: "Requirements", children: ["r1", "r2"] }),
      req("r2", "The system SHALL refresh the token"),
      req("r1", "The system SHALL authenticate the user"),
    ]);
    const scoped = ctx({ lens: "design" as LensKind, artifactText: source });

    expect(rulesHit(lint(ok, scoped))).not.toContain("requirement-order");
  });

  it("degrades to a no-op without the source artifact", () => {
    const bad = board([
      req("r1", "The system SHALL refresh the token"),
      req("r2", "The system SHALL authenticate the user"),
    ]);
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
  it("does not treat a root-level OpenSpec source artifact as scaffold", () => {
    const bad = board([codeRef("c", "openspec/changes/x/proposal.md", 1, 1)]);
    const scoped = ctx({ files: new Map([["openspec/changes/x/proposal.md", 10]]) });
    expect(rulesHit(lint(bad, scoped))).not.toContain("scaffold-is-noise-lane");
  });

  it("fires on a root-level lockfile and `.openspec.yaml`", () => {
    const lock = board([codeRef("c", "pnpm-lock.yaml", 1, 1)]);
    const lockCtx = ctx({ files: new Map([["pnpm-lock.yaml", 9000]]) });
    expect(rulesHit(lint(lock, lockCtx))).toContain("scaffold-is-noise-lane");

    const stamp = board([codeRef("c", ".openspec.yaml", 1, 1)]);
    const stampCtx = ctx({ files: new Map([[".openspec.yaml", 5]]) });
    expect(rulesHit(lint(stamp, stampCtx))).toContain("scaffold-is-noise-lane");
  });
});
