import {
  type AnchorSide,
  type AnchorSpan,
  type DeltaAccount,
  type DeltaAskAccount,
  type DeltaBeyondHunk,
  DIFF_TRUNCATION_MARKER,
  type Disposition,
  type DispositionAnchor,
  type DispositionType,
  type HandoffAskTrace,
  type Patchset,
} from "@rennet/types";
import { addedOf, deletedOf, parseFilePatch, type RawHunk } from "./decomposition";

/**
 * The delta re-review account (issue #73) — the DETERMINISTIC, model-free half.
 *
 * When a successor patchset carries dispositions from a predecessor (a regenerate, or
 * the #18 handoff loop returning the agent's work), this records what the returned
 * patchset did relative to the staged asks:
 *   • per ask — addressed / partially-addressed / untouched (from the shipped lineage
 *     carry: a carried ask's target is byte-identical; a non-carried ask's target
 *     changed);
 *   • beyond-asks — every path the successor changed that NO ask targeted, surfaced
 *     loudly (the scope-creep the reviewer must see) — the path-grain FLOOR; and,
 *     when the two patchsets are in hand, the exact beyond-ask HUNKS (see below).
 *
 * There is NO model call: every fact is computed by set/hunk arithmetic over the carry
 * result + the two patchsets. The optional M25 light seat may rephrase this into prose,
 * but the structured account is complete on its own — that is the accountability
 * guarantee (a scope-creep detector that could hallucinate is worthless).
 *
 * Grain (issue #73 wave 3): beyond-asks is computed at HUNK grain when both patchsets
 * are supplied. A successor hunk is NEW when its changed-line content (added+deleted
 * bytes, context and header line numbers excluded) matches no hunk in the prior patch
 * for the file or its rename source, so pure line-number drift is not a change. Each new
 * hunk no ask covers is reported in the loud `unasked-file` bucket or the quiet
 * `asked-file` bucket — the latter is an unrequested hunk inside an asked file, which
 * path grain structurally cannot see. Reuses the decomposition floor's raw-hunk parser
 * (no second diff parser). A truncated file degrades honestly to path grain; the
 * path-grain `beyondAsks` floor always remains. Per-ask status stays span-precise (it
 * keys on the anchor the carry already verified). A handoff run's traceMap attributes
 * each ask to its composed task (`handoffTask`) — asks, never hunks (no per-task turn
 * telemetry exists, so hunk attribution would be a guess).
 *
 * Node-free at module scope: no `node:*`, so a mobile/third-party client can import it.
 */

/**
 * A RENAME-SURVIVING identity for matching an ask to its carried descendant. The carry
 * re-anchors a span-grained disposition onto the new path across a git rename
 * (`carrySpanMoveOntoRename`), changing `path` and `contentDigest` but PRESERVING
 * `spanDigest` (the byte-identity of the flagged span). So a span-grained ask keys on
 * its `spanDigest`; a path-grained ask (which never carries across a rename) keys on
 * `path + contentDigest`. Keying on the raw path here would sever the lineage on every
 * rename and report an untouched concern as "addressed" — a UI lie (the original bug).
 */
function carryIdentity(anchor: DispositionAnchor): string {
  return anchor.spanDigest !== undefined
    ? `span:${anchor.side ?? ""}:${anchor.spanDigest}`
    : `path:${anchor.path}:${anchor.contentDigest}`;
}

/** A short, single-line excerpt of an ask body for the "what moved" line. */
function summarise(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
}

/**
 * The paths whose content CHANGED between the prior and the successor patchset — the
 * deterministic "what the successor touched" signal, computed by comparing each file's
 * diff text (`PatchFile.patch`). A path counts as changed when the successor's diff for
 * it differs from the prior's (new file, removed file, or a different patch body).
 *
 * ⚠️ Substrate ceiling (documented, not a defect): the compare is over the raw patch
 * text, so (i) a change confined BEYOND a file's truncation marker is invisible (large
 * files only), and (ii) a re-review whose base OID moved reports content-unchanged files
 * as changed (their hunk line-numbers shift). Both are rare in the re-review loop and
 * the account is informational, so they are accepted rather than papered over.
 */
