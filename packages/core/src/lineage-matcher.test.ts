import { describe, expect, it } from "vitest";
import {
  autoCarries,
  classifyLineage,
  type LineageClassification,
  type MatchOccurrence,
  maxWeightMatching,
} from "./lineage-matcher";

// A tiny occurrence factory. Bodies are the load-bearing evidence; path/symbol/
// context are supplied only where a test exercises them.
function occ(
  id: string,
  body: string,
  extra: Partial<Omit<MatchOccurrence, "id" | "body">> = {},
): MatchOccurrence {
  return { id, path: extra.path ?? `${id}.ts`, body, ...extra };
}

function byFrom(result: { classifications: readonly LineageClassification[] }, fromId: string) {
  const found = result.classifications.find((c) => c.fromId === fromId);
  if (!found) throw new Error(`no classification for ${fromId}`);
  return found;
}

// ── maxWeightMatching: the assignment must be the GLOBAL optimum ──────────────
describe("maxWeightMatching", () => {
  it("returns [] for an empty matrix", () => {
    expect(maxWeightMatching([], 0)).toEqual([]);
  });

  it("picks the global optimum, not a greedy first pick", () => {
    // Greedy on row 0 would grab col 0 (0.9), forcing row 1 onto col 1 (0.1) for
    // a total of 1.0. The optimal assignment is row0→col1 (0.8) + row1→col0 (0.85)
    // = 1.65. A correct max-weight matcher must find the latter.
    const scores = [
      [0.9, 0.8],
      [0.85, 0.1],
    ];
    expect(maxWeightMatching(scores, 0)).toEqual([1, 0]);
  });

  it("leaves a row unmatched when its only assignment scores below the floor", () => {
    const scores = [
      [0.9, 0.05],
      [0.04, 0.03],
    ];
    // Row 1's every option is below floor 0.28 → -1 (a pad/sub-floor is no match).
    expect(maxWeightMatching(scores, 0.28)).toEqual([0, -1]);
  });

  it("handles more successors than priors (rectangular)", () => {
    const scores = [[0.2, 0.9, 0.3]];
    expect(maxWeightMatching(scores, 0.28)).toEqual([1]);
  });

  it("handles more priors than successors (rectangular): one prior goes unmatched", () => {
    const scores = [[0.9], [0.8]];
    const match = maxWeightMatching(scores, 0.28);
    // Exactly one row wins the single column; the other is -1.
    expect(match.filter((c) => c === 0)).toHaveLength(1);
    expect(match.filter((c) => c === -1)).toHaveLength(1);
  });
});

