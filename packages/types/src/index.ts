export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface RepositoryProvenance {
  id: string;
  root: string;
  commonDir: string;
  baseRef: string;
  baseOid: string;
  headOid: string;
}

export interface PatchFile {
  path: string;
  previousPath?: string;
  status: FileChangeStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  patch: string;
}

export interface Patchset {
  id: string;
  createdAt: string;
  repository: RepositoryProvenance;
  files: PatchFile[];
  rawDiff: string;
  byteLength: number;
  truncated: boolean;
}

/**
 * The unit a disposition is attached to.
 *
 * Slice 1 anchors at FILE granularity, reusing the MVP's file-level read
 * identity: `path` names the changed file and `contentDigest` is a hash of that
 * file's patch text at authoring time. The digest is the exact-match key that
 * lets a disposition survive a re-capture only when the file is byte-identical.
 * Hunk / line / symbol anchoring and fuzzy lineage matching are a later slice
 * (Spike 1); this shape is deliberately the minimal reuse of what exists.
 */
export interface DispositionAnchor {
  path: string;
  contentDigest: string;
}

export type DispositionType = "approve" | "request-change" | "comment" | "question";

/**
 * A reviewer action taken against an anchor. In this model a file/chunk is
 * "read" iff it carries a disposition: reading is an action, never scroll/dwell.
 */
export interface Disposition {
  anchor: DispositionAnchor;
  type: DispositionType;
  body: string;
}

export interface Review {
  id: string;
  repositoryRoot: string;
  patchsets: Patchset[];
  activePatchsetId: string;
  pendingPatchsetId?: string;
  /**
   * The reviewer's dispositions against the active patchset. This is the
   * canonical read-state: the derived read-set is the distinct anchor paths.
   */
  dispositions: Disposition[];
  status: "current" | "invalid";
}

export interface CommandFailure {
  code: "INVALID_COMMAND" | "INVALID_INPUT" | "INTERNAL_ERROR";
  message: string;
  details?: unknown;
}

export type CommandResult<T> = { ok: true; value: T } | { ok: false; error: CommandFailure };
