import type { ProjectFileResult, ProjectMapResult, ProjectMapScope } from "@rennet/core";
import type { ProjectContextReader } from "./project-context-reader";

// ─────────────────────────────────────────────────────────────────────────────
// The `context.map` / `context.file` slice of a `CanvasOpsBackend` (issue #14).
//
// The pure canvasOps@2 tools call `backend.projectMap()` / `backend.fileContext()`
// (issue #12's port pattern: capabilities are METHODS on the injected backend, so
// a new capability is one accessor the surface reaches uniformly — no
// `if (harness === X)`, no descriptor knowing about a reader). This adapter is the
// real implementation of those two accessors: it binds the fail-closed
// `ProjectContextReader` gate to a per-review RESOLVED base context, so every call
// passes through the freshness + integrity gate rather than the raw store.
//
// Decision #3 — per-request base-OID resolution — lives here, and deliberately as
// an INJECTED resolver. A review is against ONE base, so `ReviewIdentity.repo →
// repoKey → resolved base OID` (forge metadata → symbolic HEAD → configured
// upstream → explicit setting, per #14) is resolved once by the RepoRecord /
// base-ref layer that owns that I/O, and handed here as `resolve()`. The resolver
// is a function (not a frozen value) so a backend MAY re-resolve per call if the
// review's base is re-pinned mid-session; the reader then refuses anything not
// fresh at whatever OID it returns. Keeping the resolution behind a function is
// what lets this stay node-free and lets a test drive absent/stale/corrupt
// deterministically.
// ─────────────────────────────────────────────────────────────────────────────

/** The resolved per-review repo context a context read is pinned to. */
export interface ResolvedRepoContext {
  /** The RepoRecord `repoKey` = `realpath(git-common-dir)` (R19) — the store key. */
  readonly repoKey: string;
  /** The resolved default-branch base OID the snapshot must match (R30 freshness). */
  readonly baseOid: string;
}

/** The two `CanvasOpsBackend` accessors this adapter supplies. */
export interface ProjectContextBackendPart {
  projectMap(scope?: ProjectMapScope): ProjectMapResult;
  fileContext(path: string): ProjectFileResult;
}

/**
 * Build the `context.map` / `context.file` backend accessors from a
 * {@link ProjectContextReader} and a per-review base-context resolver. Spread the
 * result into a full `CanvasOpsBackend` (with the canvas/diff/run accessors) so
 * the whole canvasOps@2 surface reads through one injected backend.
 *
 * Every call re-invokes `resolve()` and passes its `{repoKey, baseOid}` straight
 * into the reader gate, so freshness is always judged against the CURRENT resolved
 * base OID — a snapshot built at any other OID is refused as stale, never served.
 */
export function projectContextBackend(
  reader: ProjectContextReader,
  resolve: () => ResolvedRepoContext,
): ProjectContextBackendPart {
  return {
    projectMap(scope?: ProjectMapScope): ProjectMapResult {
      const { repoKey, baseOid } = resolve();
      return reader.readProjectMap(repoKey, baseOid, scope);
    },
    fileContext(path: string): ProjectFileResult {
      const { repoKey, baseOid } = resolve();
      return reader.readFileContext(repoKey, baseOid, path);
    },
  };
}