// ── Exact / move / one-to-one / terminated ────────────────────────────────────
describe("classifyLineage — the 1:1 classes", () => {
  const body = "export function add(a: number, b: number) {\n  return a + b;\n}\n";

  it("byte-identical body at the same path is EXACT and auto-carries", () => {
    const result = classifyLineage(
      [occ("a", body, { path: "src/math.ts" })],
      [occ("a2", body, { path: "src/math.ts" })],
    );
    const c = byFrom(result, "a");
    expect(c.lineage).toBe("exact");
    expect(c.toId).toBe("a2");
    expect(autoCarries(c.lineage)).toBe(true);
  });

  it("byte-identical body at a NEW path is classified MOVE but does NOT auto-carry", () => {
    // The classifier still LABELS a relocated identical body `move` (informational,
    // for the graph). But `move` was REMOVED from the auto-carry authority (#16):
    // content + optional context cannot distinguish this from a delete-plus-copy,
    // so a confident `move` can point at the wrong occurrence. It never carries.
    const result = classifyLineage(
      [occ("a", body, { path: "src/old.ts" })],
      [occ("a2", body, { path: "src/new.ts" })],
    );
    const c = byFrom(result, "a");
    expect(c.lineage).toBe("move");
    expect(c.toId).toBe("a2");
    expect(autoCarries(c.lineage)).toBe(false);
  });

  it("a trivially-changed body (added line) is ONE-TO-ONE and does NOT auto-carry", () => {
    const edited = body.replace("return a + b;", "const sum = a + b;\n  return sum;");
    const result = classifyLineage([occ("a", body)], [occ("a2", edited)]);
    const c = byFrom(result, "a");
    expect(c.lineage).toBe("one-to-one");
    expect(autoCarries(c.lineage)).toBe(false);
  });

  it("a whitespace-only change does NOT stay exact (byte-identity is the floor)", () => {
    const result = classifyLineage([occ("a", body)], [occ("a2", `${body}   `)]);
    // Normalised-similar but not byte-identical → reopens, never exact.
    expect(byFrom(result, "a").lineage).not.toBe("exact");
  });

  it("an occurrence with no viable successor is TERMINATED and does NOT auto-carry", () => {
    const result = classifyLineage(
      [occ("gone", body)],
      [occ("unrelated", "const x = require('totally-different-thing');\nconsole.log(x.y.z);\n")],
    );
    const c = byFrom(result, "gone");
    expect(c.lineage).toBe("terminated");
    expect(c.toId).toBeUndefined();
    expect(autoCarries(c.lineage)).toBe(false);
  });

  it("reports successors with no antecedent as added", () => {
    const result = classifyLineage(
      [occ("a", body)],
      [occ("a2", body), occ("new", "let brand = 1;")],
    );
    expect(result.added).toEqual(["new"]);
  });
});

// ── The headline: twelve identical boilerplate bodies → twelve identities ─────
describe("classifyLineage — twelve identical boilerplate bodies", () => {
  // Twelve occurrences whose BODIES are byte-identical; only the surrounding
  // context (distinct call sites) separates them. A content-only matcher collapses
  // them onto one; the global matching + context evidence must yield twelve.
  const boiler = "export default function handler() {\n  return null;\n}\n";
  const prior: MatchOccurrence[] = Array.from({ length: 12 }, (_, i) =>
    occ(`p${i}`, boiler, { path: `routes/r${i}.ts`, context: `// route ${i}\nregister(r${i});` }),
  );
  // Successors: same bodies, same distinguishing context, shuffled order + new ids.
  const shuffle = [7, 0, 11, 3, 9, 1, 6, 2, 10, 4, 8, 5];
  const successor: MatchOccurrence[] = shuffle.map((i) =>
    occ(`s${i}`, boiler, { path: `routes/r${i}.ts`, context: `// route ${i}\nregister(r${i});` }),
  );

  it("yields twelve distinct identities, each mapped to its own context-counterpart", () => {
    const result = classifyLineage(prior, successor);
    const mapped = new Map(result.classifications.map((c) => [c.fromId, c.toId]));
    for (let i = 0; i < 12; i += 1) {
      expect(mapped.get(`p${i}`)).toBe(`s${i}`);
    }
    // Every successor is claimed exactly once — no collapse, nothing added.
    expect(result.added).toEqual([]);
    // Same path + identical body ⟹ every one is exact.
    for (const c of result.classifications) expect(c.lineage).toBe("exact");
    // Twelve distinct targets.
    expect(new Set(mapped.values()).size).toBe(12);
  });
});

