/**
 * Patchset citations — the delta/ contract's core vocabulary (B3, #489).
 *
 * The patchset/capture, anchor, and knowledge families, moved verbatim from
 * `domain.ts` and the wire layer (B3 task 6.1). One home for the shapes a
 * citation stands on: what a patchset is made of, how an anchor addresses it,
 * and the knowledge statements whose evidence anchors resolve against it.
 */
import { z } from "zod";

/** A stable decomposition hunk id — an INTERNAL delta-packet key for the diff renderer. A
 *  board citation never names one: it is a path plus a line range (`codeRefSchema`). */
export const hunkIdSchema = z.string().min(1);
export type HunkId = z.infer<typeof hunkIdSchema>;

/**
 * The canonical patchset citation (B3 task 6.2, #489) — the ONE definition
 * `board/`'s `code_ref` kind (snake_case wire casing, field-for-field) and
 * `session/`'s thread anchors reuse. `side` selects the image the span reads:
 * `base` (pre-image) or `head` (post-image). A citation hydrates from the
 * captured patchset, never a working tree.
 */
export const codeRefSchema = z
  .object({
    patchsetId: z.string().min(1),
    path: z.string().min(1),
    side: z.enum(["base", "head"]),
    // 1-based file lines, same contract as `anchorSpanSchema`; an inverted span
    // is unreadable and rejected here rather than at hydration time.
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    symbol: z.string().optional(),
  })
  .refine((ref) => ref.endLine >= ref.startLine, {
    message: "endLine must be >= startLine",
    path: ["endLine"],
  });
export type CodeRef = z.infer<typeof codeRefSchema>;

/** A 1-based file-line span (issue #78). Shared by the disposition anchor + command inputs. */
export const anchorSpanSchema = z.object({
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1).optional(),
});
export const anchorSideSchema = z.enum(["additions", "deletions", "context"]);

/** A 1-based line span WITHIN the anchored unit (never absolute file lines). */
export type AnchorSpan = z.infer<typeof anchorSpanSchema>;

/**
 * One occurrence (decomposition hunk) mapped onto a rendered `@@` hunk. `id` is the
 * hunk id an anchor references; the line range is the occurrence's own span, so a
 * mark anchored to an oversize-split (R18) FRAGMENT resolves within its slice of the
 * shared raw hunk, never the whole hunk. `oldStart`/`newStart` are 1-based file
 * lines; `oldLines`/`newLines` the side counts — the same shape as `Hunk`.
 */
export type RenderedHunkOccurrence = {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
};

/** The anchor kinds. `spec`/`requirement` let a document exist with no code. */
export type AnchorKind =
  | "hunk"
  | "file"
  | "symbol"
  | "chunk"
  | "patchset"
  | "reach"
  | "doc"
  | "noisegroup"
  | "spec"
  | "requirement";

/** The side of a diff a span addresses; spans are always side-qualified. */
export type AnchorSide = "additions" | "deletions" | "context";

/** A parsed `rennet:` anchor. `span` and `pointer` are mutually exclusive. */
export interface ParsedAnchor {
  raw: string;
  kind: AnchorKind;
  id: string;
  span?: AnchorSpan;
  pointer?: string;
  side?: AnchorSide;
  proposal?: string;
}

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface PatchFile {
  path: string;
  previousPath?: string;
  status: FileChangeStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  patch: string;
}

export const fileChangeStatusSchema = z.enum(["added", "modified", "deleted", "renamed"]);

/**
 * The wire shape of {@link PatchFile} — declared HERE, beside the interface, because two
 * unrelated contracts carry it: a `Patchset`'s `files` (`wire.ts`) and a `RoundRecord`'s
 * `diffFiles` (`session/model.ts`, the round diff). One schema, so the two cannot drift.
 */
export const patchFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  status: fileChangeStatusSchema,
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
  patch: z.string(),
});

/**
 * The sentinel `visible()` (`@rennet/adapters`) appends when it truncates a diff
 * past its byte cap. A `PatchFile.patch` containing this marker is content-lossy:
 * hashing it yields an identity for only the first N bytes, so two files that
 * differ only BEYOND the cap share a `fileContentDigest`. The path-grained
 * disposition carry in `@rennet/core` must therefore refuse to carry over a
 * patch that carries this marker (fail closed). Declared here — the one module
 * both the producer (`visible`) and the consumer (`fileContentDigest`'s carry
 * check) depend on — so the two cannot drift apart and silently reopen the hole.
 */
