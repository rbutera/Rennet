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

import { z } from "zod";

/**
 * The most rows one `worktrees.list` answer carries. A wire payload that interpolates a
 * collection declares a cap (CLAUDE.md, byte discipline), and this is the executable
 * ceiling: the schema REFUSES a longer list, so a host that forgot to truncate fails at
 * the boundary instead of shipping an unbounded payload. Past the cap the answer sets
 * `truncated`, which the surface says out loud rather than quietly showing a prefix.
 */
export const WORKTREE_ROWS_CAP = 200;

/** The longest git refusal a removal echoes back, in characters. */
export const WORKTREE_REFUSAL_CAP = 2000;

/**
 * What a workspace IS, which decides what the surface may offer for it:
 *   • `own-checkout` — a checkout the reviewer made; listed only while a session is bound
 *     to it, and never removable by Rennet.
 *   • `branch` — a Rennet-created worktree with the reviewed branch checked out.
 *   • `sibling` — a Rennet-created worktree on `rennet/<branch>` (workspace `own`).
 *   • `pull-request` — the detached snapshot at a reviewed pull request's head.
 */
export const worktreeKindSchema = z.enum(["own-checkout", "branch", "sibling", "pull-request"]);
export type WorktreeKind = z.infer<typeof worktreeKindSchema>;

/** One workspace Rennet knows for a repository (D6). */
export const worktreeRowSchema = z.object({
  /** The workspace directory, as git spells it. It also ADDRESSES the row for removal. */
  path: z.string().min(1),
  kind: worktreeKindSchema,
  /** The branch checked out here, or the detached head's OID for a snapshot. */
  ref: z.string().min(1).optional(),
  /** The LIVE sessions bound to this workspace. Empty ⇒ idle. */
  sessionIds: z.array(z.string().min(1)).max(WORKTREE_ROWS_CAP),
  /** When the workspace was made — its `.git` file's mtime, epoch ms. */
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
   * remote-tracking ref (D5): the sibling holds work the branch does not, so neither the
   * worktree nor the branch is collected and the row says why.
   */
  aheadOf: z.object({ branch: z.string().min(1), commits: z.number().int().positive() }).optional(),
  /**
   * Whether a removal can address this row at all: false for the reviewer's own checkout,
   * for a workspace a live session is bound to, and for a sibling holding unmerged work.
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
 */
export const worktreeRemoveOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("removed"),
    path: z.string().min(1),
    /** True when the sibling branch was deleted with its worktree (D5's rule held). */
    siblingBranchDeleted: z.boolean().optional(),
  }),
  z.object({
    status: z.literal("refused"),
    path: z.string().min(1),
    /** Git's refusal, verbatim up to {@link WORKTREE_REFUSAL_CAP}. */
    reason: z.string().max(WORKTREE_REFUSAL_CAP + 16),
  }),
  z.object({
    status: z.literal("not-removable"),
    path: z.string().min(1),
    reason: z.string().max(WORKTREE_REFUSAL_CAP + 16),
  }),
]);
export type WorktreeRemoveOutcome = z.infer<typeof worktreeRemoveOutcomeSchema>;
