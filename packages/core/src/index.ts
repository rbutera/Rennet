import { createHash } from "node:crypto";
import {
  type AnchorSide,
  type AnchorSpan,
  DIFF_TRUNCATION_MARKER,
  type Disposition,
  type DispositionAnchor,
  type DispositionRelevanceJudge,
  type DispositionType,
  type PatchFile,
  type Patchset,
  type PublishThread,
  type RelevanceCandidate,
  type RelevanceVerdict,
  type Review,
  type ReviewPostTarget,
} from "@rennet/types";
import { v7 as uuidv7 } from "uuid";
import { buildDeltaAccount, changedPathsBetween } from "./delta-account";

export * from "./angle-generation";
export * from "./blast-radius";
export * from "./canvas";
export * from "./canvas-change-feed";
export * from "./canvas-ops";
export * from "./codex-run-turn";
export * from "./codex-utility-port";
export * from "./context-update-stream";
export * from "./coverage-mapping";
export * from "./decision-generation";
export * from "./decomposition";
export * from "./delta-account";
export * from "./draft-pr-body";
export * from "./dual-finding-review";
export * from "./dual-seat";
export * from "./element-diffs";
export * from "./escape-path";
export * from "./finding-generation";
export * from "./finding-reconcile";
export * from "./finding-verification";
export * from "./forge-port";
export * from "./handoff-compose";
export * from "./handoff-loop";
export * from "./harness";
export * from "./harness-run-turn";
export * from "./hypothesis-generation";
export * from "./invocation-budget";
export * from "./knowledge";
export * from "./knowledge-generation";
export * from "./lineage-matcher";
export * from "./lineage-matcher-fixtures";
export * from "./model-council";
export * from "./noise-generation";
export * from "./novelty-ledger";
export * from "./novelty-lifecycle";
export * from "./openspec-change";
export * from "./orchestrator-primer";
export * from "./orchestrator-session";
export * from "./ordering-pass";
export * from "./patchset-intent";
export * from "./pipeline";
export * from "./project-context";
export * from "./project-snapshot";
export * from "./publish-review";
export * from "./publish-submission";
export * from "./refine-comment";
export * from "./review-ask";
export * from "./review-backend";
export * from "./risk-crosscheck";
export * from "./rollup-narration";
export * from "./route-plan";
export * from "./settings-resolver";
export * from "./snapshot-overlay";

export type ReviewEvent =
  | {
      type: "ReviewCreated";
      version: 1;
      reviewId: string;
      patchset: Patchset;
      /** Opened read-only, over a merged/any PR: MAIN refuses egress (see `Review.retrospective`). */
      retrospective?: boolean;
      /** The real PR post-target (issue #21); present only on a non-retrospective PR review. */
      postTarget?: ReviewPostTarget;
    }
  | { type: "PatchsetActivated"; version: 1; reviewId: string; patchset: Patchset }
  | {
      type: "DispositionSet";
      version: 1;
      reviewId: string;
      patchsetId: string;
      disposition: Disposition;
    }
  | {
      type: "DispositionCleared";
      version: 1;
      reviewId: string;
      patchsetId: string;
      path: string;
      // Span identity for a span-grained clear (issue #78). Absent ⇒ a
      // path-grained clear (clears the file-level disposition, unchanged).
      span?: AnchorSpan;
      side?: AnchorSide;
    }
  | {
      // The relevance-judge re-attach (issue #78). Emitted by
      // `recaptureWithRelevance` after the floor fold, carrying the
      // judge-approved (validated, re-anchored) dispositions.
      type: "DispositionsCarried";
      version: 1;
      reviewId: string;
      patchsetId: string;
      carried: Disposition[];
    }
  | { type: "ReviewInvalidated"; version: 1; reviewId: string; candidate: Patchset };

export interface PatchsetCapturePort {
  capture(repositoryPath: string): Promise<Patchset>;
}

export interface ReviewStorePort {
  /**
   * The most recent review. Scoped to a single repository when a root is given
   * (create-vs-activate for a capture), or globally for bootstrap restore.
   */
  latestReview(repositoryRoot?: string): Review | null;
  /** A specific review by id, independent of which repository is most recent. */
  reviewById(reviewId: string): Review | null;
  receipt(commandId: string, digest: string): Review | null;
  commit(commandId: string, digest: string, events: ReviewEvent[], result: Review): Review;
}

function exhaustive(value: never): never {
  throw new Error(`Unknown review event: ${JSON.stringify(value)}`);
}

/**
 * The exact-match content key for a changed file: a hash of its patch text.
 * Two anchors are "the same file, unchanged" iff their `path` and this digest
 * both match. This is the whole-file (path-grained) carry key.
 */
export function fileContentDigest(file: PatchFile): string {
  return createHash("sha256").update(file.patch).digest("hex");
}

