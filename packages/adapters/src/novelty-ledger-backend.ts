import type { NoveltyResult } from "@rennet/core";
import type { Patchset } from "@rennet/types";
import type { NoveltyLedgerReader } from "./novelty-ledger-reader";

// ─────────────────────────────────────────────────────────────────────────────
// The `context.novelty` slice of a `CanvasOpsBackend` (issue #144, Repo-Map wave 5).
//
// The pure canvasOps@2 `context.novelty` tool calls `backend.novelty()` (issue
// #12's port pattern: capabilities are METHODS on the injected backend, so a new
// capability is one accessor the surface reaches uniformly — no `if (harness ===
// X)`, no descriptor knowing about a reader). This adapter is the real
// implementation of that accessor: it binds the fail-closed
// {@link NoveltyLedgerReader} to a per-review RESOLVED `{repoKey, patchset}`, so
// every call passes through the freshness + integrity gate (the reader pins the
// snapshot to the patchset's own `repository.baseOid` and refuses anything not
// fresh there) rather than the raw store.
//
// ── The patchset-source decision (mirror of #14/#169's base-OID call) ──────────
// `classifyNovelty` needs the PATCHSET, not just the base snapshot. The canvasOps@2
// backend context (`ReviewIdentity`) carries only the patchset IDENTITY
// (`patchsetId: string`), never the captured `Patchset` object — the real diff
// capture (`GitCaptureAdapter` / the changeset sources) produces the `Patchset`
// elsewhere in the review flow, and no canvasOps accessor yet exposes it. Rather
// than GUESS which layer owns handing the live patchset to the backend, this slice
// takes it via an INJECTED resolver — exactly the "a correct partial beats a wrong
// whole" call #14/#169 made for the base OID (`ResolvedRepoContext`). A review is
// against ONE change, so the RSP / ReviewIdentity layer that owns the captured
// patchset resolves `{repoKey, patchset}` once and hands it here as `resolve()`.
// The resolver is a function (not a frozen value) so a backend MAY re-resolve per
// call if the review's patchset is re-captured mid-session; the reader then refuses
// anything not fresh at whatever base OID the resolved patchset pins to. Keeping the
// resolution behind a function is what lets this stay node-free and lets a test
// drive absent/stale/corrupt deterministically. ⚑ FLAG for Rai: when the review
// flow grows a first-class "current patchset" accessor on the canvasOps backend
// context, this resolver is the seam to wire to it.
// ─────────────────────────────────────────────────────────────────────────────

/** The resolved per-review novelty context a `context.novelty` read is pinned to. */
export interface ResolvedNoveltyContext {
  /** The RepoRecord `repoKey` = `realpath(git-common-dir)` (R19) — the store key. */
  readonly repoKey: string;
  /**
   * The review's captured change. The reader pins the snapshot to this patchset's
   * `repository.baseOid` (R30 freshness), so a snapshot built at any other OID is
   * refused as stale rather than served.
   */
  readonly patchset: Patchset;
}

/** The one `CanvasOpsBackend` accessor this adapter supplies. */
export interface NoveltyBackendPart {
  novelty(): NoveltyResult;
}

/**
 * Build the `context.novelty` backend accessor from a {@link NoveltyLedgerReader}
 * and a per-review `{repoKey, patchset}` resolver. Spread the result into a full
 * `CanvasOpsBackend` (with the canvas/diff/run/context accessors) so the whole
 * canvasOps@2 surface reads through one injected backend.
 *
 * Every call re-invokes `resolve()` and passes its `{repoKey, patchset}` straight
 * into the reader gate, so freshness is always judged against the patchset's CURRENT
 * pinned base OID — a snapshot built at any other OID is refused as stale, never
 * served, so the ledger can never be computed against a mismatched baseline.
 */
export function noveltyBackend(
  reader: NoveltyLedgerReader,
  resolve: () => ResolvedNoveltyContext,
): NoveltyBackendPart {
  return {
    novelty(): NoveltyResult {
      const { repoKey, patchset } = resolve();
      return reader.classify(repoKey, patchset);
    },
  };
}