export function changedPathsBetween(prior: Patchset, successor: Patchset): string[] {
  const priorByPath = new Map(prior.files.map((file) => [file.path, file.patch] as const));
  const successorByPath = new Map(successor.files.map((file) => [file.path, file.patch] as const));
  const changed = new Set<string>();
  for (const file of successor.files) {
    if (priorByPath.get(file.path) !== file.patch) changed.add(file.path);
  }
  // A path present in the prior changeset but gone from the successor also changed
  // (the agent reverted or removed it) — surfaced, never silently dropped.
  for (const file of prior.files) {
    if (!successorByPath.has(file.path)) changed.add(file.path);
  }
  return [...changed].sort();
}

/** A successor hunk with no byte-identical changed-line twin in the prior patch. */
export interface NewHunk {
  readonly path: string;
  readonly hunk: RawHunk;
}

/** The changed-line CONTENT identity of a hunk: its added + deleted line bytes, with
 *  context lines and header line numbers excluded — so a hunk that merely drifted
 *  (same edits, shifted line numbers) has the SAME identity and is not "new" (D1). */
function hunkChangeIdentity(body: readonly string[]): string {
  return JSON.stringify([addedOf(body), deletedOf(body)]);
}

/**
 * The successor's NEW hunks (issue #73 wave 3, design D1/D2/D6): every hunk of the
 * successor's per-file patch whose changed-line content appears in NO hunk of the prior
 * patch for that file (or its rename source). Reuses the decomposition floor's raw-hunk
 * parser — no second diff parser. Identity is over added+deleted line bytes (context and
 * header line numbers excluded), matched as a MULTISET so N identical prior hunks absorb
 * at most N successor hunks. A file whose patch is content-lossy (carries the truncation
 * marker) on EITHER side yields no hunk claims — it degrades to path grain honestly.
 * Pure — no I/O, no model.
 */
export function newHunksBetween(prior: Patchset, successor: Patchset): NewHunk[] {
  const priorByPath = new Map(prior.files.map((file) => [file.path, file] as const));
  const result: NewHunk[] = [];
  for (const file of successor.files) {
    // The prior counterpart: same path, or the rename source when the successor renamed it.
    const priorFile =
      priorByPath.get(file.path) ??
      (file.previousPath !== undefined ? priorByPath.get(file.previousPath) : undefined);
    // Truncation fallback (D6): a content-lossy patch on either side cannot certify hunk
    // identity, so this file makes no hunk claim (it still participates at path grain).
    if (
      file.patch.includes(DIFF_TRUNCATION_MARKER) ||
      (priorFile?.patch.includes(DIFF_TRUNCATION_MARKER) ?? false)
    ) {
      continue;
    }
    const priorCounts = new Map<string, number>();
    for (const hunk of priorFile ? parseFilePatch(priorFile.patch).hunks : []) {
      const id = hunkChangeIdentity(hunk.body);
      priorCounts.set(id, (priorCounts.get(id) ?? 0) + 1);
    }
    for (const hunk of parseFilePatch(file.patch).hunks) {
      // A hunk with no changed lines (mode-only / pure-context) is not a change.
      if (addedOf(hunk.body).length === 0 && deletedOf(hunk.body).length === 0) continue;
      const id = hunkChangeIdentity(hunk.body);
      const count = priorCounts.get(id) ?? 0;
      if (count > 0) {
        priorCounts.set(id, count - 1); // absorbed a prior twin — drift, not new
        continue;
      }
      result.push({ path: file.path, hunk });
    }
  }
  return result;
}

/** Inclusive 1-based line ranges for a hunk's new-file and old-file images. */
function hunkRanges(hunk: RawHunk): {
  newRange: readonly [number, number];
  oldRange: readonly [number, number];
  pureDeletion: boolean;
} {
  const pureDeletion = addedOf(hunk.body).length === 0 && deletedOf(hunk.body).length > 0;
  return {
    newRange: [hunk.newStart, hunk.newStart + Math.max(hunk.newLines, 1) - 1],
    oldRange: [hunk.oldStart, hunk.oldStart + Math.max(hunk.oldLines, 1) - 1],
    pureDeletion,
  };
}

