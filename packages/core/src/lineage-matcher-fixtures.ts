import type { LineageFixture, MatchOccurrence } from "./lineage-matcher";

// ── Lineage matcher measurement fixtures (issue #16, spike 1) ────────────────
//
// Self-authored, synthetic patchset pairs — one per mutation class, plus mixed
// and adversarial cases. ⛔ No client PRs, ever (spike rule). Each fixture pairs
// a prior occurrence set with a successor set produced by a KNOWN transformation;
// `truth` records the transformation actually applied, so a measured mismatch is
// an honest miss, not a moved goalpost. Bodies are realistic small TS so the
// line-similarity signal is exercised as it would be on real code.
//
// A handful are deliberately adversarial (near-duplicate helpers, rename+edit,
// identical-body duplication) — cases whose classification is NOT pre-decided to
// flatter the matcher. Their truth is the semantics of the edit; if the matcher
// disagrees, the tables report it.

function occ(
  id: string,
  path: string,
  body: string,
  extra: Partial<Omit<MatchOccurrence, "id" | "path" | "body">> = {},
): MatchOccurrence {
  return { id, path, body, ...extra };
}

// Reusable bodies.
const ADD = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const SUB = "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
const MUL = "export function mul(a: number, b: number): number {\n  return a * b;\n}\n";
const HANDLER = "export default function handler() {\n  return { ok: true };\n}\n";

