import type {
  CanvasOpsBackend,
  ProjectReferenceResult,
  ProjectSymbolDefinitionResult,
} from "@rennet/core";
import type { Review, SymbolInspection } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// review.symbolLookup — the LIVE symbol inspector port (Rai, wireframes #8).
//
// The inspector's data source is Rennet's OWN model-free symbolic surface: the
// review's `CanvasOpsBackend` already answers `context.symbol` (go-to-definition
// over the exported-symbol index) and `context.references` (find-references over
// the identifier-occurrence index). This module calls BOTH for one clicked name and
// projects their gated results onto the plain `SymbolInspection` the UI renders —
// deterministic index reads, NO model spend.
//
// The projection is honest about the surface's own gating: a shard-decode or
// snapshot-gate failure rides back as an `unavailable` SECTION (never conflated with
// an empty `ok`), and a very long reference set is capped for display with the
// `truncated` flag set — the UI says "more exist" rather than rendering thousands of
// rows. The two mapping functions are pure and exported so the projection is unit-
// tested without composing a backend.
// ─────────────────────────────────────────────────────────────────────────────

/** The default ceiling on reference sites returned for display. */
export const DEFAULT_REFERENCE_CAP = 200;

/**
 * A shallow clone of the review whose ACTIVE patchset is pinned to its `headOid` —
 * so a backend built from it generates its ProjectSnapshot over the REVIEWED tree
 * (`base..head`), not the base tree. This matters: the symbolic surface is otherwise
 * a base-snapshot facility, so a symbol ADDED, RENAMED, or MOVED in the PR would
 * return missing/stale over the base — the inspector lying about the exact code under
 * review. Pinning to head makes go-to-definition / find-references answer about the
 * reviewed code, which is the whole point of clicking a symbol in the diff.
 *
 * `headOid` is always a real, present git object (`rev-parse HEAD` for a local
 * capture, the fetched PR head for a PR review), so the snapshot generator can read
 * it. (Uncommitted working-tree edits past `headOid` are not covered — the review's
 * own range is `base..head` committed, and that is what the reviewer is reading.)
 * Only the active patchset's `repository.baseOid` is changed; all else is preserved.
 */
export function reviewPinnedToHead(review: Review): Review {
  return {
    ...review,
    patchsets: review.patchsets.map((patchset) =>
      patchset.id === review.activePatchsetId
        ? {
            ...patchset,
            repository: { ...patchset.repository, baseOid: patchset.repository.headOid },
          }
        : patchset,
    ),
  };
}

/** Human-readable reason for a gated symbolic result that could not answer. */
function unavailableReason(result: { readonly reason: string }): string {
  if (result.reason === "shard-unavailable") return "the symbol index could not be read";
  return "the project snapshot is not available yet";
}

/** Project a `context.symbol` result onto the inspector's definition section. */
export function symbolDefinitionSection(
  result: ProjectSymbolDefinitionResult,
): SymbolInspection["definition"] {
  if (!result.ok) return { status: "unavailable", reason: unavailableReason(result) };
  return {
    status: "ok",
    sites: result.definitions.sites.map((site) => ({
      path: site.path,
      line: site.line,
      kind: site.kind,
      scope: site.scope,
    })),
  };
}

/** Project a `context.references` result onto the inspector's references section (capped). */
export function symbolReferencesSection(
  result: ProjectReferenceResult,
  cap: number = DEFAULT_REFERENCE_CAP,
): SymbolInspection["references"] {
  if (!result.ok) return { status: "unavailable", reason: unavailableReason(result) };
  const all = result.references.sites;
  const sites = all.slice(0, cap).map((site) => ({
    path: site.path,
    line: site.line,
    scope: site.scope,
  }));
  return { status: "ok", sites, truncated: all.length > cap };
}

/** Resolve one name to its definitions + references over a review's live backend. */
export function lookupSymbol(
  backend: CanvasOpsBackend,
  name: string,
  cap: number = DEFAULT_REFERENCE_CAP,
): SymbolInspection {
  return {
    name,
    definition: symbolDefinitionSection(backend.symbolDefinition({ name })),
    references: symbolReferencesSection(backend.references({ name }), cap),
  };
}

export interface LiveSymbolLookupDeps {
  /** Compose (or reuse) the review's live symbolic backend. */
  buildBackend(review: Review): Promise<CanvasOpsBackend>;
  /** Reference-site display cap; defaults to {@link DEFAULT_REFERENCE_CAP}. */
  readonly referenceCap?: number;
}

/**
 * The live `review.symbolLookup` port dispatch calls: build the review's backend,
 * then read both symbolic ops for the clicked name. Dispatch has already resolved +
 * freshness-pinned the review, so this never re-resolves it.
 */
export function createLiveSymbolLookup(
  deps: LiveSymbolLookupDeps,
): (input: { review: Review; name: string }) => Promise<SymbolInspection> {
  return async ({ review, name }) => {
    const backend = await deps.buildBackend(review);
    return lookupSymbol(backend, name, deps.referenceCap);
  };
}
