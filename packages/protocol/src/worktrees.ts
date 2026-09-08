// The workspace inventory contract (workspace-settings D6) — the shapes
// `worktrees.list` and `worktrees.remove` carry.
//
// A workspace is one directory Rennet knows for ONE repository: the reviewer's own
// checkout while a session is bound to it, a Rennet-created branch worktree, a sibling
// worktree on `rennet/<branch>`, or a pull-request snapshot. The inventory is read from
// git, the pull-request index and the session store on request; nothing here is persisted.
//
// Every call names a REPOSITORY PATH, never a project id: a workspace project maps many
// repositories onto one identity and that mapping is not invertible, so a project id
// cannot answer "which repository's worktrees" (CLAUDE.md, the 2026-08-28 rule).
//
// A row is ADDRESSED BY `id`, never by its path. The path on a row is display copy: a
// projected client receives it as a repo reference and a scrubbed tail, so the bytes it
// could echo back are not the bytes the host would have to match. The id is an opaque
// server-side digest of the workspace's resolved path, identical in the list that showed
// the row and in the fresh list the removal addresses, and it survives projection intact.

import { z } from "zod";

/**
 * The most rows one `worktrees.list` answer carries. A wire payload that interpolates a
 * collection declares a cap (CLAUDE.md, byte discipline), and this is the executable
 * ceiling: the schema REFUSES a longer list, so a host that forgot to truncate fails at
 * the boundary instead of shipping an unbounded payload. Past the cap the answer sets
 * `truncated`, which the surface says out loud rather than quietly showing a prefix.
 */
export const WORKTREE_ROWS_CAP = 200;

/**
 * The most session ids ONE row carries — its own cap, not the row cap borrowed.
 *
 * A row's session list is a second collection nested inside the capped one, so it needs
 * its own bound or 200 rows x 200 ids is the real payload. Twenty is the same order as
 * every other per-result sample cap in the codebase (`heldIds()` at 20), and a row past
 * it sets `sessionsTruncated` rather than showing a silent prefix.
 */
export const WORKTREE_SESSION_IDS_CAP = 20;

/** The longest git refusal a removal echoes back, in characters. */
export const WORKTREE_REFUSAL_CAP = 2000;

/**
 * The longest per-row marker sentence, in characters — a branch name is unbounded, and a
 * row's marker is one short sentence, not a refusal transcript.
 */
export const WORKTREE_ROW_MARKER_CAP = 200;

/**
 * What a workspace IS, which decides what the surface may offer for it:
 *   • `own-checkout` — THE REPOSITORY ROOT THE LIST WAS ASKED FOR: the reviewer's own
 *     checkout, by definition, since that is the directory the card is about. Listed only
 *     while a session is bound to it, and never removable by Rennet.
 *   • `branch` — a worktree with a branch checked out.
 *   • `sibling` — a worktree on `rennet/<branch>` (workspace `own`).
 *   • `pull-request` — the detached snapshot at a reviewed pull request's head.
 *
 * Decided POSITIVELY, from the queried repository root and the row's own ref/index facts —
 * never "everything left over is the reviewer's checkout". A worktree that is not the
 * queried root is named for what it is even when it sits outside the currently resolved
 * root, which is exactly what a root the reviewer has since changed produces.
 *
 * NOT git's first (main) worktree record. A project rooted at a LINKED worktree — which
 * `worktree.location` makes ordinary — would otherwise produce TWO rows both labelled
 * "your own checkout": git's main one and the one the reviewer actually has open. Git's
 * main worktree, when it is not the queried root, is a `branch` row like any other, and it
 * is listed at all only when a live session is bound to it.
 */
export const worktreeKindSchema = z.enum(["own-checkout", "branch", "sibling", "pull-request"]);
export type WorktreeKind = z.infer<typeof worktreeKindSchema>;