export const LINEAGE_FIXTURES: readonly LineageFixture[] = [
  // 1. No-op re-capture (force-push with no change): every occurrence exact.
  {
    name: "unchanged-recapture",
    mutationClass: "exact (unchanged)",
    prior: [occ("a1", "src/math.ts", ADD), occ("s1", "src/math.ts", SUB)],
    successor: [occ("a2", "src/math.ts", ADD), occ("s2", "src/math.ts", SUB)],
    truth: [
      { fromId: "a1", lineage: "exact", toId: "a2" },
      { fromId: "s1", lineage: "exact", toId: "s2" },
    ],
  },

  // 2. Pure file rename, byte-identical content: a move.
  {
    name: "pure-rename",
    mutationClass: "move (rename)",
    prior: [occ("p1", "src/arithmetic.ts", ADD, { context: "// arithmetic module" })],
    successor: [occ("q1", "src/math/basic.ts", ADD, { context: "// arithmetic module" })],
    truth: [{ fromId: "p1", lineage: "move", toId: "q1" }],
  },

  // 3. Directory move, identical content, several occurrences.
  {
    name: "dir-move",
    mutationClass: "move (dir)",
    prior: [
      occ("p1", "lib/ops.ts", ADD, { context: "add block" }),
      occ("p2", "lib/ops.ts", MUL, { context: "mul block" }),
    ],
    successor: [
      occ("q1", "core/lib/ops.ts", ADD, { context: "add block" }),
      occ("q2", "core/lib/ops.ts", MUL, { context: "mul block" }),
    ],
    truth: [
      { fromId: "p1", lineage: "move", toId: "q1" },
      { fromId: "p2", lineage: "move", toId: "q2" },
    ],
  },

  // 4. Body edit in place: one-to-one (reopens, does not carry).
  {
    name: "body-edit",
    mutationClass: "one-to-one (edit)",
    prior: [occ("p1", "src/math.ts", ADD)],
    successor: [
      occ(
        "q1",
        "src/math.ts",
        "export function add(a: number, b: number): number {\n  const sum = a + b;\n  return sum;\n}\n",
      ),
    ],
    truth: [{ fromId: "p1", lineage: "one-to-one", toId: "q1" }],
  },

  // 5. Whitespace-only change: NOT exact (byte-identity floor). Truth = one-to-one:
  //    it reopens rather than auto-carrying, which is the whole point of the floor.
  {
    name: "whitespace-only",
    mutationClass: "one-to-one (whitespace)",
    prior: [occ("p1", "src/math.ts", ADD)],
    successor: [occ("q1", "src/math.ts", `${ADD}\n`)],
    truth: [{ fromId: "p1", lineage: "one-to-one", toId: "q1" }],
  },

  // 6. Rename AND edit: content changed, so it must NOT be a move (byte-identity is
  //    the move floor). Truth = one-to-one.
  {
    name: "rename-and-edit",
    mutationClass: "one-to-one (rename+edit)",
    prior: [occ("p1", "src/old.ts", ADD, { context: "helper" })],
    successor: [
      occ(
        "q1",
        "src/new.ts",
        "export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n",
        { context: "helper" },
      ),
    ],
    truth: [{ fromId: "p1", lineage: "one-to-one", toId: "q1" }],
  },

  // 7. Deletion: the occurrence disappears with no successor. Truth = terminated.
  {
    name: "deletion",
    mutationClass: "terminated (delete)",
    prior: [occ("p1", "src/math.ts", ADD), occ("p2", "src/math.ts", SUB)],
    successor: [occ("q1", "src/math.ts", ADD)],
    truth: [
      { fromId: "p1", lineage: "exact", toId: "q1" },
      { fromId: "p2", lineage: "terminated" },
    ],
  },

  // 8. Pure addition: a new occurrence with no antecedent (tests `added`).
  {
    name: "addition",
    mutationClass: "added (new)",
    prior: [occ("p1", "src/math.ts", ADD)],
    successor: [occ("q1", "src/math.ts", ADD), occ("q2", "src/math.ts", MUL)],
    truth: [{ fromId: "p1", lineage: "exact", toId: "q1" }],
    addedTruth: ["q2"],
  },

  // 9. The headline: twelve byte-identical boilerplate handlers, separated only by
  //    surrounding context (distinct call sites). Must yield twelve identities.
  {
    name: "twelve-identical-handlers",
    mutationClass: "exact (12 identical bodies)",
    prior: Array.from({ length: 12 }, (_, i) =>
      occ(`p${i}`, `routes/r${i}.ts`, HANDLER, {
        context: `// route ${i}\nmount("/r${i}", handler);`,
      }),
    ),
    // Successors shuffled + re-identified, same distinguishing context.
    successor: [11, 4, 0, 8, 2, 9, 5, 1, 10, 6, 3, 7].map((i) =>
      occ(`q${i}`, `routes/r${i}.ts`, HANDLER, {
        context: `// route ${i}\nmount("/r${i}", handler);`,
      }),
    ),
    truth: Array.from({ length: 12 }, (_, i) => ({
      fromId: `p${i}`,
      lineage: "exact" as const,
      toId: `q${i}`,
    })),
  },

  // 10. Identical body duplicated, context ALSO identical: genuinely ambiguous, must
  //     fail closed (never a false move onto one of the two copies).
  {
    name: "duplicate-ambiguous",
    mutationClass: "ambiguous (indistinct duplicate)",
    prior: [occ("p1", "src/a.ts", "const noop = () => {};\n", { context: "shared surroundings" })],
    successor: [
      occ("q1", "src/b.ts", "const noop = () => {};\n", { context: "shared surroundings" }),
      occ("q2", "src/c.ts", "const noop = () => {};\n", { context: "shared surroundings" }),
    ],
    truth: [{ fromId: "p1", lineage: "ambiguous" }],
  },

  // 11. Split: one module function divided into two files.
  {
    name: "function-split",
    mutationClass: "split",
    prior: [occ("p1", "src/ops.ts", ADD + SUB, { context: "ops module" })],
    successor: [
      occ("q1", "src/add.ts", ADD, { context: "add module" }),
      occ("q2", "src/sub.ts", SUB, { context: "sub module" }),
    ],
    truth: [{ fromId: "p1", lineage: "split", toIds: ["q1", "q2"] }],
  },

  // 12. Merge: two functions folded into one file.
  {
    name: "function-merge",
    mutationClass: "merge",
    prior: [
      occ("p1", "src/add.ts", ADD, { context: "add module" }),
      occ("p2", "src/sub.ts", SUB, { context: "sub module" }),
    ],
    successor: [occ("q1", "src/ops.ts", ADD + SUB, { context: "ops module" })],
    truth: [
      { fromId: "p1", lineage: "merge", toId: "q1" },
      { fromId: "p2", lineage: "merge", toId: "q1" },
    ],
  },

  // 13. Adversarial: two SIMILAR-but-distinct helpers, each lightly edited. The
  //     matcher must keep them apart (each maps to its own successor), not swap
  //     them. Truth = one-to-one each (bodies changed).
  {
    name: "near-duplicate-helpers",
    mutationClass: "one-to-one (near-duplicate)",
    prior: [
      occ(
        "p1",
        "src/fmt.ts",
        'export function fmtUser(u: User): string {\n  return u.first + " " + u.last;\n}\n',
        { context: "user formatting" },
      ),
      occ(
        "p2",
        "src/fmt.ts",
        'export function fmtOrg(o: Org): string {\n  return o.name + " (" + o.id + ")";\n}\n',
        { context: "org formatting" },
      ),
    ],
    successor: [
      occ(
        "q1",
        "src/fmt.ts",
        'export function fmtUser(u: User): string {\n  return (u.first + " " + u.last).trim();\n}\n',
        { context: "user formatting" },
      ),
      occ(
        "q2",
        "src/fmt.ts",
        'export function fmtOrg(o: Org): string {\n  return o.name + " (#" + o.id + ")";\n}\n',
        { context: "org formatting" },
      ),
    ],
    truth: [
      { fromId: "p1", lineage: "one-to-one", toId: "q1" },
      { fromId: "p2", lineage: "one-to-one", toId: "q2" },
    ],
  },

  // 14. Reorder: occurrences reordered within the file, each byte-identical → exact.
  //     Order must not defeat identity (ids/content drive the match, not position).
  {
    name: "reorder-unchanged",
    mutationClass: "exact (reordered)",
    prior: [
      occ("p1", "src/math.ts", ADD, { context: "first" }),
      occ("p2", "src/math.ts", SUB, { context: "second" }),
      occ("p3", "src/math.ts", MUL, { context: "third" }),
    ],
    successor: [
      occ("q3", "src/math.ts", MUL, { context: "third" }),
      occ("q1", "src/math.ts", ADD, { context: "first" }),
      occ("q2", "src/math.ts", SUB, { context: "second" }),
    ],
    truth: [
      { fromId: "p1", lineage: "exact", toId: "q1" },
      { fromId: "p2", lineage: "exact", toId: "q2" },
      { fromId: "p3", lineage: "exact", toId: "q3" },
    ],
  },

  // 15. The realistic force-push: one occurrence unchanged, one edited, one deleted.
  {
    name: "mixed-force-push",
    mutationClass: "mixed (force-push)",
    prior: [
      occ("p1", "src/svc.ts", ADD, { context: "kept" }),
      occ("p2", "src/svc.ts", SUB, { context: "edited" }),
      occ("p3", "src/svc.ts", MUL, { context: "removed" }),
    ],
    successor: [
      occ("q1", "src/svc.ts", ADD, { context: "kept" }),
      occ(
        "q2",
        "src/svc.ts",
        "export function sub(a: number, b: number): number {\n  return a - b - 0;\n}\n",
        { context: "edited" },
      ),
    ],
    truth: [
      { fromId: "p1", lineage: "exact", toId: "q1" },
      { fromId: "p2", lineage: "one-to-one", toId: "q2" },
      { fromId: "p3", lineage: "terminated" },
    ],
  },

  // 16. Move + unchanged sibling: a file renamed (move) while a sibling occurrence
  //     in a different file is untouched (exact). Guards against a rename leaking
  //     onto the wrong file.
  {
    name: "move-with-stable-sibling",
    mutationClass: "move (+ stable sibling)",
    prior: [
      occ("p1", "src/legacy/name.ts", ADD, { context: "renamed unit" }),
      occ("p2", "src/keep.ts", MUL, { context: "stable unit" }),
    ],
    successor: [
      occ("q2", "src/keep.ts", MUL, { context: "stable unit" }),
      occ("q1", "src/current/name.ts", ADD, { context: "renamed unit" }),
    ],
    truth: [
      { fromId: "p1", lineage: "move", toId: "q1" },
      { fromId: "p2", lineage: "exact", toId: "q2" },
    ],
  },
];
