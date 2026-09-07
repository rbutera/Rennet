/**
 * The project mark's host side (#900, ADR 0004): the three `project.*Logo` verbs over the
 * logo store, composed off Electron so their resolution rules are unit-testable.
 *
 * Every one of them has to answer the same question first — WHICH repository? A project is a
 * workspace or a single repo, and a workspace maps many repos to one identity, so a project
 * id alone cannot name a checkout. Each verb therefore resolves the project's included repos
 * in order and states, per operation, which of them it means:
 *
 * - `logos` reads across ALL of them, first hit per kind, because the scout runs per repo and
 *   a workspace's logo may have been found in its second repo while the client reads the
 *   first row's prefs.
 * - `upload` writes to the FIRST included repo, the same rung the `mark` pref lands on.
 * - `detect` re-runs detection over every included repo and copies into the repo the pick
 *   came from, so the copy source and its recorded root always agree.
 */

import type { ProjectSnapshotStore } from "@rennet/adapters";
import { readLogo, writeUploadLogo } from "@rennet/adapters";
import { escapePath } from "@rennet/core";
import type {
  Project,
  ProjectLogo,
  ProjectLogoKind,
  ProjectLogoMime,
  SettingsProjectWriteOutcome,
} from "@rennet/protocol";

/** The two kinds, in the order `project.logos` emits them. */
const LOGO_KINDS: readonly ProjectLogoKind[] = ["detected", "upload"];

/** One resolved repository of a project: where it is, and the store key it is filed under. */
export interface MarkRepoTarget {
  readonly repoPath: string;
  readonly repoKey: string;
}

export interface ProjectMarkDeps {
  readonly store: ProjectSnapshotStore;
  readonly listProjects: () => Project[];
  /** A working path → its realpath-canonical git top level, or null when it is gone. The
   *  SAME identity the snapshot generator keys on, so a mark lands where the config does. */
  readonly gitTopLevel: (workingPath: string) => Promise<string | null>;
  /** Rediscover every repo path under a legacy workspace (no persisted inclusion set). */
  readonly discoverWorkspaceRepos: (project: Project) => Promise<string[]>;
  /** Re-detect ONE repo's logo and copy the pick in — the scout runtime's own method, so
   *  every harness call still goes through the council seat. */
  readonly detectLogoForRepo: (input: {
    repoKey: string;
    repoRoot: string;
  }) => Promise<{ value: string } | null>;
  /** The ordinary per-project settings write — the same one the Identity control calls, so
   *  an upload's pref change is indistinguishable from a user picking "upload" by hand. */
  readonly setProjectValue: (input: {
    projectId: string;
    repoPath: string;
    key: "mark";
    value: string | null;
  }) => Promise<SettingsProjectWriteOutcome>;
}

export interface ProjectMarkComposition {
  logos(input: { projectId?: string }): Promise<{ logos: ProjectLogo[] }>;
  upload(input: {
    projectId: string;
    mimeType: ProjectLogoMime;
    bytesBase64: string;
    fileName: string;
  }): Promise<SettingsProjectWriteOutcome>;
  detect(input: { projectId: string }): Promise<{ found: boolean; source: string | null }>;
}

export function createProjectMarks(deps: ProjectMarkDeps): ProjectMarkComposition {
  // A project's included repo working paths, mirroring `resolveRepoRoots` and the settings
  // composition: a repo project is its own open path; a workspace honours the persisted
  // inclusion set; a LEGACY workspace rediscovers rather than collapsing to the first repo.
  const includedWorkingPaths = async (project: Project): Promise<string[]> => {
    if (project.kind === "repo") return [project.openPath || project.path];
    if (project.includedRepoPaths && project.includedRepoPaths.length > 0) {
      return [...project.includedRepoPaths];
    }
    try {
      return await deps.discoverWorkspaceRepos(project);
    } catch {
      return [project.openPath];
    }
  };

  const targetsFor = async (project: Project): Promise<MarkRepoTarget[]> => {
    const seen = new Set<string>();
    const targets: MarkRepoTarget[] = [];
    for (const workingPath of await includedWorkingPaths(project)) {
      const topLevel = await deps.gitTopLevel(workingPath).catch(() => null);
      if (!topLevel || seen.has(topLevel)) continue;
      seen.add(topLevel);
      targets.push({ repoPath: topLevel, repoKey: escapePath(topLevel) });
    }
    return targets;
  };

  const projectById = (projectId: string): Project | undefined =>
    deps.listProjects().find((entry) => entry.id === projectId);

  return {
    logos: async ({ projectId }) => {
      const projects = deps
        .listProjects()
        .filter((project) => projectId === undefined || project.id === projectId);
      const logos: ProjectLogo[] = [];
      for (const project of projects) {
        const targets = await targetsFor(project);
        for (const kind of LOGO_KINDS) {
          // First hit wins per kind: the scout files a copy under the repo it scouted, so a
          // workspace's mark can sit under any of its repos. A project with no file for a
          // kind contributes no row — absence, not an empty one.
          for (const target of targets) {
            const stored = readLogo(deps.store, target.repoKey, kind);
            if (!stored) continue;
            logos.push({ projectId: project.id, logo: kind, ...stored });
            break;
          }
        }
      }
      return { logos };
    },

    upload: async (input) => {
      const project = projectById(input.projectId);
      if (!project) return { status: "unresolved", key: "mark", project: null };
      const first = (await targetsFor(project))[0];
      if (!first) return { status: "unresolved", key: "mark", project: null };
      // Bytes first, then the pref. The other order would point the ladder at `upload`
      // before the file exists; this one, if the pref write is refused, leaves a file
      // nothing references — inert, and overwritten by the next upload.
      writeUploadLogo(
        deps.store,
        first.repoKey,
        input.mimeType,
        Buffer.from(input.bytesBase64, "base64"),
        input.fileName,
      );
      return deps.setProjectValue({
        projectId: project.id,
        repoPath: first.repoPath,
        key: "mark",
        value: "upload",
      });
    },

    detect: async ({ projectId }) => {
      const project = projectById(projectId);
      if (!project) return { found: false, source: null };
      for (const target of await targetsFor(project)) {
        const fact = await deps.detectLogoForRepo({
          repoKey: target.repoKey,
          repoRoot: target.repoPath,
        });
        // The first repo that yields a mark decides it. A later repo's candidate does not
        // overwrite an earlier repo's pick, so a re-detect is stable across runs.
        if (fact && fact.value !== "") return { found: true, source: fact.value };
      }
      return { found: false, source: null };
    },
  };
}