/** Do two inclusive ranges overlap? */
function rangesIntersect(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/** The first changed line of a hunk (added first, else deleted), trimmed and bounded. */
function firstChangedLine(body: readonly string[]): string {
  const added = addedOf(body);
  const line = added.length > 0 ? (added[0] ?? "") : (deletedOf(body)[0] ?? "");
  const trimmed = line.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

/** The anchor identity a bundle ask and a review disposition share (path + span + side
 *  + type) — the key `buildHandoffBundle` minted its tasks against, so the fold can map
 *  an ask's handoff trace back to it. */
function traceKey(id: {
  path: string;
  span?: AnchorSpan;
  side?: AnchorSide;
  type: DispositionType;
}): string {
  return `${id.type}|${id.path}|${id.span?.startLine ?? ""}:${id.span?.endLine ?? ""}|${id.side ?? ""}`;
}

/**
 * Build the deterministic delta account from the carry result + the changed-path set.
 *
 * `asks` are the prior staged dispositions; `carried` are the ones the lineage carry
 * kept byte-identical (RE-ANCHORED to the new path when it carried across a rename);
 * `changedPaths` are the successor's changed paths (`changedPathsBetween`, or the
 * handoff turn's `filesTouched`); `renames` are the successor's git rename links
 * (old→new), so a rename target of an asked/carried file is not mistaken for
 * scope-creep. Pure — no I/O, no model.
 *
 * Per ask: an ask whose flagged span CARRIED (matched by rename-surviving identity) is
 * reported at its CURRENT location — untouched (its file was not otherwise changed) or
 * partially-addressed (the file was changed elsewhere). An ask that did NOT carry
 * (reopened, or its file deleted) is addressed. Beyond-asks is every changed path not
 * covered by an ask — including an ask's own rename target, which is never scope-creep.
 *
 * The partition is total BY CONSTRUCTION: `beyondAsks = changedPaths \ coveredPaths`, so
 * every changed path is either covered by an ask or beyond it, never dropped. (An
 * earlier `asked === beyond` assertion was removed: it was tautological — `beyond` is
 * defined as `!covered`, so it could never fire, and a dead guard is false confidence.)
 */
export function buildDeltaAccount(input: {
  asks: readonly Disposition[];
  carried: readonly Disposition[];
  changedPaths: readonly string[];
  renames?: ReadonlyArray<{ from: string; to: string }>;
  /**
   * The two patchsets (issue #73 wave 3), so the account can compute HUNK grain. When
   * both are supplied, `beyondAskHunks` is present (possibly empty); when either is
   * omitted it is absent and the account is path grain only.
   */
  prior?: Patchset;
  successor?: Patchset;
  /** A handoff run's per-ask task trace (issue #73 wave 3), for `handoffTask` attribution. */
  handoff?: readonly HandoffAskTrace[];
}): DeltaAccount {
  const { asks, carried, changedPaths, renames = [], prior, successor, handoff = [] } = input;
  const changed = new Set(changedPaths);
  // A handoff run's ask trace, keyed by the anchor identity the fold matches asks on.
  const traceByKey = new Map(handoff.map((trace) => [traceKey(trace), trace] as const));
  // Map each carried disposition by its rename-surviving identity → its CURRENT path
  // (the new path when it carried across a rename), so a carried ask is reported and
  // anchored where the concern lives NOW, not at a stale pre-rename path.
  const carriedPathByIdentity = new Map(
    carried.map((disposition) => [carryIdentity(disposition.anchor), disposition.anchor.path]),
  );
  // A rename's TARGET is the ask's own relocated content, never scope-creep — so it is
  // covered when its source was asked. Also covers a carried ask's new path directly.
  const renameTargetOf = new Map(renames.map((rename) => [rename.from, rename.to]));
  const renameTargets = new Set(renames.map((rename) => rename.to));

  const askedPaths = new Set(asks.map((ask) => ask.anchor.path));
  const coveredPaths = new Set<string>(askedPaths);
  for (const path of askedPaths) {
    const target = renameTargetOf.get(path);
    if (target !== undefined) coveredPaths.add(target);
  }
  for (const path of carriedPathByIdentity.values()) coveredPaths.add(path);

  const accountedAsks: DeltaAskAccount[] = asks.map((ask) => {
    // Attribution (issue #73 wave 3): the composed task that carried this ask on a
    // handoff run, matched by anchor identity. Absent on a regenerate (empty trace) or
    // an unmatched ask (belt-and-braces — the run refuses stale bundles). Narration only.
    const trace = traceByKey.get(
      traceKey({
        path: ask.anchor.path,
        span: ask.anchor.span,
        side: ask.anchor.side,
        type: ask.type,
      }),
    );
    const attribution = trace
      ? { handoffTask: { index: trace.taskIndex, title: trace.taskTitle } }
      : {};
    const carriedPath = carriedPathByIdentity.get(carryIdentity(ask.anchor));
    if (carriedPath === undefined) {
      // Did not carry: the flagged target changed (reopened) or its file was deleted —
      // either way the ask was addressed. Reported at its original (asked) path.
      return {
        path: ask.anchor.path,
        ...(ask.anchor.span !== undefined ? { span: ask.anchor.span } : {}),
        ...(ask.anchor.side !== undefined ? { side: ask.anchor.side } : {}),
        type: ask.type,
        summary: summarise(ask.body),
        status: "addressed",
        ...attribution,
      };
    }
    // Carried (flagged span byte-identical): reported at its CURRENT location. Untouched
    // unless the file was changed in CONTENT beyond the span — a pure rename (the file's
    // only change is the move) is NOT such a content change, so it stays untouched.
    const fileChangedInContent = changed.has(carriedPath) && !renameTargets.has(carriedPath);
    return {
      path: carriedPath,
      ...(ask.anchor.span !== undefined ? { span: ask.anchor.span } : {}),
      ...(ask.anchor.side !== undefined ? { side: ask.anchor.side } : {}),
      type: ask.type,
      summary: summarise(ask.body),
      status: fileChangedInContent ? "partially-addressed" : "untouched",
      ...attribution,
    };
  });

  const beyondAsks = [...changed].filter((path) => !coveredPaths.has(path)).sort();

  // Hunk grain (issue #73 wave 3): classify each NEW successor hunk against ask coverage.
  // Computed ONLY when both patchsets are supplied — else absent (path grain / legacy).
  const beyondAskHunks =
    prior !== undefined && successor !== undefined
      ? classifyBeyondHunks(newHunksBetween(prior, successor), asks, carriedPathByIdentity, coveredPaths)
      : undefined;

  return {
    asks: accountedAsks,
    beyondAsks,
    ...(beyondAskHunks !== undefined ? { beyondAskHunks } : {}),
  };
}

/**
 * Classify the successor's new hunks against ask coverage (issue #73 wave 3, design D3):
 * a hunk is COVERED when an ask targets its file path-grained, or the ask's span (at its
 * carried current path; side-aware — deletions matched on the old-file range, else the
 * new-file range) intersects the hunk's range. Every uncovered hunk is reported beyond,
 * in the loud `unasked-file` bucket (no ask targets the file) or the `asked-file` bucket
 * (inside an asked file, outside every asked span). Both are honest narration, never a
 * violation. Returns [] when nothing is beyond — distinct from absent (grain not computed).
 */
function classifyBeyondHunks(
  newHunks: readonly NewHunk[],
  asks: readonly Disposition[],
  carriedPathByIdentity: ReadonlyMap<string, string>,
  coveredPaths: ReadonlySet<string>,
): DeltaBeyondHunk[] {
  // Each ask at its CURRENT location (carried path when it moved across a rename).
  const askCoverage = asks.map((ask) => ({
    path: carriedPathByIdentity.get(carryIdentity(ask.anchor)) ?? ask.anchor.path,
    span: ask.anchor.span,
    side: ask.anchor.side,
  }));
  const beyond: DeltaBeyondHunk[] = [];
  for (const { path, hunk } of newHunks) {
    const ranges = hunkRanges(hunk);
    const covered = askCoverage.some((ask) => {
      if (ask.path !== path) return false;
      if (ask.span === undefined) return true; // a path-grained ask covers the whole file
      const askRange: readonly [number, number] = [
        ask.span.startLine,
        ask.span.endLine ?? ask.span.startLine,
      ];
      const target = ask.side === "deletions" ? ranges.oldRange : ranges.newRange;
      return rangesIntersect(askRange, target);
    });
    if (covered) continue;
    const range = ranges.pureDeletion ? ranges.oldRange : ranges.newRange;
    beyond.push({
      path,
      span: { startLine: range[0], ...(range[1] > range[0] ? { endLine: range[1] } : {}) },
      ...(ranges.pureDeletion ? { side: "deletions" as const } : {}),
      // A file some ask targets ⇒ the quiet asked-file bucket; else the loud one.
      bucket: coveredPaths.has(path) ? "asked-file" : "unasked-file",
      excerpt: firstChangedLine(hunk.body),
    });
  }
  return beyond;
}
