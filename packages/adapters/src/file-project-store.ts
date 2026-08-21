import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  type DiscoveryResult,
  type Project,
  type ProjectSource,
  projectSchema,
} from "@rennet/protocol";
import { z } from "zod";

/**
 * The projects persistence (issue #29). A minimal JSON-file-backed store for the
 * front door's populated state, kept separate from the review event log because a
 * project list is not per-review event history.
 *
 * FAIL-SAFE READ (Rule 75, wrong-side): a missing file, an unreadable file, or a
 * malformed entry resolves to an EMPTY list, never a throw — a corrupt store must
 * degrade to "no projects yet", not crash the front door. Individual malformed
 * entries are dropped; well-formed siblings survive.
 */

/** The stored shape MAIN builds from a confirmed discovery (id + addedAt are stamped here). */
export interface ProjectDraft {
  name: string;
  path: string;
  kind: Project["kind"];
  repoCount: number;
  branchCount: number;
  primaryBranch: string;
  openPath: string;
  /** The working-tree paths of the included repos, so live detail honours the selection. */
  includedRepoPaths?: readonly string[];
  /** Which daemon this project lives on (issue: source-aware project selection). */
  source: ProjectSource;
}

const fileSchema = z.object({ projects: z.array(projectSchema) });

export interface FileProjectStoreDeps {
  /** The clock for `addedAt`. Defaults to the real ISO now. */
  now?: () => string;
  /** The id source. Defaults to `crypto.randomUUID()`. */
  id?: () => string;
}

export class FileProjectStore {
  private readonly now: () => string;
  private readonly id: () => string;

  constructor(
    private readonly path: string,
    deps: FileProjectStoreDeps = {},
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.now = deps.now ?? (() => new Date().toISOString());
    this.id = deps.id ?? (() => crypto.randomUUID());
  }

  /** The persisted projects, newest first. Empty on a missing or corrupt store. */
  list(): Project[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    // Drop malformed entries rather than throwing the whole list away.
    const container = (parsed as { projects?: unknown } | null)?.projects;
    if (!Array.isArray(container)) return [];
    const projects: Project[] = [];
    for (const entry of container) {
      const result = projectSchema.safeParse(entry);
      if (result.success) projects.push(result.data);
    }
    return [...projects].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }

  /** Persist a project from a confirmed draft; returns the stored record. */
  add(draft: ProjectDraft): Project {
    const project: Project = projectSchema.parse({
      id: this.id(),
      name: draft.name,
      path: draft.path,
      kind: draft.kind,
      repoCount: draft.repoCount,
      branchCount: draft.branchCount,
      primaryBranch: draft.primaryBranch,
      openPath: draft.openPath,
      ...(draft.includedRepoPaths ? { includedRepoPaths: [...draft.includedRepoPaths] } : {}),
      addedAt: this.now(),
      source: draft.source,
    });
    const existing = this.list();
    writeFileSync(
      this.path,
      `${JSON.stringify(fileSchema.parse({ projects: [...existing, project] }), null, 2)}\n`,
    );
    return project;
  }

  /**
   * Forget a project by id. Does NOT touch the repo on disk — only Rennet's record
   * of it is dropped, so re-adding the same path restores it. Returns whether one
   * was removed (false when the id was already absent).
   */
  remove(id: string): boolean {
    const existing = this.list();
    const kept = existing.filter((project) => project.id !== id);
    if (kept.length === existing.length) return false;
    writeFileSync(this.path, `${JSON.stringify(fileSchema.parse({ projects: kept }), null, 2)}\n`);
    return true;
  }
}

/**
 * Derive the stored project shape from a confirmed discovery and the user's toggle
 * choices. MAIN owns this so the renderer cannot desync the stored counts or the
 * open target from what was actually discovered. `openPath` is the repo itself for
 * a project repo, or the first included repo for a workspace — the reviewable path
 * a project row opens.
 */
export function deriveProjectDraft(
  discovery: DiscoveryResult,
  includedRepos: readonly string[],
  primaryBranch: string,
): ProjectDraft {
  const included = discovery.repos.filter((repo) => includedRepos.includes(repo.name));
  const branchCount = included.reduce((sum, repo) => sum + repo.branches, 0);
  const openPath =
    discovery.kind === "repo" ? discovery.path : (included[0]?.path ?? discovery.path);
  return {
    name: basename(discovery.path) || discovery.path,
    path: discovery.path,
    kind: discovery.kind,
    repoCount: included.length,
    branchCount,
    primaryBranch,
    openPath,
    includedRepoPaths: included.map((repo) => repo.path),
    source: discovery.source,
  };
}