export const DIFF_TRUNCATION_MARKER = "[diff truncated by Rennet]";

/**
 * Where a patchset's content came from. `local` is the working-tree capture
 * (`GitCaptureAdapter`); `local-branch` is a LOCAL BRANCH diffed as a pinned
 * `merge-base...head` range (#587's New Chat row click) — it is a SNAPSHOT, so it
 * shares nothing with the working tree and must stay off the freshness watcher, the
 * same as a PR; `github-local`/`github-rest` are the persisted GitHub spellings;
 * `forge-local`/`forge-rest` are the provider-neutral equivalents for newer adapters.
 * Absent means `local` (additive: the existing local-capture identity is unchanged).
 */
export type PatchsetSource =
  | "local"
  | "local-branch"
  | "github-local"
  | "github-rest"
  | "forge-local"
  | "forge-rest";

/**
 * The freshness predicates, declared HERE beside `PatchsetSource` because two clients ask
 * them and both used to answer separately.
 *
 * `isWorkingTreeReview` is the one question that decides whether a review's content can change
 * under the reviewer: only a `local` capture reads the working tree. Every other source is a
 * snapshot pinned to commits — a PR's OIDs, or a `merge-base...head` range — so it must stay off
 * the freshness watcher and, if it somehow carries `invalid`, must never be narrated as "the
 * repository changed". An absent source is `local`, the default `wire.ts` declares.
 *
 * `isReviewStale` is that gate ANDed with the invalidated status: the whole staleness rule, in
 * one place. Desktop derived it correctly and said so in a comment; mobile's copy
 * (`apps/mobile/src/lib/projection.ts`) dropped the provenance half and told the reviewer a
 * pinned PR snapshot had gone stale (#600). The rule crossing to a second client by hand is
 * exactly how they drifted, and a fifth `PatchsetSource` would have drifted them again.
 *
 * Structurally typed on purpose: the argument is satisfied by a private `Review` (desktop) and
 * by the mobile app's projected view of one, which carry the same two fields under R19.
 *
 * `patchsets` is OPTIONAL here even though `reviewSchema` requires it, because the desktop test
 * fixtures build partial reviews with the field simply absent — the `?.` in the expression this
 * replaced was load-bearing, and dropping it crashed 24 app-ui DOM tests on the render path. An
 * absent list resolves the same way an absent `source` does: `local`, the documented default.
 */
export function isWorkingTreeReview(review: {
  readonly activePatchsetId: string;
  readonly patchsets?: readonly {
    readonly id: string;
    readonly source?: PatchsetSource | undefined;
  }[];
}): boolean {
  const active = review.patchsets?.find((patchset) => patchset.id === review.activePatchsetId);
  return (active?.source ?? "local") === "local";
}

/** Did the repository actually change under this review? Working-tree provenance AND invalidated. */
export function isReviewStale(
  review: Parameters<typeof isWorkingTreeReview>[0] & {
    /** The review's own two states, not `string`: a mistyped literal is a compile error, not a silent `false`. */
    readonly status: "current" | "invalid";
  },
): boolean {
  return isWorkingTreeReview(review) && review.status === "invalid";
}

/** Which surface a patchset's captured intent came from. */
export type PatchsetIntentSurface =
  | "github-pr"
  | "github-rest"
  | "forge-pr"
  | "forge-rest"
  | "working-tree";

/** A minimal reference to the immutable patchset a document binds to. */
export interface PatchsetRef {
  id: string;
}

// ── LLM knowledge layer (layer c, #14 knowledge half — design §6) ─────────────
//
// The ONLY Repo Map layer a model writes; it never enters the structural map (a)
// or the symbolic surface (b). Each learned statement about what a module does,
// the conventions it embodies, and the reconstructed WHY carries EVIDENCE ANCHORS
// that resolve against a snapshot, PROVENANCE, a CONFIDENCE, and the snapshot it
// was learned against. A model-derived statement is a LABELLED HYPOTHESIS until
// confirmed; a statement whose anchors do not resolve is INVALID and is never
// served. It is invalidated with its snapshot inputs, and disclosed as
// invalidated-pending (never silently dropped) when a delta pass invalidated it.