/**
 * Whether `file.patch` fully certifies the file's content, so that hashing it
 * (`fileContentDigest`) yields a trustworthy content identity. The capture layer
 * makes `patch` LOSSY in two ways, and in both a `fileContentDigest` match no
 * longer proves the file is unchanged (issue workspace-ndyv4, item 2):
 *
 *  - TRUNCATED: `visible()` caps a patch at 256 KiB and appends
 *    `DIFF_TRUNCATION_MARKER`. Two files identical in their first 256 KiB but
 *    differing beyond it produce the same truncated patch, hence the same
 *    digest — a real change past the cap would wrongly carry.
 *  - CONTENT-FREE BINARY: an untracked binary (and any binary in a range diff
 *    captured without `--binary`) renders as `Binary files … differ` with no
 *    embedded bytes and no `GIT binary patch` body, so ANY two binary contents
 *    at that path share a digest.
 *
 * Returning false here makes the path-grained carry fail closed: the disposition
 * drops and the file is re-reviewed (or offered to the relevance judge), rather
 * than a stale review silently surviving a content change we cannot verify. A
 * complete patch (a small unchanged file, or a tracked binary whose bytes ARE
 * embedded) returns true and carries as before — no over-drop.
 *
 * Both tests match the producer's exact STRUCTURAL framing, never a loose
 * substring, so ordinary patch content cannot spoof either signal:
 *  - `visible()` appends the marker as the patch's terminal `\n\n<marker>`, so
 *    we test `endsWith`, not `includes` — a source line that merely contains the
 *    marker text (e.g. this repo's own declaration of it) is a complete patch and
 *    must still carry.
 *  - a real `GIT binary patch` body is a header on its OWN line, so we test for
 *    `\nGIT binary patch\n` — a filename such as `GIT binary patch.png` puts the
 *    phrase in the content-free `diff --git`/`Binary files` lines but never as a
 *    standalone header line, so it stays (correctly) uncertified.
 */
const DIFF_TRUNCATION_SUFFIX = `\n\n${DIFF_TRUNCATION_MARKER}`;
const GIT_BINARY_PATCH_HEADER = "\nGIT binary patch\n";

/**
 * Whether `visible()` truncated this patch at the 256 KiB cap. It appends the
 * marker as the patch's terminal `\n\n<marker>`, so we test `endsWith`, never a
 * bare `includes` — a source line that merely contains the marker text (e.g. this
 * repo's own declaration of it) is a COMPLETE patch and must not read as truncated.
 * The single source of truth for the truncation signal, shared by the path-grained
 * certification (`patchCertifiesContent`) and the span-grained carry (issue
 * workspace-girqg, Finding A).
 */
function patchTruncated(file: PatchFile): boolean {
  return file.patch.endsWith(DIFF_TRUNCATION_SUFFIX);
}

