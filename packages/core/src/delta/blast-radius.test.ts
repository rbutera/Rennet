import type { OwnershipRule, PatchFile } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { type BlastRadiusInput, computeBlastRadius, type FanInIndex } from "./blast-radius";

/** A fake fan-in index: files' defined symbols, and which files reference each name. */
function fakeFanIn(
  defined: Record<string, string[]>,
  referencedBy: Record<string, string[]>,
): FanInIndex {
  return {
    method: "textual",
    definedSymbols: (path) => defined[path] ?? [],
    referencingFiles: (name) => referencedBy[name] ?? [],
  };
}

/** A fake EDGE-BACKED fan-in index: which files import each file. */
function fakeImportFanIn(importedBy: Record<string, string[]>): FanInIndex {
  return { method: "import-edges", importersOf: (path) => importedBy[path] ?? [] };
}

function file(path: string, over: Partial<PatchFile> = {}): PatchFile {
  return {
    path,
    status: "modified",
    additions: null,
    deletions: null,
    binary: false,
    patch: "",
    ...over,
  };
}
function hunk(...added: string[]): string {
  return `@@ -0,0 +1,${added.length} @@\n${added.map((line) => `+${line}`).join("\n")}`;
}
function run(
  files: PatchFile[],
  ownership: OwnershipRule[] = [],
  fanIn?: FanInIndex,
): ReturnType<typeof computeBlastRadius> {
  const input: BlastRadiusInput = { files, ownership, ...(fanIn ? { fanIn } : {}) };
  return computeBlastRadius(input);
}
const of = (marks: ReturnType<typeof computeBlastRadius>, signal: string) =>
  marks.filter((p) => p.signal === signal);

// ── neighbour cases: renames (probed, issue #35 / the #16 habit) ──────────────
describe("blast radius — rename neighbour cases", () => {
  it("deletions fires on a RENAME — the old path is gone, importers must update", () => {
    const marks = run([
      file("packages/b/new.ts", { status: "renamed", previousPath: "packages/a/old.ts" }),
    ]);
    const del = of(marks, "deletions");
    expect(del).toHaveLength(1);
    expect(del[0]?.target).toBe("rennet:file/packages/b/new.ts");
    expect(del[0]?.reason).toMatch(/renamed from packages\/a\/old\.ts/i);
  });

  it("codeowners counts BOTH owners on a cross-owner rename (single file spans two groups)", () => {
    const ownership: OwnershipRule[] = [
      { pattern: "packages/a/**", owners: ["@team-a"] },
      { pattern: "packages/b/**", owners: ["@team-b"] },
    ];
    const marks = run(
      [file("packages/b/new.ts", { status: "renamed", previousPath: "packages/a/old.ts" })],
      ownership,
    );
    const co = of(marks, "codeowners");
    expect(co).toHaveLength(1);
    expect(co[0]?.reason).toContain("@team-a");
    expect(co[0]?.reason).toContain("@team-b");
    expect(co[0]?.reason).toContain("2 code-owner groups");
  });

  it("a renamed TEST file does NOT fire safety-net (coverage moved, not lost)", () => {
    const marks = run([
      file("src/new.test.ts", { status: "renamed", previousPath: "src/old.test.ts" }),
    ]);
    expect(of(marks, "safety-net")).toHaveLength(0);
  });
});

// ── deletions ─────────────────────────────────────────────────────────────────
describe("blast radius — deletions", () => {
  it("marks a deleted file, with its own one-line reason and target", () => {
    const marks = run([file("src/gone.ts", { status: "deleted", deletions: 12 })]);
    const del = of(marks, "deletions");
    expect(del).toHaveLength(1);
    expect(del[0]?.target).toBe("rennet:file/src/gone.ts");
    expect(del[0]?.assessed).toBe(true);
    expect(del[0]?.reason).toContain("deleted");
    expect(del[0]?.reason).toContain("12 lines");
  });
});