/** One workspace Rennet knows for a repository (D6). */
export const worktreeRowSchema = z.object({
  /**
   * The row's address, opaque and stable: a digest of the workspace's resolved path,
   * computed on the host. `worktrees.remove` names THIS, never a path — a projected
   * client never holds the host spelling it would otherwise have to echo back.
   */
  id: z.string().min(1),
  /** The workspace directory, as the daemon spells it. DISPLAY ONLY — see `id`. */
  path: z.string().min(1),
  kind: worktreeKindSchema,
  /** The branch checked out here, or the detached head's OID for a snapshot. */
  ref: z.string().min(1).optional(),
  /** The LIVE sessions bound to this workspace. Empty ⇒ idle. */
  sessionIds: z.array(z.string().min(1)).max(WORKTREE_SESSION_IDS_CAP),
  /** True when more sessions are bound here than {@link WORKTREE_SESSION_IDS_CAP} carries. */
  sessionsTruncated: z.boolean().optional(),
  /**
   * When the workspace was made, epoch ms — a linked worktree's `.git` FILE mtime (written
   * once, when git made it), or the main checkout's `.git` birth time. Absent when neither
   * is knowable, and the cell reads "—": a directory mtime advances on every commit, so
   * reporting one here would be a creation date that is not one.
   */
  createdAt: z.number().optional(),
  /** The latest bound session's activity, epoch ms. Absent ⇒ no session is bound. */
  lastUsedAt: z.number().optional(),
  /**
   * The measured size in bytes, absent when the measurement did not finish inside its
   * time bound. Absent is UNKNOWN, never zero — the surface reads it as "—".
   */
  sizeBytes: z.number().nonnegative().optional(),
  /**
   * Present on a sibling whose tip is reachable from NEITHER its branch nor that branch's
   * remote-tracking ref (D5): the sibling holds work the branch does not, so removing this
   * row takes the worktree and KEEPS the branch, and the row says how far ahead it is.
   */
  aheadOf: z.object({ branch: z.string().min(1), commits: z.number().int().positive() }).optional(),
  /**
   * Present on a sibling whose branch will OUTLIVE its worktree if this row is removed
   * (D5), saying why in one sentence: "ahead of `feat/x` by 2 commits", or "`feat/x` no
   * longer exists". `aheadOf` carries the count only when there is one to carry — a sibling
   * whose reviewed branch has been DELETED has no count, and without this marker that row
   * read exactly like a collectable one while the removal quietly kept its branch.
   *
   * Absent ⇒ removing this row takes the sibling branch with it, or the row is not a
   * sibling at all.
   */
  keepsBranch: z
    .string()
    .min(1)
    .max(WORKTREE_ROW_MARKER_CAP + 16)
    .optional(),
  /**
   * Whether a removal can address this row at all: false for the repository's main
   * checkout and for a workspace a live session is bound to. An ahead sibling IS
   * removable — its worktree goes and its branch stays, which loses nothing.
   * A fact about the row, not a permission prompt — the removal itself asks nothing.
   */
  removable: z.boolean(),
});
export type WorktreeRow = z.infer<typeof worktreeRowSchema>;

/** The `worktrees.list` answer: the rows, and whether the cap dropped any. */
export const worktreeInventorySchema = z.object({
  rows: z.array(worktreeRowSchema).max(WORKTREE_ROWS_CAP),
  /** True when this repository has more workspaces than the cap carries. */
  truncated: z.boolean(),
});
export type WorktreeInventory = z.infer<typeof worktreeInventorySchema>;

/**
 * What a removal did. `refused` carries GIT'S OWN TEXT (capped, with an honest marker) —
 * a dirty worktree, a locked one, a path git does not own. `not-removable` is Rennet's
 * own answer for a row a removal cannot address, and its reason names the fact.
 *
 * Every arm echoes the `id` that was addressed. `path` rides along for display and is
 * absent on the one outcome that has no row to name.
 */
export const worktreeRemoveOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("removed"),
    id: z.string().min(1),
    path: z.string().min(1),
    /** True when the sibling branch was deleted with its worktree (D5's rule held). */
    siblingBranchDeleted: z.boolean().optional(),
    /**
     * What was deliberately KEPT, when anything was: the sibling branch and why it
     * outlived its worktree. Absent when the removal took everything it named.
     */
    note: z
      .string()
      .max(WORKTREE_REFUSAL_CAP + 16)
      .optional(),
  }),
  z.object({
    status: z.literal("refused"),
    id: z.string().min(1),
    path: z.string().min(1),
    /** Git's refusal, verbatim up to {@link WORKTREE_REFUSAL_CAP}. */
    reason: z.string().max(WORKTREE_REFUSAL_CAP + 16),
  }),
  z.object({
    status: z.literal("not-removable"),
    id: z.string().min(1),
    /** Absent when the id addressed no row of this repository — there is no path to name. */
    path: z.string().min(1).optional(),
    reason: z.string().max(WORKTREE_REFUSAL_CAP + 16),
  }),
]);
export type WorktreeRemoveOutcome = z.infer<typeof worktreeRemoveOutcomeSchema>;
