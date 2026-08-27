import type { DraftBoard, DraftElement, LensKind } from "@rennet/protocol";
import { parseDraft } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCAFFOLD_GLOBS, type LintContext, type LintHunk, lint } from "./lint";

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

// ── Parse-time (S1/S2 — the frozen schema retires the rule) ──────────────────

describe("parse-time schema constraints (S1/S2 — R17 at parse time, F1)", () => {
  it("rejects a `code` element kind with ZodError-shaped issues (no code bytes)", () => {
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

// ── L17 report-coherent (round_outcome) ──────────────────────────────────────

describe("report-coherent (L17 / R57)", () => {
  const outcome = (id: string, status: string, ask: { ref: string; text: string }, note: string) =>
    el(id, "round_outcome", { status, ask, note });

  it("fires when round items are out of sort order", () => {
    const bad = board(
      [
        outcome("o1", "beyond", { ref: "", text: "" }, "Hardened the token path proactively."),
        outcome("o2", "addressed", { ref: "a1", text: "fix auth" }, "Done."),
      ],
      { skippedHunks: [] },
    );
    expect(rulesHit(lint(bad, ctx()))).toContain("report-coherent");
  });

  it("fires when a `beyond` item carries an ask ref instead of a note", () => {
    const bad = board([outcome("o1", "beyond", { ref: "a1", text: "x" }, "")], {
      skippedHunks: [],
    });
    expect(rulesHit(lint(bad, ctx()))).toContain("report-coherent");
  });

  it("passes well-sorted, status-coherent items", () => {
    const ok = board(
      [
        outcome("o1", "addressed", { ref: "a1", text: "fix auth" }, "Done."),
        outcome("o2", "beyond", { ref: "", text: "" }, "Also hardened the refresh path."),
      ],
      { skippedHunks: [] },
    );
    expect(rulesHit(lint(ok, ctx()))).not.toContain("report-coherent");
  });
});

// ── L13 requirement-verbatim (degrades without the source) ───────────────────

describe("requirement-verbatim (L13 / anti-paraphrase)", () => {
  const reqBoard = (shall: string) =>
    board([el("r", "requirement", { shall, coverage: "met", trace: [] })], { skippedHunks: [] });

  it("fires when the shall text is not a verbatim substring of the source", () => {
    const scoped = ctx({
      lens: "decisions" as LensKind,
      artifactText: "The system SHALL refresh the token before classifying an error.",
    });
    expect(rulesHit(lint(reqBoard("The system SHALL rotate tokens hourly"), scoped))).toContain(
      "requirement-verbatim",
    );
  });

  it("passes verbatim (whitespace-normalized) shall text", () => {
    const scoped = ctx({
      lens: "decisions" as LensKind,
      artifactText: "The system SHALL refresh the token before classifying an error.",
    });
    expect(rulesHit(lint(reqBoard("The system SHALL refresh the token"), scoped))).not.toContain(
      "requirement-verbatim",
    );
  });

  it("degrades to no-op when the caller supplies no artifact text", () => {
    const scoped = ctx({ lens: "decisions" as LensKind });
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
});
