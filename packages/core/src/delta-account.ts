import type {
  DeltaAccount,
  DeltaAskAccount,
  Disposition,
  DispositionAnchor,
  Patchset,
} from "@rennet/types";

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
 *     loudly (the scope-creep the reviewer must see).
 *
 * There is NO model call: every fact is computed by set arithmetic over the carry
 * result + the changed-path set. The optional M25 light seat may rephrase this into
 * prose, but the structured account is complete on its own — that is the accountability
 * guarantee (a scope-creep detector that could hallucinate is worthless).
 *
 * ⚠️ Grain (issue #73, a deliberate divergence from the proposal's hunk-grain prose):
 * the shipped substrate has NO returned-hunk→disposition trace and NO structured hunk
 * objects (`PatchFile.patch` is raw diff text), so beyond-asks is computed at PATH
 * grain — a file the successor changed that no ask targeted. That is the honest ceiling
 * of the shipped data; claiming hunk precision we cannot deliver would be a UI lie.
 * Per-ask status stays span-precise (it keys on the anchor the carry already verified).
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
}): DeltaAccount {
  const { asks, carried, changedPaths, renames = [] } = input;
  const changed = new Set(changedPaths);
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
    };
  });

  const beyondAsks = [...changed].filter((path) => !coveredPaths.has(path)).sort();

  return { asks: accountedAsks, beyondAsks };
}
