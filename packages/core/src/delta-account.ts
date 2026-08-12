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

/** A stable identity for a disposition's anchor: path + side + span bounds. */
function anchorKey(anchor: DispositionAnchor): string {
  return [
    anchor.path,
    anchor.side ?? "",
    anchor.span?.startLine ?? "",
    anchor.span?.endLine ?? "",
  ].join("|");
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
 * kept byte-identical; `changedPaths` are the successor's changed paths
 * (`changedPathsBetween`, or the handoff turn's `filesTouched`). Pure — no I/O, no model.
 *
 * The partition is TOTAL by construction: `beyondAsks = changedPaths \ askedPaths`, so
 * every changed path is exactly one of an ask's path or a beyond-asks path. The
 * assertion guards the skeleton: a changed path in neither bucket is a bug, never a
 * silent drop.
 */
export function buildDeltaAccount(input: {
  asks: readonly Disposition[];
  carried: readonly Disposition[];
  changedPaths: readonly string[];
}): DeltaAccount {
  const { asks, carried, changedPaths } = input;
  const carriedKeys = new Set(carried.map((disposition) => anchorKey(disposition.anchor)));
  const changed = new Set(changedPaths);
  const askedPaths = new Set(asks.map((ask) => ask.anchor.path));

  const accountedAsks: DeltaAskAccount[] = asks.map((ask) => {
    const carriedByLineage = carriedKeys.has(anchorKey(ask.anchor));
    const fileChanged = changed.has(ask.anchor.path);
    // Carried (target byte-identical): untouched, unless the agent changed the file
    // ELSEWHERE — then the flagged span survived but the file moved: partially addressed.
    // Not carried: the flagged target itself changed (reopened) or its file vanished
    // (orphaned/deleted) — either way the ask was addressed.
    const status = carriedByLineage
      ? fileChanged
        ? "partially-addressed"
        : "untouched"
      : "addressed";
    return {
      path: ask.anchor.path,
      ...(ask.anchor.span !== undefined ? { span: ask.anchor.span } : {}),
      ...(ask.anchor.side !== undefined ? { side: ask.anchor.side } : {}),
      type: ask.type,
      summary: summarise(ask.body),
      status,
    };
  });

  const beyondAsks = [...changed].filter((path) => !askedPaths.has(path)).sort();

  // The total-partition invariant: every changed path is an asked path or a beyond-ask
  // path, never both, never neither. This holds by construction; the assertion makes a
  // skeleton bug LOUD rather than a silent drop (issue #73's reconciliation invariant).
  for (const path of changed) {
    const asked = askedPaths.has(path);
    const beyond = beyondAsks.includes(path);
    if (asked === beyond) {
      throw new Error(
        `Delta account partition invariant violated for "${path}": asked=${asked} beyond=${beyond}`,
      );
    }
  }

  return { asks: accountedAsks, beyondAsks };
}
