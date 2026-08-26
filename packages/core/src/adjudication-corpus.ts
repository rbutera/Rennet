/**
 * The seeded ground-truth corpus + pure scorer for cross-harness adjudication (#41).
 *
 * ⚠️ FIXED BOUNDARY — SYNTHETIC ONLY. Every item here is Rennet-authored from
 * scratch: invented code with a planted bug or a clean control, each with a KNOWN
 * per-claim verdict and a claim class. NO item derives from client repositories,
 * client code, client pull requests, or any client data (project fixed boundary).
 * The corpus is expressible as offered manifests so the SAME finding + reconcile +
 * adjudication machinery that serves live reviews runs over it unmodified.
 *
 * The corpus answers #41's acceptance criterion: on seeded ground truth, does
 * EXPLICIT adjudication measurably beat RAW overlap? The pure `scoreAdjudicationCalibration`
 * compares, per class, overlap's raw answer (did the reconcile arithmetic land on the
 * truth?) against the adjudicated answer (does the verdict correct a wrong solo?). The
 * measurement itself is carried by the gated `.real` run in `packages/adapters`; here
 * the scorer's correctness is what the hermetic default gate proves — zero model spend.
 */

import type { FindingAdjudicationVerdict, FindingElement, OfferedManifest } from "@rennet/protocol";

/** A claim class that maps to a real cross-harness disagreement kind (design D4). */
export type AdjudicationClaimClass =
  | "behavioural-off-by-one"
  | "null-deref"
  | "resource-leak"
  | "mechanical-nit"
  | "clean-control";

export interface AdjudicationCorpusItem {
  /** Stable id — one committed fixture. */
  readonly id: string;
  readonly claimClass: AdjudicationClaimClass;
  /** The known ground truth: a real planted bug, or a clean control (no real concern). */
  readonly truth: "planted-bug" | "clean";
  /** The synthetic diff as an offered manifest — the same shape live reviews consume. */
  readonly manifest: OfferedManifest;
  /** Path written into the isolated synthetic repository for a real calibration run. */
  readonly filePath: string;
  /** The exact seeded claim scored for this fixture, whether planted or clean. */
  readonly claimAnchor: string;
  readonly claimSummary: string;
  /** Every group must match at least one marker in a generated finding's summary. */
  readonly claimMarkerGroups: readonly (readonly string[])[];
  /** The concern a correct seat should raise (planted items only). */
  readonly plantedSummary?: string;
  /** The anchor of the planted concern (planted items only). */
  readonly plantedAnchor?: string;
}

/** Build a one-hunk synthetic manifest with the given added/context lines. */
function hunk(
  id: string,
  additions: readonly string[],
  context: readonly string[] = [],
): OfferedManifest {
  return {
    occurrences: [
      { id, kind: "hunk", sides: { additions: [...additions], context: [...context] } },
    ],
    lineage: [],
  };
}

function renameHunk(id: string, before: string, after: string): OfferedManifest {
  return {
    occurrences: [{ id, kind: "hunk", sides: { deletions: [before], additions: [after] } }],
    lineage: [],
  };
}

/**
 * ~10 committed synthetic items: for each real disagreement class a PLANTED bug and a
 * CLEAN control (the same shape without the bug), plus explicit clean-control items.
 * All code is invented for this corpus; none of it is a real project file.
 */
