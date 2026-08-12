import type { OwnershipRule, PatchFile } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { type BlastRadiusInput, computeBlastRadius } from "./blast-radius";

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
): ReturnType<typeof computeBlastRadius> {
  const input: BlastRadiusInput = { files, ownership };
  return computeBlastRadius(input);
}
const of = (paint: ReturnType<typeof computeBlastRadius>, signal: string) =>
  paint.filter((p) => p.signal === signal);

// ── neighbour cases: renames (probed, issue #35 / the #16 habit) ──────────────
describe("blast radius — rename neighbour cases", () => {
  it("deletions fires on a RENAME — the old path is gone, importers must update", () => {
    const paint = run([
      file("packages/b/new.ts", { status: "renamed", previousPath: "packages/a/old.ts" }),
    ]);
    const del = of(paint, "deletions");
    expect(del).toHaveLength(1);
    expect(del[0]?.target).toBe("rennet:file/packages/b/new.ts");
    expect(del[0]?.reason).toMatch(/renamed from packages\/a\/old\.ts/i);
  });

  it("codeowners counts BOTH owners on a cross-owner rename (single file spans two groups)", () => {
    const ownership: OwnershipRule[] = [
      { pattern: "packages/a/**", owners: ["@team-a"] },
      { pattern: "packages/b/**", owners: ["@team-b"] },
    ];
    const paint = run(
      [file("packages/b/new.ts", { status: "renamed", previousPath: "packages/a/old.ts" })],
      ownership,
    );
    const co = of(paint, "codeowners");
    expect(co).toHaveLength(1);
    expect(co[0]?.reason).toContain("@team-a");
    expect(co[0]?.reason).toContain("@team-b");
    expect(co[0]?.reason).toContain("2 code-owner groups");
  });

  it("a renamed TEST file does NOT fire safety-net (coverage moved, not lost)", () => {
    const paint = run([
      file("src/new.test.ts", { status: "renamed", previousPath: "src/old.test.ts" }),
    ]);
    expect(of(paint, "safety-net")).toHaveLength(0);
  });
});

// ── deletions ─────────────────────────────────────────────────────────────────
describe("blast radius — deletions", () => {
  it("marks a deleted file, with its own one-line reason and target", () => {
    const paint = run([file("src/gone.ts", { status: "deleted", deletions: 12 })]);
    const del = of(paint, "deletions");
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
    const paint = run([file("db/migrations/001_init.sql", { patch: hunk("CREATE TABLE x ();") })]);
    expect(of(paint, "irreversibility")).toHaveLength(1);
  });

  it("marks a destructive SQL statement in the added lines", () => {
    const paint = run([
      file("src/repo.ts", { patch: hunk("await db.query('DROP TABLE users');") }),
    ]);
    const irr = of(paint, "irreversibility");
    expect(irr).toHaveLength(1);
    expect(irr[0]?.reason).toMatch(/destructive/i);
  });

  it("does NOT mark an ordinary code change", () => {
    const paint = run([file("src/util.ts", { patch: hunk("export const x = 1;") })]);
    expect(of(paint, "irreversibility")).toHaveLength(0);
  });
});