// ── irreversibility ───────────────────────────────────────────────────────────
describe("blast radius — irreversibility", () => {
  it("marks a migration/schema path", () => {
    const marks = run([file("db/migrations/001_init.sql", { patch: hunk("CREATE TABLE x ();") })]);
    expect(of(marks, "irreversibility")).toHaveLength(1);
  });

  it("marks a destructive SQL statement in the added lines", () => {
    const marks = run([
      file("src/repo.ts", { patch: hunk("await db.query('DROP TABLE users');") }),
    ]);
    const irr = of(marks, "irreversibility");
    expect(irr).toHaveLength(1);
    expect(irr[0]?.reason).toMatch(/destructive/i);
  });

  it("does NOT mark an ordinary code change", () => {
    const marks = run([file("src/util.ts", { patch: hunk("export const x = 1;") })]);
    expect(of(marks, "irreversibility")).toHaveLength(0);
  });
});

// ── CODEOWNERS overlap ────────────────────────────────────────────────────────
describe("blast radius — codeowners overlap", () => {
  const ownership: OwnershipRule[] = [
    { pattern: "packages/a/**", owners: ["@team-a"] },
    { pattern: "packages/b/**", owners: ["@team-b"] },
  ];

  it("marks every owned file when the change spans two owner groups", () => {
    const marks = run([file("packages/a/x.ts"), file("packages/b/y.ts")], ownership);
    const co = of(marks, "codeowners");
    expect(co).toHaveLength(2);
    expect(co.some((p) => p.reason?.includes("@team-a"))).toBe(true);
    expect(co.some((p) => p.reason?.includes("@team-b"))).toBe(true);
    expect(co.every((p) => p.reason?.includes("2 code-owner groups"))).toBe(true);
  });

  it("does NOT fire when the change stays within one owner group", () => {
    const marks = run([file("packages/a/x.ts"), file("packages/a/z.ts")], ownership);
    expect(of(marks, "codeowners")).toHaveLength(0);
  });

  it("treats a literal `?` in a CODEOWNERS pattern as a literal, not a quantifier (#279)", () => {
    // With `?` unescaped it compiles as a quantifier: `packages/ab?/**` becomes `ab?`
    // = optional `b`, which WRONGLY matches `packages/a/x.ts` and (being the last rule to
    // match it) shows @wrong as its owner. Escaped, `ab?` is a literal that only matches a
    // path with a real `?` in it, so `packages/a/x.ts` keeps @team-a.
    const rules: OwnershipRule[] = [
      { pattern: "packages/a/**", owners: ["@team-a"] },
      { pattern: "packages/ab?/**", owners: ["@wrong"] },
      { pattern: "packages/c/**", owners: ["@team-c"] },
    ];
    const marks = run([file("packages/a/x.ts"), file("packages/c/y.ts")], rules);
    const co = of(marks, "codeowners");
    const forA = co.find((p) => p.target === "rennet:file/packages/a/x.ts");
    expect(forA?.reason).toContain("@team-a");
    expect(forA?.reason).not.toContain("@wrong");
  });

  it("last matching rule wins (git CODEOWNERS semantics)", () => {
    const rules: OwnershipRule[] = [
      { pattern: "*", owners: ["@default"] },
      { pattern: "packages/b/**", owners: ["@team-b"] },
    ];
    // a.ts → @default (catch-all), b/y.ts → @team-b (more specific, later) → two groups.
    const marks = run([file("a.ts"), file("packages/b/y.ts")], rules);
    const co = of(marks, "codeowners");
    expect(
      co.some((p) => p.target === "rennet:file/packages/b/y.ts" && p.reason?.includes("@team-b")),
    ).toBe(true);
    expect(co.some((p) => p.target === "rennet:file/a.ts" && p.reason?.includes("@default"))).toBe(
      true,
    );
  });
});

