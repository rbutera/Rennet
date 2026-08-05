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

export interface Review {
  id: string;
  repositoryRoot: string;
  patchsets: Patchset[];
  activePatchsetId: string;
  pendingPatchsetId?: string;
  readPaths: string[];
  status: "current" | "invalid";
}

export interface CommandFailure {
  code: "INVALID_COMMAND" | "INVALID_INPUT" | "INTERNAL_ERROR";
  message: string;
  details?: unknown;
}

export type CommandResult<T> = { ok: true; value: T } | { ok: false; error: CommandFailure };