// ── Ambiguity fails closed ────────────────────────────────────────────────────
describe("classifyLineage — ambiguity fails closed", () => {
  it("an identical body duplicated with identical context is AMBIGUOUS, never a confident move", () => {
    // One prior, two successors: identical bodies AND identical context. Nothing
    // can defensibly separate them → ambiguous → does not auto-carry.
    const body = "const noop = () => {};\n";
    const prior = [occ("p", body, { path: "a.ts", context: "shared" })];
    const successor = [
      occ("s1", body, { path: "b.ts", context: "shared" }),
      occ("s2", body, { path: "c.ts", context: "shared" }),
    ];
    const c = byFrom(classifyLineage(prior, successor), "p");
    expect(c.lineage).toBe("ambiguous");
    expect(autoCarries(c.lineage)).toBe(false);
  });

  it("context breaks a duplicate tie into a MOVE classification — but it STILL does not auto-carry", () => {
    // Identical body; the successor at b.ts shares the prior's context, c.ts does
    // not. The tie breaks, so the classifier emits `move` rather than `ambiguous`.
    // ⭐ This "confident move via context" is EXACTLY the case #16 proved unsafe:
    // context can be rotated or coincidental (a copy that kept the old context
    // steals the lineage), so the confidence is not trustworthy. `move` therefore
    // does NOT auto-carry — the classification is informational only.
    const body = "const noop = () => {};\n";
    const prior = [occ("p", body, { path: "a.ts", context: "// used by widget\nwidget()" })];
    const successor = [
      occ("s1", body, { path: "b.ts", context: "// used by widget\nwidget()" }),
      occ("s2", body, { path: "c.ts", context: "// used by gadget\ngadget()" }),
    ];
    const c = byFrom(classifyLineage(prior, successor), "p");
    expect(c.lineage).toBe("move");
    expect(c.toId).toBe("s1");
    expect(autoCarries(c.lineage)).toBe(false);
  });
});

// ── Split and merge (both fail closed) ────────────────────────────────────────
describe("classifyLineage — split and merge", () => {
  it("one prior fanning out into two content-slices is a SPLIT and does not auto-carry", () => {
    const half1 = "export function alpha() {\n  return doAlpha();\n}\n";
    const half2 = "export function beta() {\n  return doBeta();\n}\n";
    const prior = [occ("big", half1 + half2, { path: "mod.ts" })];
    const successor = [
      occ("s1", half1, { path: "alpha.ts" }),
      occ("s2", half2, { path: "beta.ts" }),
    ];
    const c = byFrom(classifyLineage(prior, successor), "big");
    expect(c.lineage).toBe("split");
    expect(new Set(c.toIds)).toEqual(new Set(["s1", "s2"]));
    expect(autoCarries(c.lineage)).toBe(false);
  });

  it("two priors folding into one file is a MERGE and does not auto-carry", () => {
    const half1 = "export function alpha() {\n  return doAlpha();\n}\n";
    const half2 = "export function beta() {\n  return doBeta();\n}\n";
    const prior = [occ("a", half1, { path: "alpha.ts" }), occ("b", half2, { path: "beta.ts" })];
    const successor = [occ("m", half1 + half2, { path: "mod.ts" })];
    const result = classifyLineage(prior, successor);
    expect(byFrom(result, "a").lineage).toBe("merge");
    expect(byFrom(result, "b").lineage).toBe("merge");
    expect(byFrom(result, "a").toId).toBe("m");
    expect(byFrom(result, "b").toId).toBe("m");
    expect(autoCarries("merge")).toBe(false);
  });
});

// ── The lineage graph the manifest consumes ───────────────────────────────────
describe("classifyLineage — emitted LineageEntry graph", () => {
  it("terminated emits a toId-less entry (resolveAnchor orphans it)", () => {
    const result = classifyLineage(
      [occ("gone", "aaa\nbbb\nccc")],
      [occ("x", "zzz\nyyy\nwww\nvvv")],
    );
    expect(result.lineage).toContainEqual({ fromId: "gone", lineage: "terminated" });
  });

  it("a split emits one entry per member so the graph stays flat", () => {
    const half1 = "export function alpha() {\n  return doAlpha();\n}\n";
    const half2 = "export function beta() {\n  return doBeta();\n}\n";
    const result = classifyLineage(
      [occ("big", half1 + half2, { path: "mod.ts" })],
      [occ("s1", half1, { path: "alpha.ts" }), occ("s2", half2, { path: "beta.ts" })],
    );
    const splitEntries = result.lineage.filter((e) => e.fromId === "big");
    expect(splitEntries).toHaveLength(2);
    expect(splitEntries.every((e) => e.lineage === "split")).toBe(true);
  });
});