// ── safety-net — the acceptance-criteria fixture ──────────────────────────────
describe("blast radius — safety-net", () => {
  it("fires on a fixture deleting a test AND mocking an auth path (issue #35 AC)", () => {
    const files = [
      file("src/auth/session.test.ts", { status: "deleted" }),
      file("src/checkout.ts", { patch: hunk("vi.mock('../auth/session');") }),
    ];
    const sn = of(run(files), "safety-net");
    expect(
      sn.some(
        (p) =>
          p.target === "rennet:file/src/auth/session.test.ts" &&
          /deletes a test/.test(p.reason ?? ""),
      ),
    ).toBe(true);
    expect(
      sn.some(
        (p) =>
          p.target === "rennet:file/src/checkout.ts" &&
          /mock on a security\/auth/.test(p.reason ?? ""),
      ),
    ).toBe(true);
  });

  it("marks a lint/type-check disable", () => {
    const marks = run([
      file("src/x.ts", { patch: hunk("// eslint-disable-next-line no-explicit-any") }),
    ]);
    expect(of(marks, "safety-net").some((p) => /disables a linter/.test(p.reason ?? ""))).toBe(
      true,
    );
  });

  it("marks a skipped/narrowed test", () => {
    const marks = run([file("src/x.test.ts", { patch: hunk("it.skip('later', () => {});") })]);
    expect(of(marks, "safety-net").some((p) => /skips or narrows/.test(p.reason ?? ""))).toBe(true);
  });

  it("does NOT fire on a purely ADDITIVE CI change — adding coverage strengthens the net (#278)", () => {
    // A CI change with only `+` lines adds a check; it does not weaken the safety net.
    // The old code fired "changes CI configuration" under a "Weakens the safety net"
    // headline — a direction the matcher never established.
    const marks = run([file(".github/workflows/ci.yml", { patch: hunk("  - run: echo hi") })]);
    expect(of(marks, "safety-net")).toHaveLength(0);
  });

  it("fires 'removes CI configuration' when a CI change REMOVES content (#278)", () => {
    // A CI change that deletes a line is the weakening direction — and the wording says
    // what was matched (removed), not the neutral "changed".
    const marks = run([
      file(".github/workflows/ci.yml", {
        patch: "@@ -1,2 +1,1 @@\n   - run: pnpm test\n-  - run: pnpm typecheck",
      }),
    ]);
    expect(
      of(marks, "safety-net").some((p) => /removes CI configuration/.test(p.reason ?? "")),
    ).toBe(true);
  });

  it("does NOT fire on an ordinary mock of a non-security module", () => {
    const marks = run([file("src/format.test.ts", { patch: hunk("vi.mock('../format');") })]);
    expect(of(marks, "safety-net").some((p) => /mock/.test(p.reason ?? ""))).toBe(false);
  });

  it("binds the security match to the mocked SPECIFIER, not a stray word in the hunk (F5)", () => {
    // The mocked module is `../format` (not security). The word "token" appears
    // independently, on an UNRELATED line. The old code searched the whole added text
    // for a security word, so this false-fired "a mock on a security/auth path".
    // Red-proof: revert to `SECURITY_HINT.test(added)` and this reddens.
    const marks = run([
      file("src/checkout.ts", {
        patch: hunk("vi.mock('../format');", "const token = readToken();"),
      }),
    ]);
    expect(of(marks, "safety-net").some((p) => /mock on a security/.test(p.reason ?? ""))).toBe(
      false,
    );
  });

  it("still fires when the mocked SPECIFIER itself is security-related", () => {
    // Control that the F5 fix did not simply delete the signal: a mock of an auth
    // module fires on the specifier alone, no security word needed elsewhere.
    const marks = run([file("src/checkout.ts", { patch: hunk("vi.mock('../auth/session');") })]);
    expect(of(marks, "safety-net").some((p) => /mock on a security/.test(p.reason ?? ""))).toBe(
      true,
    );
  });

  it("does NOT count @ts-expect-error as disabling a check (it asserts one, F5)", () => {
    // `@ts-expect-error` is the OPPOSITE of a disable: it fails if the error goes away.
    // Red-proof: put `expect-error` back in LINT_DISABLE and this reddens.
    const marks = run([file("src/x.ts", { patch: hunk("// @ts-expect-error not yet typed") })]);
    expect(of(marks, "safety-net").some((p) => /disables a linter/.test(p.reason ?? ""))).toBe(
      false,
    );
  });

  it("still counts @ts-ignore and @ts-nocheck as disabling a check", () => {
    const ignore = run([file("src/x.ts", { patch: hunk("// @ts-ignore legacy") })]);
    expect(of(ignore, "safety-net").some((p) => /disables a linter/.test(p.reason ?? ""))).toBe(
      true,
    );
    const nocheck = run([file("src/y.ts", { patch: hunk("// @ts-nocheck") })]);
    expect(of(nocheck, "safety-net").some((p) => /disables a linter/.test(p.reason ?? ""))).toBe(
      true,
    );
  });

  it("every assessed reason is a single line — no newline (F6 one-line guarantee)", () => {
    // A blast-radius mark's reason renders inline beside the mark; a multi-line reason
    // would break that. Fire several signals at once and assert each reason is one line.
    // Red-proof: append "\n" to any assessed reason string and this reddens.
    const marks = run(
      [
        file("db/migrations/x.sql", { patch: hunk("DROP TABLE t;") }),
        file("packages/a/gone.ts", { status: "deleted", deletions: 4 }),
        // A safety-net trigger, so the safety-net reason (where multi-signal joining
        // happens) is exercised by this guard, not just the single-signal reasons.
        file("packages/b/y.ts", { patch: hunk("// @ts-ignore legacy") }),
      ],
      [
        { pattern: "packages/a/**", owners: ["@team-a"] },
        { pattern: "packages/b/**", owners: ["@team-b"] },
      ],
    );
    const assessed = marks.filter((p) => p.assessed !== false);
    // Cover every assessed signal kind, including safety-net.
    expect(new Set(assessed.map((p) => p.signal)).size).toBeGreaterThan(1);
    expect(assessed.some((p) => p.signal === "safety-net")).toBe(true);
    expect(assessed.every((p) => !(p.reason ?? "").includes("\n"))).toBe(true);
  });
});