// ── CODEOWNERS overlap ────────────────────────────────────────────────────────
describe("blast radius — codeowners overlap", () => {
  const ownership: OwnershipRule[] = [
    { pattern: "packages/a/**", owners: ["@team-a"] },
    { pattern: "packages/b/**", owners: ["@team-b"] },
  ];

  it("marks every owned file when the change spans two owner groups", () => {
    const paint = run([file("packages/a/x.ts"), file("packages/b/y.ts")], ownership);
    const co = of(paint, "codeowners");
    expect(co).toHaveLength(2);
    expect(co.some((p) => p.reason?.includes("@team-a"))).toBe(true);
    expect(co.some((p) => p.reason?.includes("@team-b"))).toBe(true);
    expect(co.every((p) => p.reason?.includes("2 code-owner groups"))).toBe(true);
  });

  it("does NOT fire when the change stays within one owner group", () => {
    const paint = run([file("packages/a/x.ts"), file("packages/a/z.ts")], ownership);
    expect(of(paint, "codeowners")).toHaveLength(0);
  });

  it("last matching rule wins (git CODEOWNERS semantics)", () => {
    const rules: OwnershipRule[] = [
      { pattern: "*", owners: ["@default"] },
      { pattern: "packages/b/**", owners: ["@team-b"] },
    ];
    // a.ts → @default (catch-all), b/y.ts → @team-b (more specific, later) → two groups.
    const paint = run([file("a.ts"), file("packages/b/y.ts")], rules);
    const co = of(paint, "codeowners");
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
    const paint = run([
      file("src/x.ts", { patch: hunk("// eslint-disable-next-line no-explicit-any") }),
    ]);
    expect(of(paint, "safety-net").some((p) => /disables a linter/.test(p.reason ?? ""))).toBe(
      true,
    );
  });

  it("marks a skipped/narrowed test", () => {
    const paint = run([file("src/x.test.ts", { patch: hunk("it.skip('later', () => {});") })]);
    expect(of(paint, "safety-net").some((p) => /skips or narrows/.test(p.reason ?? ""))).toBe(true);
  });

  it("marks a CI config change", () => {
    const paint = run([file(".github/workflows/ci.yml", { patch: hunk("  - run: echo hi") })]);
    expect(of(paint, "safety-net").some((p) => /CI configuration/.test(p.reason ?? ""))).toBe(true);
  });

  it("does NOT fire on an ordinary mock of a non-security module", () => {
    const paint = run([file("src/format.test.ts", { patch: hunk("vi.mock('../format');") })]);
    expect(of(paint, "safety-net").some((p) => /mock/.test(p.reason ?? ""))).toBe(false);
  });

  it("binds the security match to the mocked SPECIFIER, not a stray word in the hunk (F5)", () => {
    // The mocked module is `../format` (not security). The word "token" appears
    // independently, on an UNRELATED line. The old code searched the whole added text
    // for a security word, so this false-fired "a mock on a security/auth path".
    // Red-proof: revert to `SECURITY_HINT.test(added)` and this reddens.
    const paint = run([
      file("src/checkout.ts", {
        patch: hunk("vi.mock('../format');", "const token = readToken();"),
      }),
    ]);
    expect(of(paint, "safety-net").some((p) => /mock on a security/.test(p.reason ?? ""))).toBe(
      false,
    );
  });

  it("still fires when the mocked SPECIFIER itself is security-related", () => {
    // Control that the F5 fix did not simply delete the signal: a mock of an auth
    // module fires on the specifier alone, no security word needed elsewhere.
    const paint = run([file("src/checkout.ts", { patch: hunk("vi.mock('../auth/session');") })]);
    expect(of(paint, "safety-net").some((p) => /mock on a security/.test(p.reason ?? ""))).toBe(
      true,
    );
  });

  it("does NOT count @ts-expect-error as disabling a check (it asserts one, F5)", () => {
    // `@ts-expect-error` is the OPPOSITE of a disable: it fails if the error goes away.
    // Red-proof: put `expect-error` back in LINT_DISABLE and this reddens.
    const paint = run([file("src/x.ts", { patch: hunk("// @ts-expect-error not yet typed") })]);
    expect(of(paint, "safety-net").some((p) => /disables a linter/.test(p.reason ?? ""))).toBe(
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
    // A blast-radius mark's reason renders inline beside the amber; a multi-line reason
    // would break that. Fire several signals at once and assert each reason is one line.
    // Red-proof: append "\n" to any assessed reason string and this reddens.
    const paint = run(
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
    const assessed = paint.filter((p) => p.assessed !== false);
    // Cover every assessed signal kind, including safety-net.
    expect(new Set(assessed.map((p) => p.signal)).size).toBeGreaterThan(1);
    expect(assessed.some((p) => p.signal === "safety-net")).toBe(true);
    expect(assessed.every((p) => !(p.reason ?? "").includes("\n"))).toBe(true);
  });
});

// ── the honesty property: deferred signals are visibly NOT ASSESSED ───────────
describe("blast radius — deferred signals surface as NOT ASSESSED", () => {
  it("always emits fan-in and contract-surface as not assessed, even for an empty changeset", () => {
    const paint = run([]);
    const fanIn = paint.find((p) => p.signal === "fan-in");
    const contract = paint.find((p) => p.signal === "contract-surface");
    expect(fanIn?.assessed).toBe(false);
    expect(fanIn?.reason).toMatch(/not assessed/i);
    expect(contract?.assessed).toBe(false);
    expect(contract?.reason).toMatch(/not assessed/i);
    // The honesty invariant: no amber does NOT mean "checked and clear" — the two
    // unmeasured signals are always present so the reviewer sees them as unmeasured.
    expect(paint.filter((p) => p.assessed === false)).toHaveLength(2);
  });

  it("never invents a churn-heat signal", () => {
    const paint = run([file("src/x.ts", { patch: hunk("x".repeat(50)) })]);
    expect(paint.some((p) => String(p.signal).includes("churn"))).toBe(false);
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

  it("returns paint sorted by (target, signal, reason)", () => {
    const paint = run([
      file("src/z.ts", { status: "deleted" }),
      file("src/a.ts", { patch: hunk("// @ts-ignore") }),
    ]);
    const keys = paint.map((p) => `${p.target} ${p.signal ?? ""} ${p.reason ?? ""}`);
    expect(keys).toEqual([...keys].sort());
  });
});