export const ADJUDICATION_CORPUS: readonly AdjudicationCorpusItem[] = Object.freeze([
  {
    id: "off-by-one-planted",
    claimClass: "behavioural-off-by-one",
    truth: "planted-bug",
    filePath: "src/calibration.ts",
    claimAnchor: "rennet:hunk/h",
    claimSummary: "loop condition `i <= items.length` overruns the array by one",
    claimMarkerGroups: [["items.length"], ["overrun", "out of bounds", "off-by-one", "off by one"]],
    manifest: hunk("h", [
      "for (let i = 0; i <= items.length; i++) {",
      "  total += items[i].price;",
    ]),
    plantedSummary: "loop condition `i <= items.length` overruns the array by one",
    plantedAnchor: "rennet:hunk/h",
  },
  {
    id: "off-by-one-clean",
    claimClass: "behavioural-off-by-one",
    truth: "clean",
    filePath: "src/calibration.ts",
    claimAnchor: "rennet:hunk/h",
    claimSummary: "loop condition overruns the array by one",
    claimMarkerGroups: [["items.length"], ["overrun", "out of bounds", "off-by-one", "off by one"]],
    manifest: hunk("h", ["for (let i = 0; i < items.length; i++) {", "  total += items[i].price;"]),
  },
  {
    id: "null-deref-planted",
    claimClass: "null-deref",
    truth: "planted-bug",
    filePath: "src/calibration.ts",
    claimAnchor: "rennet:hunk/h",
    claimSummary: "`findUser` can return undefined and `user.name` is dereferenced unguarded",
    claimMarkerGroups: [
      ["finduser", "user.name"],
      ["undefined", "null", "unguarded"],
    ],
    manifest: hunk("h", ["const user = findUser(id);", "return user.name.toUpperCase();"]),
    plantedSummary: "`findUser` can return undefined and `user.name` is dereferenced unguarded",
    plantedAnchor: "rennet:hunk/h",
  },
  {
    id: "null-deref-clean",
    claimClass: "null-deref",
    truth: "clean",
    filePath: "src/calibration.ts",
    claimAnchor: "rennet:hunk/h",
    claimSummary: "`findUser` can return undefined and `user.name` is dereferenced unguarded",
    claimMarkerGroups: [
      ["finduser", "user.name"],
      ["undefined", "null", "unguarded"],
    ],
    manifest: hunk("h", [
      "const user = findUser(id);",
      "if (!user) return null;",
      "return user.name.toUpperCase();",
    ]),
  },
  {
    id: "resource-leak-planted",
    claimClass: "resource-leak",
    truth: "planted-bug",
    filePath: "src/calibration.ts",
    claimAnchor: "rennet:hunk/h",
    claimSummary: "the file handle is never closed on the return path — a descriptor leak",
    claimMarkerGroups: [
      ["handle", "descriptor"],
      ["close", "leak"],
    ],
    manifest: hunk("h", [
      "const handle = await open(path);",
      "const data = await handle.read();",
      "return parse(data);",
    ]),
    plantedSummary: "the file handle is never closed on the return path — a descriptor leak",
    plantedAnchor: "rennet:hunk/h",
  },
  {
    id: "resource-leak-clean",
    claimClass: "resource-leak",
    truth: "clean",
    filePath: "src/calibration.ts",
    claimAnchor: "rennet:hunk/h",
    claimSummary: "the file handle is never closed on the return path — a descriptor leak",
    claimMarkerGroups: [
      ["handle", "descriptor"],
      ["close", "leak"],
    ],
    manifest: hunk("h", [
      "const handle = await open(path);",
      "try { return parse(await handle.read()); }",
      "finally { await handle.close(); }",
    ]),
  },
  {
    id: "mechanical-nit-planted",
    claimClass: "mechanical-nit",
    truth: "planted-bug",
    filePath: "src/calibration.ts",
    claimAnchor: "rennet:hunk/h",
    claimSummary: "`readFile` is imported but never used in this change",
    claimMarkerGroups: [["readfile"], ["unused", "never used"]],
    manifest: hunk("h", ["import { readFile } from 'node:fs';", "export const NAME = 'widget';"]),
    plantedSummary: "`readFile` is imported but never used in this change",
    plantedAnchor: "rennet:hunk/h",
  },
  {
    id: "mechanical-nit-clean",
    claimClass: "mechanical-nit",
    truth: "clean",
    filePath: "src/calibration.ts",
    claimAnchor: "rennet:hunk/h",
    claimSummary: "`readFile` is imported but never used in this change",
    claimMarkerGroups: [["readfile"], ["unused", "never used"]],
    manifest: hunk("h", [
      "import { readFile } from 'node:fs';",
      "export const load = () => readFile('widget');",
    ]),
  },
  {
    id: "clean-control-rename",
    claimClass: "clean-control",
    truth: "clean",
    filePath: "src/calibration.ts",
    claimAnchor: "rennet:hunk/h",
    claimSummary: "renaming oldName to newName changes runtime behaviour",
    claimMarkerGroups: [
      ["oldname", "newname"],
      ["runtime", "behaviour", "behavior"],
    ],
    manifest: renameHunk("h", "const oldName = compute();", "const newName = compute();"),
  },
  {
    id: "clean-control-comment",
    claimClass: "clean-control",
    truth: "clean",
    filePath: "src/calibration.ts",
    claimAnchor: "rennet:hunk/h",
    claimSummary: "the cache-key comment changes runtime behaviour",
    claimMarkerGroups: [
      ["cache", "comment"],
      ["runtime", "behaviour", "behavior"],
    ],
    manifest: hunk("h", [
      "// Clarify why the cache is keyed by repository root, not branch.",
      "return cacheKey(root);",
    ]),
  },
]);

// ── The pure scorer ───────────────────────────────────────────────────────────