// ── the honesty property: deferred signals are visibly NOT ASSESSED ───────────
describe("blast radius — deferred signals surface as NOT ASSESSED", () => {
  it("always emits fan-in and contract-surface as not assessed, even for an empty changeset", () => {
    const marks = run([]);
    const fanIn = marks.find((p) => p.signal === "fan-in");
    const contract = marks.find((p) => p.signal === "contract-surface");
    expect(fanIn?.assessed).toBe(false);
    expect(fanIn?.reason).toMatch(/not assessed/i);
    expect(contract?.assessed).toBe(false);
    expect(contract?.reason).toMatch(/not assessed/i);
    // The honesty invariant: no mark does NOT mean "checked and clear" — the two
    // unmeasured signals are always present so the reviewer sees them as unmeasured.
    expect(marks.filter((p) => p.assessed === false)).toHaveLength(2);
  });

  it("never invents a churn-heat signal", () => {
    const marks = run([file("src/x.ts", { patch: hunk("x".repeat(50)) })]);
    expect(marks.some((p) => String(p.signal).includes("churn"))).toBe(false);
  });
});

// ── fan-in (#200): assessed dependent counts, and the honest-absence guard ─────
describe("blast radius — fan-in", () => {
  it("counts the DISTINCT other files that reference a changed file's symbols (#200)", () => {
    // src/a.ts defines `foo` and `bar`; foo is referenced by b + c, bar by c + d.
    // Dependents of a.ts = {b, c, d} = 3 distinct files (deduped across symbols).
    const fanIn = fakeFanIn(
      { "src/a.ts": ["foo", "bar"] },
      { foo: ["src/b.ts", "src/c.ts"], bar: ["src/c.ts", "src/d.ts"] },
    );
    const marks = run([file("src/a.ts", { patch: hunk("export const foo = 1;") })], [], fanIn);
    const perFile = of(marks, "fan-in").filter((p) => p.target === "rennet:file/src/a.ts");
    expect(perFile).toHaveLength(1);
    expect(perFile[0]?.assessed).toBe(true);
    expect(perFile[0]?.reason).toMatch(/^3 files reference/);
    // Fan-in is now ASSESSED, so it is NOT among the not-assessed chips (only contract-surface is).
    expect(marks.filter((p) => p.assessed === false).map((p) => p.signal)).toEqual([
      "contract-surface",
    ]);
  });

  it("does NOT count a file's references to its OWN symbols", () => {
    const fanIn = fakeFanIn({ "src/a.ts": ["foo"] }, { foo: ["src/a.ts"] });
    const marks = run([file("src/a.ts", { patch: hunk("export const foo = 1;") })], [], fanIn);
    // Zero external dependents ⇒ no PER-FILE fan-in marks (checked, nothing depends on it).
    expect(of(marks, "fan-in").filter((p) => p.target.startsWith("rennet:file/"))).toHaveLength(0);
  });

  it("a zero-dependent review is still EXPLICITLY assessed, never mere silence", () => {
    // The honesty property one layer out: when the index IS supplied but every changed
    // file has zero dependents, fan-in must announce "assessed, zero dependents" as a
    // positive fact — NOT the same empty result a review would show if this producer had
    // never run. So the index-supplied path always emits an assessed:true review-level
    // marker, distinct from both the per-file paints (none, here) and the not-assessed
    // absent chip (which must NOT appear when the index is present).
    // Red-proof: delete the review-level `assessed:true` push from the fanIn branch and
    // this reddens — the zero-dependent review then carries no fan-in entry at all,
    // indistinguishable from "producer never ran".
    const fanIn = fakeFanIn({ "src/a.ts": ["foo"] }, { foo: ["src/a.ts"] });
    const marks = run([file("src/a.ts", { patch: hunk("export const foo = 1;") })], [], fanIn);
    const marker = marks.find(
      (p) => p.signal === "fan-in" && p.target === "rennet:review/blast-radius",
    );
    expect(marker?.assessed).toBe(true);
    expect(marker?.reason).toMatch(/assessed/i);
    // And the not-assessed absent chip must NOT be present when the index was supplied.
    expect(marks.some((p) => p.signal === "fan-in" && p.assessed === false)).toBe(false);
  });

  it("singular wording for exactly one dependent", () => {
    const fanIn = fakeFanIn({ "src/a.ts": ["foo"] }, { foo: ["src/b.ts"] });
    const marks = run([file("src/a.ts")], [], fanIn);
    const perFile = of(marks, "fan-in").filter((p) => p.target === "rennet:file/src/a.ts");
    expect(perFile[0]?.reason).toMatch(/^1 file reference/);
  });

  it("stays NOT ASSESSED when no index is supplied — never a silent zero (#200 guard)", () => {
    const marks = run([file("src/a.ts", { patch: hunk("export const foo = 1;") })]);
    const fi = marks.find((p) => p.signal === "fan-in");
    expect(fi?.assessed).toBe(false);
    expect(fi?.reason).toMatch(/not assessed/i);
  });

  it("counts real IMPORTERS when the index is edge-backed, and says so", () => {
    const fanIn = fakeImportFanIn({ "src/a.ts": ["src/b.ts", "src/c.ts"] });
    const marks = run([file("src/a.ts", { patch: hunk("export const foo = 1;") })], [], fanIn);
    const perFile = of(marks, "fan-in").filter((p) => p.target === "rennet:file/src/a.ts");
    expect(perFile).toHaveLength(1);
    // The wording is the honesty: "import this file" is a stronger, provable claim
    // than "reference this file's symbols", and only the edge-backed arm may make it.
    expect(perFile[0]?.reason).toMatch(/^2 files import this file/);
    const marker = marks.find(
      (p) => p.signal === "fan-in" && p.target === "rennet:review/blast-radius",
    );
    expect(marker?.reason).toMatch(/import graph/i);
  });

  it("a textual index never claims the import-graph wording", () => {
    const fanIn = fakeFanIn({ "src/a.ts": ["foo"] }, { foo: ["src/b.ts"] });
    const marks = run([file("src/a.ts")], [], fanIn);
    expect(of(marks, "fan-in").some((p) => /import this file/.test(p.reason ?? ""))).toBe(false);
    const marker = marks.find(
      (p) => p.signal === "fan-in" && p.target === "rennet:review/blast-radius",
    );
    expect(marker?.reason).toMatch(/identifier-occurrence/i);
  });

  it("an edge-backed index does NOT count a file as its own importer", () => {
    const fanIn = fakeImportFanIn({ "src/a.ts": ["src/a.ts"] });
    const marks = run([file("src/a.ts")], [], fanIn);
    expect(of(marks, "fan-in").filter((p) => p.target.startsWith("rennet:file/"))).toHaveLength(0);
  });
});

// ── determinism ───────────────────────────────────────────────────────────────
describe("blast radius — deterministic and sorted", () => {
  it("is a pure function: identical input yields identical output", () => {
    const build = () =>
      run(
        [
          file("src/a.ts", { status: "deleted", deletions: 3 }),
          file("db/migrations/x.sql", { patch: hunk("DROP TABLE t") }),
        ],
        [{ pattern: "*", owners: ["@x"] }],
      );
    expect(build()).toEqual(build());
  });

  it("returns marks sorted by (target, signal, reason)", () => {
    const marks = run([
      file("src/z.ts", { status: "deleted" }),
      file("src/a.ts", { patch: hunk("// @ts-ignore") }),
    ]);
    const keys = marks.map((p) => `${p.target} ${p.signal ?? ""} ${p.reason ?? ""}`);
    expect(keys).toEqual([...keys].sort());
  });
});
