/**
 * Patchset citations — the delta/ contract's core vocabulary (B3, #489).
 *
 * The patchset/capture, anchor, and knowledge families, moved verbatim from
 * `domain.ts` and the wire layer (B3 task 6.1). One home for the shapes a
 * citation stands on: what a patchset is made of, how an anchor addresses it,
 * and the knowledge statements whose evidence anchors resolve against it.
 */
import { z } from "zod";

/** A stable decomposition hunk id — the unit anchors and citations reference. */
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
 * (`GitCaptureAdapter`); `github-local` is a GitHub PR diffed from the on-disk
 * clone (full context, the angles can run); `github-rest` is the degraded REST
 * diff fallback used when the clone is not on disk or its SHAs are unfetchable.
 * Absent means `local` (additive: the existing local-capture identity is unchanged).
 */
export type PatchsetSource = "local" | "github-local" | "github-rest";

/** Which surface a patchset's captured intent came from. */
export type PatchsetIntentSurface = "github-pr" | "github-rest" | "working-tree";

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

/** How sure the generator is of a knowledge statement. */
export type KnowledgeConfidence = "high" | "medium" | "low";

/**
 * Whether a statement is a model-derived HYPOTHESIS, a CONFIRMED fact, or a
 * human-REJECTED claim. A model-derived statement is a hypothesis until a human
 * (or evidence) confirms it — the same honesty contract as the symbolic
 * surface's `exact`/`guess` tier label (a `guess` is never rendered as exact; a
 * hypothesis is never rendered as an asserted fact). A rejection is a RECORDED
 * state, not a deletion: it survives delta passes so re-enrichment cannot
 * resurrect the same claim as a fresh hypothesis (add-context-map-view).
 */
export type KnowledgeStatus = "hypothesis" | "confirmed" | "rejected";

/** Which aspect of understanding a statement reconstructs. */
export type KnowledgeAspect = "purpose" | "convention" | "why";

/**
 * An evidence anchor: the concrete code a knowledge statement is DRAWN FROM. It
 * RESOLVES against a snapshot iff the file at `path` still carries `blobOid` in
 * that snapshot's file inventory — so a statement is invalidated exactly when the
 * bytes it cited change. `symbol`/`lines` narrow WHICH part of the file the claim
 * is drawn from, but the `(path, blobOid)` pair is the resolution key (content
 * identity, the same join the symbol shards use).
 */
export interface KnowledgeAnchor {
  /** Repo-relative POSIX path of the cited file. */
  readonly path: string;
  /** The git blob OID of that file at the snapshot the statement was learned against. */
  readonly blobOid: string;
  /** The cited exported symbol name, when the claim is about one symbol. */
  readonly symbol?: string;
  /** A 1-based line span within the file the claim is drawn from. */
  readonly lines?: AnchorSpan;
}

/** Who/what produced a knowledge statement (the generator + credential facts). */
export interface KnowledgeProvenance {
  /** The generator identity (prompt+schema version); a generator change invalidates old statements honestly. */
  readonly generator: string;
  /** The model the harness reported, or null when unseen / deterministic. */
  readonly model: string | null;
  /** The credential source; `oauth`/`none` are the unmetered subscription path, a metered source is money. */
  readonly apiKeySource: string | null;
}

/**
 * One learned statement. `learnedAgainst` pins the snapshot it was reconstructed
 * from (baseOid + fingerprint) so it is invalidated with its inputs. `evidence`
 * is non-empty by contract — an unanchored statement is INVALID and never served.
 */
export interface KnowledgeStatement {
  /** Stable id: a content hash over {subject, aspect, claim, sorted anchors}. */
  readonly id: string;
  /** What the statement is about — a workspace scope name or a repo-relative path/subtree. */
  readonly subject: string;
  /** Which aspect of understanding this reconstructs. */
  readonly aspect: KnowledgeAspect;
  /** The reconstructed statement, served verbatim. */
  readonly claim: string;
  /** The code this claim is drawn from — at least one anchor, each resolvable against the snapshot. */
  readonly evidence: readonly KnowledgeAnchor[];
  readonly confidence: KnowledgeConfidence;
  /** `hypothesis` until confirmed — a model-derived statement is never served as an asserted fact. */
  readonly status: KnowledgeStatus;
  readonly provenance: KnowledgeProvenance;
  /** The snapshot this statement was learned against (freshness/content pin). */
  readonly learnedAgainst: {
    readonly baseOid: string;
    readonly snapshotFingerprint: string;
  };
}

/** The current knowledge-set schema version. Bumped on a breaking statement-shape change. */
export const KNOWLEDGE_SCHEMA_VERSION = 1;

/**
 * The stored knowledge set for one repo, pinned to the snapshot it was generated
 * against. This is the on-disk shape under `knowledge/knowledge.json` locally and
 * the promoted `<repo>/.rennet/knowledge/knowledge.json`. Statements are in a
 * deterministic total order (by id), so the file is byte-reproducible.
 */
export interface KnowledgeSet {
  readonly schemaVersion: number;
  /** The store key the set belongs to. */
  readonly repoKey: string;
  /** The base OID the set was generated against. */
  readonly baseOid: string;
  /** The snapshot fingerprint the set was generated against. */
  readonly snapshotFingerprint: string;
  /** The generator identity that produced the set. */
  readonly generator: string;
  readonly statements: readonly KnowledgeStatement[];
}