/** One corpus item's observed outcome under a review run (from fakes in the gate, or the real run). */
export interface AdjudicationOutcome {
  readonly id: string;
  readonly claimAnchor: string;
  readonly claimSummary: string;
  /**
   * Raw overlap arithmetic: did a concern STAND for this item after reconcile (a concur
   * or a solo)? This is what overlap alone concludes — with no third opinion, a solo is
   * left standing as a possible flag.
   */
  readonly overlapFlagged: boolean;
  /** The explicit adjudication verdict, when the contested row was adjudicated. */
  readonly adjudicatedVerdict?: FindingAdjudicationVerdict;
}

/** Select exactly the generated row that represents the fixture's seeded claim. */
export function findCalibrationClaim(
  item: AdjudicationCorpusItem,
  findings: readonly FindingElement[],
): FindingElement | undefined {
  const matches = findings.filter((finding) => {
    if (finding.anchor !== item.claimAnchor) return false;
    const summary = finding.summary.toLowerCase();
    return item.claimMarkerGroups.every((group) =>
      group.some((marker) => summary.includes(marker.toLowerCase())),
    );
  });
  if (matches.length > 1) {
    throw new Error(`Ambiguous calibration claim ${item.id}: ${matches.length} findings matched`);
  }
  return matches[0];
}

/** Per-class calibration counts — raw counts, never percentages dressed as significance. */
export interface ClassCalibration {
  readonly claimClass: AdjudicationClaimClass;
  readonly items: number;
  /** Items where raw overlap's answer matched the known truth. */
  readonly overlapCorrect: number;
  /** Items where explicit adjudication's answer matched the known truth. */
  readonly adjudicationCorrect: number;
}

/** The truth's target answer: a planted bug should stand (flag); a clean control should not. */
function targetFlagged(truth: AdjudicationCorpusItem["truth"]): boolean {
  return truth === "planted-bug";
}

/**
 * The answer explicit adjudication lands on: `supported` keeps the flag, `contradicted`
 * clears it, and `insufficient`/absent falls BACK to overlap's raw answer — because an
 * unresolved adjudication is no improvement (and the row still stands, so it reads as
 * flagged). This is the exact "does adjudication correct a wrong solo?" comparison D4
 * asks for.
 */
function adjudicatedFlagged(outcome: AdjudicationOutcome): boolean {
  switch (outcome.adjudicatedVerdict) {
    case "supported":
      return true;
    case "contradicted":
      return false;
    default:
      return outcome.overlapFlagged;
  }
}

/**
 * Score the corpus: per claim class, how often raw overlap vs explicit adjudication
 * matched the known truth. Pure — no I/O, no clock, no model turn — so the default gate
 * proves the scorer against synthetic outcomes at zero spend. An item with no matching
 * outcome is treated as unflagged (a review that raised nothing for it).
 */
export function scoreAdjudicationCalibration(
  items: readonly AdjudicationCorpusItem[],
  outcomes: readonly AdjudicationOutcome[],
): ClassCalibration[] {
  const itemIds = new Set<string>();
  for (const item of items) {
    if (itemIds.has(item.id)) throw new Error(`Duplicate calibration item id: ${item.id}`);
    itemIds.add(item.id);
  }
  const byId = new Map<string, AdjudicationOutcome>();
  for (const outcome of outcomes) {
    if (!itemIds.has(outcome.id)) throw new Error(`Unknown calibration outcome id: ${outcome.id}`);
    if (byId.has(outcome.id)) throw new Error(`Duplicate calibration outcome id: ${outcome.id}`);
    byId.set(outcome.id, outcome);
  }
  const missing = items.filter((item) => !byId.has(item.id)).map((item) => item.id);
  if (missing.length > 0) throw new Error(`Missing calibration outcomes: ${missing.join(", ")}`);
  const byClass = new Map<
    AdjudicationClaimClass,
    { items: number; overlap: number; adj: number }
  >();

  for (const item of items) {
    const outcome = byId.get(item.id);
    if (!outcome) throw new Error(`Missing calibration outcome: ${item.id}`);
    if (outcome.claimAnchor !== item.claimAnchor || outcome.claimSummary !== item.claimSummary) {
      throw new Error(`Calibration outcome claim mismatch: ${item.id}`);
    }
    const target = targetFlagged(item.truth);
    const overlapCorrect = outcome.overlapFlagged === target;
    const adjudicationCorrect = adjudicatedFlagged(outcome) === target;

    const acc = byClass.get(item.claimClass) ?? { items: 0, overlap: 0, adj: 0 };
    acc.items += 1;
    if (overlapCorrect) acc.overlap += 1;
    if (adjudicationCorrect) acc.adj += 1;
    byClass.set(item.claimClass, acc);
  }

  return [...byClass.entries()].map(([claimClass, acc]) => ({
    claimClass,
    items: acc.items,
    overlapCorrect: acc.overlap,
    adjudicationCorrect: acc.adj,
  }));
}