function patchCertifiesContent(file: PatchFile): boolean {
  if (patchTruncated(file)) return false;
  if (file.binary && !file.patch.includes(GIT_BINARY_PATCH_HEADER)) return false;
  return true;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * A stable identity string for a disposition anchor (issue #78). Path-grained
 * anchors key on `path` (unchanged); span-grained anchors key on
 * `path#L<start>-L<end>@<side>`, so two spans on one file — and a path-grained +
 * a span disposition on the same file — coexist and clear independently. Only
 * `path`/`span`/`side` participate; the content/span digests do not.
 */
export function anchorKey(anchor: Pick<DispositionAnchor, "path" | "span" | "side">): string {
  if (anchor.span && anchor.side) {
    const end = anchor.span.endLine ?? anchor.span.startLine;
    return `${anchor.path}#L${anchor.span.startLine}-L${end}@${anchor.side}`;
  }
  return anchor.path;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The exact side-text at a 1-based FILE-LINE span (issue #78). `side` selects
 * the image the span reads: `additions`/`context` → the post-image (new-file)
 * lines; `deletions` → the pre-image (old-file) lines. Walks the unified
 * `@@ -a,b +c,d @@` hunks of `file.patch`, mapping each body line to its file
 * line number on the chosen image, and returns the joined source text of the
 * span's lines (prefix stripped), or `undefined` when any requested line is out
 * of bounds / the side has no such line / the file has no such image. Registrar-
 * independent — it never consults a CodeView occurrence ordinal (#84-clean).
 */
export function extractSpanText(
  file: PatchFile,
  span: AnchorSpan,
  side: AnchorSide,
): string | undefined {
  const start = span.startLine;
  const end = span.endLine ?? start;
  if (start < 1 || end < start) return undefined;
  // Post-image (additions/context) is keyed by new-file line; pre-image
  // (deletions) by old-file line. Both accumulate context lines, which live in
  // both images.
  const post = side !== "deletions";
  const byLine = new Map<number, string>();
  const lines = file.patch.split("\n");
  let newLine = 0;
  let oldLine = 0;
  let inHunk = false;
  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const marker = line.charAt(0);
    if (marker === "+") {
      if (post) byLine.set(newLine, line.slice(1));
      newLine += 1;
    } else if (marker === "-") {
      if (!post) byLine.set(oldLine, line.slice(1));
      oldLine += 1;
    } else if (marker === " ") {
      byLine.set(post ? newLine : oldLine, line.slice(1));
      newLine += 1;
      oldLine += 1;
    }
    // Any other line (e.g. "\ No newline at end of file") advances nothing.
  }
  const out: string[] = [];
  for (let n = start; n <= end; n += 1) {
    const text = byLine.get(n);
    if (text === undefined) return undefined; // out of bounds / side has no such line
    out.push(text);
  }
  return out.join("\n");
}

/**
 * Whether one anchor carries forward onto `file` (the successor at its path) by
 * the deterministic FLOOR (issue #78). Span-grained: the successor's side-text
 * at the SAME file-line span is defined and byte-identical to `spanDigest` — so
 * an unchanged span carries even when the file changed elsewhere, and a shifted
 * or edited span drops (the judge's job, not the floor's). A TRUNCATED successor
 * patch (256 KiB cap) cannot certify a span's side-text — the cut may fall
 * mid-line — so the span fails closed (issue workspace-girqg, Finding A).
 * Path-grained: the whole file is byte-identical. `undefined` file (path gone)
 * never carries.
 */
function anchorCarries(anchor: DispositionAnchor, file: PatchFile | undefined): boolean {
  if (!file) return false;
  if (anchor.span && anchor.side && anchor.spanDigest) {
    // A span carry certifies the successor's side-text at this file-line span is
    // byte-identical. A truncated patch cannot certify that: `visible()` caps at
    // 256 KiB, possibly cutting mid-line, and `extractSpanText` reads the truncated
    // prefix as a complete line — so two contents identical up to the cut but
    // differing past it share a `spanDigest`, and a stale span would carry. Fail
    // closed on any truncated successor, exactly as the path branch does for a lossy
    // patch (issue workspace-girqg, Finding A; same lossiness class as
    // workspace-ndyv4 item 2, on the span path — issue #78 lineage).
    if (patchTruncated(file)) return false;
    const text = extractSpanText(file, anchor.span, anchor.side);
    return text !== undefined && sha256Hex(text) === anchor.spanDigest;
  }
  // Path-grained: a byte-identical whole file carries — but only when the patch
  // fully certifies the content. A lossy patch (truncated past 256 KiB, or a
  // content-free binary diff) has a digest that cannot prove the tail is
  // unchanged, so it fails closed and re-reviews rather than carrying a stale
  // disposition over content we cannot see (issue workspace-ndyv4, item 2).
  if (!patchCertifiesContent(file)) return false;
  return fileContentDigest(file) === anchor.contentDigest;
}

/**
/**
 * Carry a SPAN-grained disposition across a git RENAME, byte-verified — or return
 * null (reopen) when it cannot be certified. This is the ONE safe move-carry: the
 * renamed file's side-text at the SAME file-line span is byte-identical to what the
 * reviewer approved (`spanDigest` matches), so the approval re-anchors to the new
 * path. Safety is the byte-identity, not the fuzzy `move` class — it is decoupled
 * from `AUTO_CARRY_LINEAGES` (which stays exact-only for the graph consumer) on
 * purpose. The target is git's DETERMINISTIC rename link (`previousPath`), never a
 * similarity match, so a duplicated span elsewhere cannot steal it.
 *
 * PATH-grained renames are NOT carried: a real rename's whole-file patch differs
 * from the original in its `diff --git`/`index`/`+++` headers, so `fileContentDigest`
 * never matches on adapter output (issue #16, Opus F1 — a dead branch, removed).
 * A path-grained disposition on a rename therefore reopens.
 */
function carrySpanMoveOntoRename(disposition: Disposition, renamed: PatchFile): Disposition | null {
  const { anchor } = disposition;
  if (!(anchor.span && anchor.side && anchor.spanDigest)) return null; // path-grained → reopen
  if (patchTruncated(renamed)) return null; // a truncated successor cannot certify
  const text = extractSpanText(renamed, anchor.span, anchor.side);
  if (text === undefined || sha256Hex(text) !== anchor.spanDigest) return null;
  return {
    ...disposition,
    anchor: { ...anchor, path: renamed.path, contentDigest: fileContentDigest(renamed) },
  };
}

/**
 * Carry dispositions across a re-capture (issue #16), by the FILE-level lineage.
 * DETERMINISTIC — no fuzzy matching decides a carry here. Returns the carried set
 * AND the orphan tray:
 *
 *  - EXACT (same path, byte-identical): carries unchanged — the preserved #10
 *    byte-identical floor (`anchorCarries`), including its lossy-patch and
 *    span-truncation fail-closed. This branch is byte-for-byte the old behaviour.
 *  - MOVED (git rename, `previousPath`): a SPAN-grained disposition whose side-text
 *    is byte-identical at the new path CARRIES, re-anchored (`carrySpanMoveOntoRename`);
 *    a path-grained disposition, or a span whose text changed, REOPENS (dropped).
 *    A rename is a relocation, so it is never orphaned. Move carry here is git's
 *    deterministic rename link + byte-identity, NOT the fuzzy `move` class (which
 *    was disproven and excluded from the graph auto-carry — see the verdict doc).
 *  - VANISHED (file deleted, or gone from the changeset with no rename link):
 *    ORPHANED — surfaced against its last-known version, NEVER dropped to void
 *    (§3.4: "a vanished occurrence orphans, surfaced").
 *  - PRESENT-BUT-CHANGED: dropped → reopens for review.
 *
 * The fuzzy occurrence matcher (`lineage-matcher`, the spike) is a SEPARATE
 * mechanism for sub-file occurrence lineage (#18's delta re-review consumes it via
 * `resolveAnchor`); it does NOT drive this seam.
 */
export function carryDispositionsByLineage(
  previous: Disposition[],
  next: Patchset,
): { carried: Disposition[]; orphaned: Disposition[] } {
  const fileByPath = new Map(next.files.map((file) => [file.path, file] as const));
  const renameByPrevious = new Map<string, PatchFile>();
  for (const file of next.files) {
    if (file.status === "renamed" && file.previousPath !== undefined) {
      renameByPrevious.set(file.previousPath, file);
    }
  }
  const carried: Disposition[] = [];
  const orphaned: Disposition[] = [];
  for (const disposition of previous) {
    const path = disposition.anchor.path;
    const sameFile = fileByPath.get(path);
    if (sameFile) {
      // A deletion at the same path is a vanished occurrence, not a change.
      if (sameFile.status === "deleted") {
        orphaned.push(disposition);
      } else if (anchorCarries(disposition.anchor, sameFile)) {
        carried.push(disposition); // EXACT — the preserved floor
      }
      // else: present but changed → reopen (dropped, not orphaned)
      continue;
    }
    const renamed = renameByPrevious.get(path);
    if (renamed) {
      // Byte-verified span move-carry, else reopen. Never orphaned (it relocated).
      const moved = carrySpanMoveOntoRename(disposition, renamed);
      if (moved) carried.push(moved);
      continue;
    }
    // Truly vanished from the changeset → orphaned; surfaced, never vanishes.
    orphaned.push(disposition);
  }
  return { carried, orphaned };
}

/**
 * Split the prior dispositions into the floor-carried set and the dropped set
 * (offered to the relevance judge as candidates). Pure. Each candidate carries
 * the successor patch text when its file survives (absent when the file is
 * gone). Verdicts returned by the judge are positional to `candidates`.
 */
export function partitionCarry(
  previous: Disposition[],
  next: Patchset,
): { carried: Disposition[]; candidates: RelevanceCandidate[] } {
  const fileByPath = new Map(next.files.map((file) => [file.path, file] as const));
  const carried: Disposition[] = [];
  const candidates: RelevanceCandidate[] = [];
  for (const disposition of previous) {
    const file = fileByPath.get(disposition.anchor.path);
    if (anchorCarries(disposition.anchor, file)) carried.push(disposition);
    else candidates.push({ disposition, ...(file ? { successorPatch: file.patch } : {}) });
  }
  return { carried, candidates };
}

/**
 * Re-anchor a dropped disposition onto `next` per the judge's re-anchor, or
 * return null (fail-closed) when the target file is gone or the re-anchor span
 * is out of bounds. A re-anchored span recomputes `spanDigest` from `next` so
 * the carried disposition is self-consistent for the NEXT re-capture.
 */
function reanchor(
  original: Disposition,
  reAnchor: DispositionAnchor,
  fileByPath: ReadonlyMap<string, PatchFile>,
): Disposition | null {
  // A partial span/side re-anchor is malformed → fail-closed (never silently
  // degrade a span re-anchor to a file-level anchor).
  if ((reAnchor.span === undefined) !== (reAnchor.side === undefined)) return null;
  const file = fileByPath.get(reAnchor.path);
  if (!file) return null;
  if (reAnchor.span && reAnchor.side) {
    const text = extractSpanText(file, reAnchor.span, reAnchor.side);
    if (text === undefined) return null; // out of bounds → fail-closed
    return {
      ...original,
      anchor: {
        path: reAnchor.path,
        contentDigest: fileContentDigest(file),
        span: reAnchor.span,
        side: reAnchor.side,
        spanDigest: sha256Hex(text),
      },
    };
  }
  return { ...original, anchor: { path: reAnchor.path, contentDigest: fileContentDigest(file) } };
}

/**
 * Internal: apply verdicts, returning both the carried dispositions and the set
 * of candidate indices that were carried — so `carryWithRelevance` computes the
 * orphaned remainder without re-deriving the fail-closed logic.
 */
function applyVerdicts(
  candidates: RelevanceCandidate[],
  verdicts: RelevanceVerdict[],
  next: Patchset,
): { carried: Disposition[]; carriedIndices: Set<number> } {
  const fileByPath = new Map(next.files.map((file) => [file.path, file] as const));
  const carried: Disposition[] = [];
  const carriedIndices = new Set<number>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const verdict = verdicts[index];
    if (!candidate || !verdict?.carry) continue;
    const original = candidate.disposition;
    // A carry-true verdict ALWAYS re-validates against `next` (fail-closed):
    // re-anchor to the verdict's target when supplied, else re-validate the
    // ORIGINAL anchor in place (re-digested from `next`). A gone file or an
    // out-of-bounds span drops — never keep a stale anchor pointing at content
    // that no longer exists.
    const reAnchored = reanchor(original, verdict.reAnchor ?? original.anchor, fileByPath);
    if (reAnchored === null) continue; // fail-closed: a bad re-anchor is dropped
    carried.push(reAnchored);
    carriedIndices.add(index);
  }
  return { carried, carriedIndices };
}

/**
 * Apply the judge's verdicts to the dropped candidates (issue #78). Pure. A
 * `carry: true` verdict re-attaches the disposition, re-anchored to the
 * verdict's span/path when supplied, else re-validated at its ORIGINAL anchor;
 * in both cases `spanDigest` is recomputed from `next` and a gone file, an
 * out-of-bounds span, or a malformed re-anchor is DROPPED (fail-closed).
 */
export function applyRelevanceVerdicts(
  candidates: RelevanceCandidate[],
  verdicts: RelevanceVerdict[],
  next: Patchset,
): Disposition[] {
  return applyVerdicts(candidates, verdicts, next).carried;
}

/**
 * Carry above the floor (issue #78): floor → judge(candidates) → apply. The
 * carried set is the floor-carried plus the judge-approved; everything the floor
 * dropped and the judge declined (or re-anchored out of bounds) is orphaned (the
 * tray). The judge is a port — inject a stub in CI; the model never runs here.
 */
export async function carryWithRelevance(
  previous: Disposition[],
  next: Patchset,
  judge: DispositionRelevanceJudge,
): Promise<{ carried: Disposition[]; orphaned: Disposition[] }> {
  const { carried: floorCarried, candidates } = partitionCarry(previous, next);
  const verdicts = candidates.length ? await judge.judge(candidates, next) : [];
  const { carried: judgeCarried, carriedIndices } = applyVerdicts(candidates, verdicts, next);
  const orphaned = candidates
    .filter((_, index) => !carriedIndices.has(index))
    .map((candidate) => candidate.disposition);
  return { carried: [...floorCarried, ...judgeCarried], orphaned };
}

/**
 * Map a disposition to the GitHub review-thread publish payload (issue #78 — the
 * single line/side contract #22 and #21 build on once). A span disposition →
 * `line` (span end) + `startLine` (only when multi-line) + `side` (deletions →
 * LEFT / old file; additions and context → RIGHT / new file). A path-grained
 * disposition → a file-level payload (no line/side).
 */
export function toPublishThread(disposition: Disposition): PublishThread {
  const { anchor, type, body } = disposition;
  if (anchor.span && anchor.side) {
    const start = anchor.span.startLine;
    const end = anchor.span.endLine ?? start;
    const publishSide: "LEFT" | "RIGHT" = anchor.side === "deletions" ? "LEFT" : "RIGHT";
    return {
      path: anchor.path,
      line: end,
      ...(end > start ? { startLine: start } : {}),
      side: publishSide,
      body,
      type,
    };
  }
  return { path: anchor.path, body, type };
}

function requireActivePatchset(
  current: Review | null,
  event: { reviewId: string; patchsetId: string },
): Review {
  if (!current || current.id !== event.reviewId || current.activePatchsetId !== event.patchsetId) {
    throw new Error("A disposition must target the active patchset");
  }
  return current;
}

/**
 * Whether a review's PR post-target (issue #21) survives activating `patchset`.
 * It survives ONLY while the activated patchset is still the forge PR's OWN patchset:
 * a github source (`github-local`/`github-rest`) AT THE SAME reviewed head the target
 * was minted for. A local working-tree recapture (source `local`/absent) or a moved
 * head drops it — so a PR review recaptured locally cannot post its local diffs to the
 * real PR. Returns the target unchanged when it survives, else `undefined`.
 */
function postTargetSurvivingActivation(
  postTarget: ReviewPostTarget | undefined,
  patchset: Patchset,
): ReviewPostTarget | undefined {
  if (!postTarget) return undefined;
  const isForgePr = patchset.source === "github-local" || patchset.source === "github-rest";
  if (isForgePr && patchset.repository.headOid === postTarget.headOid) return postTarget;
  return undefined;
}

export function foldReview(current: Review | null, event: ReviewEvent): Review {
  switch (event.type) {
    case "ReviewCreated":
      return {
        id: event.reviewId,
        repositoryRoot: event.patchset.repository.root,
        patchsets: [event.patchset],
        activePatchsetId: event.patchset.id,
        dispositions: [],
        status: "current",
        // Only stamp the flag when the review is retrospective, so a normal review's
        // snapshot is byte-identical to before (back-compat with persisted state).
        ...(event.retrospective ? { retrospective: true } : {}),
        // Only stamp the post-target when one was supplied (a non-retrospective PR
        // review). A local capture / retrospective review omits it, so its snapshot
        // stays byte-identical to before (back-compat with persisted state).
        ...(event.postTarget ? { postTarget: event.postTarget } : {}),
      };
    case "PatchsetActivated": {
      if (!current || current.id !== event.reviewId) {
        throw new Error("Cannot activate a patchset for an unknown review");
      }
      const patchsets = current.patchsets.some((patchset) => patchset.id === event.patchset.id)
        ? current.patchsets
        : [...current.patchsets, event.patchset];
      // Strip the PR post-target from the base and re-add it ONLY if it survives this
      // activation (issue #21). A PR review can be locally recaptured under the same
      // review id (`review.capture`/`regenerate` → PatchsetActivated), which would
      // otherwise inherit the PR's egress target onto local working-tree content — so
      // the human could sign local diffs that post to a real PR. The target survives
      // ONLY while the activated patchset is still the forge PR's OWN patchset (a
      // github source at the same reviewed head); otherwise it is dropped and the
      // review becomes an unpostable local review (the "no postTarget → refused" gate
      // then handles egress for free).
      const { postTarget: priorTarget, ...base } = current;
      const postTarget = postTargetSurvivingActivation(priorTarget, event.patchset);
      // Lineage-driven carry (issue #16): byte-identical exact carries (the #10
      // floor, unchanged), a byte-verifiable rename carries re-anchored, a vanished
      // occurrence orphans (surfaced, never dropped to void), everything else reopens.
      const { carried, orphaned } = carryDispositionsByLineage(
        current.dispositions,
        event.patchset,
      );
      // The delta re-review account (issue #73): when this activation SUCCEEDS a
      // predecessor patchset that carried asks, record what the successor did to each
      // ask (addressed / partially / untouched) and the paths it changed beyond any
      // ask. Deterministic and model-free — computed from the carry + the changed-path
      // set. Only stamped on a genuine successor (a distinct prior patchset with asks),
      // so a first capture / PR open carries no account and validates unchanged.
      const priorPatchset = current.patchsets.find(
        (patchset) => patchset.id === current.activePatchsetId,
      );
      const deltaAccount =
        priorPatchset && priorPatchset.id !== event.patchset.id && current.dispositions.length > 0
          ? buildDeltaAccount({
              asks: current.dispositions,
              carried,
              changedPaths: changedPathsBetween(priorPatchset, event.patchset),
              // The successor's git rename links (old→new), so a rename target of an
              // asked/carried file is recognised as the ask's own relocated content and
              // never mistaken for scope-creep.
              renames: event.patchset.files.flatMap((file) =>
                file.status === "renamed" && file.previousPath !== undefined
                  ? [{ from: file.previousPath, to: file.path }]
                  : [],
              ),
            })
          : undefined;
      return {
        ...base,
        patchsets,
        activePatchsetId: event.patchset.id,
        pendingPatchsetId: undefined,
        dispositions: carried,
        // Stamped only on a successor with asks to account for; absent otherwise so a
        // first capture and every existing snapshot validate unchanged (like `orphaned`).
        ...(deltaAccount ? { deltaAccount } : { deltaAccount: undefined }),
        // The orphan tray is recomputed for THIS activation and is authoritative:
        // set the fresh set, or `undefined` to clear any stale tray inherited from
        // `base` (a vanished-then-returned occurrence must not stay orphaned). An
        // undefined field is absent for equality and nothing digests a Review, so
        // an orphan-free review stays back-compatible with pre-feature snapshots.
        orphaned: orphaned.length ? orphaned : undefined,
        status: "current",
        ...(postTarget ? { postTarget } : {}),
      };
    }
    case "DispositionSet": {
      const review = requireActivePatchset(current, event);
      // Fold identity is the FULL anchor (issue #78): dedup + sort by anchorKey,
      // so two spans on one file (and a path-grained + a span disposition on the
      // same file) coexist; a re-set on the same span replaces.
      const key = anchorKey(event.disposition.anchor);
      const dispositions = review.dispositions.filter(
        (existing) => anchorKey(existing.anchor) !== key,
      );
      dispositions.push(event.disposition);
      dispositions.sort((left, right) =>
        anchorKey(left.anchor).localeCompare(anchorKey(right.anchor)),
      );
      return { ...review, dispositions };
    }
    case "DispositionCleared": {
      const review = requireActivePatchset(current, event);
      // Clear by anchorKey: a bare-path clear (span/side absent) still clears the
      // file-level disposition; a span clear names its span/side.
      const key = anchorKey({ path: event.path, span: event.span, side: event.side });
      return {
        ...review,
        dispositions: review.dispositions.filter((existing) => anchorKey(existing.anchor) !== key),
      };
    }
    case "DispositionsCarried": {
      const review = requireActivePatchset(current, event);
      // Union the judge-approved dispositions into the set (they target the new
      // active patchset), replacing any existing entry at the same anchor key.
      const dispositions = [...review.dispositions];
      for (const carried of event.carried) {
        const key = anchorKey(carried.anchor);
        const index = dispositions.findIndex((existing) => anchorKey(existing.anchor) === key);
        if (index >= 0) dispositions[index] = carried;
        else dispositions.push(carried);
      }
      dispositions.sort((left, right) =>
        anchorKey(left.anchor).localeCompare(anchorKey(right.anchor)),
      );
      return { ...review, dispositions };
    }
    case "ReviewInvalidated": {
      if (!current || current.id !== event.reviewId) {
        throw new Error("Cannot invalidate an unknown review");
      }
      const patchsets = current.patchsets.some((patchset) => patchset.id === event.candidate.id)
        ? current.patchsets
        : [...current.patchsets, event.candidate];
      return {
        ...current,
        patchsets,
        pendingPatchsetId: event.candidate.id,
        status: "invalid",
      };
    }
    default:
      return exhaustive(event);
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function payloadDigest(payload: unknown): string {
  return createHash("sha256").update(stable(payload)).digest("hex");
}

export class ReviewService {
  constructor(
    private readonly capturePort: PatchsetCapturePort,
    private readonly store: ReviewStorePort,
  ) {}

  bootstrap(): Review | null {
    return this.store.latestReview();
  }

  async capture(commandId: string, repositoryPath: string, reviewId?: string): Promise<Review> {
    const digest = payloadDigest({ repositoryPath, reviewId });
    const receipt = this.store.receipt(commandId, digest);
    if (receipt) return receipt;

    const patchset = await this.capturePort.capture(repositoryPath);
    const current = this.store.latestReview(repositoryPath);
    const event: ReviewEvent =
      current && current.id === reviewId
        ? { type: "PatchsetActivated", version: 1, reviewId: current.id, patchset }
        : { type: "ReviewCreated", version: 1, reviewId: uuidv7(), patchset };
    const review = foldReview(current && event.type !== "ReviewCreated" ? current : null, event);
    return this.store.commit(commandId, digest, [event], review);
  }

  /**
   * Open a review from a pre-built patchset — the GitHub PR front door (User
   * Journey stage 2, the second v1 source). The local working-tree `capture()`
   * path builds the patchset itself; here the GitHub changeset source has already
   * produced the immutable patchset from a PR range, so this just mints the
   * `ReviewCreated` event and persists it. The review then lands in the identical
   * surface and decomposition pipeline the local source feeds — one engine, two
   * sources. Idempotent on `commandId` like every other write.
   *
   * `options.retrospective` opens the review READ-ONLY (over an already-merged or
   * any PR): the created review carries the flag through to MAIN, which structurally
   * refuses egress, and to the renderer, which hides the sign/publish affordance. It
   * is part of the idempotency digest, so a retrospective open and a live open of the
   * same patchset are distinct writes rather than colliding on one receipt.
   */
  async createReviewFromPatchset(
    commandId: string,
    patchset: Patchset,
    options?: { retrospective?: boolean; postTarget?: ReviewPostTarget },
  ): Promise<Review> {
    const retrospective = options?.retrospective ?? false;
    // A retrospective review must never carry a post-target (nothing may be posted
    // from it), so drop it defensively even if a caller supplied both.
    const postTarget = retrospective ? undefined : options?.postTarget;
    const digest = payloadDigest({
      patchsetId: patchset.id,
      mode: "open-pr",
      retrospective,
      // The post-target is part of the review's identity: two opens of the same
      // patchset against different PR coordinates are different reviews.
      postTarget: postTarget ?? null,
    });
    const receipt = this.store.receipt(commandId, digest);
    if (receipt) return receipt;
    const event: ReviewEvent = {
      type: "ReviewCreated",
      version: 1,
      reviewId: uuidv7(),
      patchset,
      ...(retrospective ? { retrospective: true } : {}),
      ...(postTarget ? { postTarget } : {}),
    };
    const review = foldReview(null, event);
    return this.store.commit(commandId, digest, [event], review);
  }

  /**
   * Record or clear a disposition against a file in the active patchset.
   * A `disposition` type sets/replaces it; `null` clears it (the "mark unread"
   * path). Setting resolves the anchor's content digest from the active
   * patchset so the disposition can be carried across a later re-capture.
   */
  setDisposition(
    commandId: string,
    reviewId: string,
    patchsetId: string,
    path: string,
    disposition: DispositionType | null,
    body: string,
    span?: AnchorSpan,
    side?: AnchorSide,
  ): Review {
    // A span anchor (issue #78) needs both the span and its side; supplying one
    // without the other is a caller error (mirrors the protocol all-or-none rule).
    if ((span === undefined) !== (side === undefined)) {
      throw new Error("A span disposition needs both a span and a side");
    }
    const digest = payloadDigest({ reviewId, patchsetId, path, disposition, body, span, side });
    const receipt = this.store.receipt(commandId, digest);
    if (receipt) return receipt;
    const current = this.requireReview(reviewId);
    let event: ReviewEvent;
    if (disposition === null) {
      event = { type: "DispositionCleared", version: 1, reviewId, patchsetId, path, span, side };
    } else {
      const active = current.patchsets.find((patchset) => patchset.id === current.activePatchsetId);
      const file = active?.files.find((candidate) => candidate.path === path);
      if (!file) {
        throw new Error("Cannot set a disposition on a path outside the active patchset");
      }
      let anchor: DispositionAnchor;
      if (span && side) {
        // A truncated active patch (visible() caps at 256 KiB, possibly cutting
        // mid-line) cannot certify the span's side-text: extractSpanText reads the
        // truncated prefix as a COMPLETE line, so a spanDigest minted here could
        // later match a complete, shortened successor whose real line equals that
        // prefix — a stale disposition would carry (fail-open). Refuse to author a
        // span digest over content past the cut, the authoring-side twin of the
        // carry-path gate (issue workspace-u0zoc; workspace-girqg Finding A;
        // patchTruncated is the single source of truth for the truncation signal).
        if (patchTruncated(file)) {
          throw new Error(
            "Cannot set a span disposition: the file's patch is truncated (256 KiB cap), so the span content cannot be certified",
          );
        }
        const spanText = extractSpanText(file, span, side);
        if (spanText === undefined) {
          throw new Error("Cannot set a span disposition: the span is out of bounds for the file");
        }
        anchor = {
          path,
          contentDigest: fileContentDigest(file),
          span,
          side,
          spanDigest: sha256Hex(spanText),
        };
      } else {
        anchor = { path, contentDigest: fileContentDigest(file) };
      }
      event = {
        type: "DispositionSet",
        version: 1,
        reviewId,
        patchsetId,
        disposition: { anchor, type: disposition, body },
      };
    }
    return this.store.commit(commandId, digest, [event], foldReview(current, event));
  }

  /**
   * The relevance-judged re-capture (issue #78, Rai's #48 ruling): capture →
   * PatchsetActivated (the deterministic floor via the fold) → run the judge on
   * the dropped candidates → commit a `DispositionsCarried` event re-attaching
   * the judge-approved (validated, re-anchored) dispositions. The default
   * `capture()` path stays floor-only. The judge is a PORT: CI injects a stub;
   * the model never runs here.
   */
  async recaptureWithRelevance(
    commandId: string,
    repositoryPath: string,
    reviewId: string,
    judge: DispositionRelevanceJudge,
  ): Promise<Review> {
    const digest = payloadDigest({ repositoryPath, reviewId, mode: "relevance" });
    const receipt = this.store.receipt(commandId, digest);
    if (receipt) return receipt;
    const current = this.requireReview(reviewId);
    const previous = current.dispositions;
    const patchset = await this.capturePort.capture(repositoryPath);
    const activated: ReviewEvent = {
      type: "PatchsetActivated",
      version: 1,
      reviewId: current.id,
      patchset,
    };
    const afterFloor = foldReview(current, activated);
    const { candidates } = partitionCarry(previous, patchset);
    const verdicts = candidates.length ? await judge.judge(candidates, patchset) : [];
    const judgeCarried = applyRelevanceVerdicts(candidates, verdicts, patchset);
    const events: ReviewEvent[] = [activated];
    let result = afterFloor;
    if (judgeCarried.length) {
      const carriedEvent: ReviewEvent = {
        type: "DispositionsCarried",
        version: 1,
        reviewId: current.id,
        patchsetId: patchset.id,
        carried: judgeCarried,
      };
      events.push(carriedEvent);
      result = foldReview(afterFloor, carriedEvent);
    }
    return this.store.commit(commandId, digest, events, result);
  }

  async checkFreshness(
    commandId: string,
    reviewId: string,
    repositoryPath: string,
  ): Promise<Review> {
    const digest = payloadDigest({ reviewId, repositoryPath });
    const receipt = this.store.receipt(commandId, digest);
    if (receipt) return receipt;
    const current = this.requireReview(reviewId);
    const candidate = await this.capturePort.capture(repositoryPath);
    if (candidate.id === current.activePatchsetId || candidate.id === current.pendingPatchsetId) {
      return this.store.commit(commandId, digest, [], current);
    }
    const event: ReviewEvent = {
      type: "ReviewInvalidated",
      version: 1,
      reviewId,
      candidate,
    };
    return this.store.commit(commandId, digest, [event], foldReview(current, event));
  }

  async regenerate(commandId: string, reviewId: string, repositoryPath: string): Promise<Review> {
    return this.capture(commandId, repositoryPath, reviewId);
  }

  private requireReview(reviewId: string): Review {
    const review = this.store.reviewById(reviewId);
    if (!review || review.id !== reviewId) throw new Error("Review not found");
    return review;
  }
}
