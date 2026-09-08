import type {
  BenchmarkRun,
  ProjectLogo,
  SettingsGuidance,
  SettingsView,
  WorktreeInventory,
} from "@rennet/protocol";
import { type CommandResult, type MutationResult, useCommand, useMutation } from "../../data";

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE settings commands (C10 §2.1). The eight `settings.*` commands that
// exist on `main` today, bound through the data seam (`useCommand`/`useMutation`
// over the bridge — never `bridge.invoke` in a page). This file is the one place
// the settings surface names those commands and the reads each write stales, so a
// page calls an intention-named hook and the invalidation is uniform.
//
// Every write invalidates `settings.get` — the single read that carries the
// resolved appearance, keybindings, and per-repo rows, so one refetch re-renders
// the resolver's own answer after any edit. `guidance` reads per-repo and is not
// staled by these (it has its own write path in a later cluster).
// ─────────────────────────────────────────────────────────────────────────────

/** The whole settings view: resolved scheme + provenance, keybindings, per-repo rows. */
export function useSettingsView(): CommandResult<SettingsView> {
  return useCommand("settings.get", {});
}

/** The per-repo guidance catalogue (`.rennet/conventions.json`) for one repo. */
export function useGuidance(
  projectId: string,
  repoPath: string,
  options?: { readonly enabled?: boolean },
): CommandResult<SettingsGuidance> {
  return useCommand("settings.guidance", { projectId, repoPath }, options);
}

/** The recorded benchmark runs, newest first (#731). Capped at the wire: the panel's
 *  responsiveness on a long history is decided by how much it is handed as much as by how
 *  it renders, so the limit lives on the read rather than in a client-side slice. */
export function useBenchmarks(
  limit = 200,
): CommandResult<{ runs: BenchmarkRun[]; total: number; skipped: string[] }> {
  return useCommand("benchmarks.list", { limit });
}

/** Turn benchmark recording on or off. Stales `settings.get`, which carries the resolved
 *  state the toggle renders. */
export function useSetBenchmarkRecording(): MutationResult<"settings.setBenchmarkRecording"> {
  return useMutation("settings.setBenchmarkRecording", { invalidates: ["settings.get"] });
}

/** Set (or reset with `scheme: null`) the global appearance scheme. */
export function useSetAppearance(): MutationResult<"settings.setAppearance"> {
  return useMutation("settings.setAppearance", { invalidates: ["settings.get"] });
}

/** Replay the first-run welcome. Stales `settings.get`, which is what the startup gate
 *  reads — so the refetch is what actually reopens the wizard, with no reload. */
export function useResetWelcome(): MutationResult<"settings.resetWelcome"> {
  return useMutation("settings.resetWelcome", { invalidates: ["settings.get"] });
}

/** Set / unbind (`null`) / reset (omit) a command's keybinding override (#44). */
export function useSetKeybinding(): MutationResult<"settings.setKeybinding"> {
  return useMutation("settings.setKeybinding", { invalidates: ["settings.get"] });
}

/** Set a repo's map visibility (runs the real gitignore switch). */
export function useSetRepoVisibility(): MutationResult<"settings.setRepoVisibility"> {
  return useMutation("settings.setRepoVisibility", { invalidates: ["settings.get"] });
}

/** Reset a repo-scoped value to inheritance (fall back down the ladder). */
export function useResetRepoValue(): MutationResult<"settings.resetRepoValue"> {
  return useMutation("settings.resetRepoValue", { invalidates: ["settings.get"] });
}

/** Pin a repo-scoped value at the repo layer (freeze the current effective value). */
export function usePinRepoValue(): MutationResult<"settings.pinRepoValue"> {
  return useMutation("settings.pinRepoValue", { invalidates: ["settings.get"] });
}

/** Write one per-project preference on the repo rung — glyph, the worktree four, tracker
 *  (C18 group A). Stales `settings.get`, which carries the resolved prefs it changed, AND
 *  `worktrees.list`: the root and the two patterns decide where the NEXT workspace is
 *  placed, so the inventory's rows-under-the-root membership is a function of them
 *  (workspace-settings D6). A key that is not a worktree key stales a read that has not
 *  changed, which costs one re-read and can never show a stale list. */
export function useSetProjectValue(): MutationResult<"settings.setProjectValue"> {
  return useMutation("settings.setProjectValue", {
    invalidates: ["settings.get", "worktrees.list"],
  });
}

/** Write one worktree value on the GLOBAL rung — this host's `daemon-settings.json`
 *  (workspace-settings D1). The repo rung of the same four values goes through
 *  {@link useSetProjectValue}; both stale the same two reads, for the same reason. */
export function useSetWorktreeValue(): MutationResult<"settings.setWorktreeValue"> {
  return useMutation("settings.setWorktreeValue", {
    invalidates: ["settings.get", "worktrees.list"],
  });
}

/** Every workspace Rennet knows for ONE repository (workspace-settings D6). Keyed by
 *  `repoPath`, never by a project id: a workspace project maps many repositories onto one
 *  identity and that mapping is not invertible, so the two repos of one workspace list
 *  separately. Sizes are measured host-side on every call, so this is asked only where the
 *  Worktrees card is mounted — one read per repo row of the SCOPED project, the same
 *  scoping `settings.guidance` uses. */
export function useWorktreeInventory(
  repoPath: string,
  options?: { readonly enabled?: boolean },
): CommandResult<WorktreeInventory> {
  return useCommand("worktrees.list", { repoPath }, options);
}

/** Remove one workspace by its row id — `git worktree remove` without `--force`, on the
 *  first click (Rule Zero). Stales the inventory it changed AND `session.workBranchState`:
 *  removing a sibling's worktree is one of the events that moves the refs that read is
 *  computed from, and the work-branch strip is somebody else's subtree. */
export function useRemoveWorktree(): MutationResult<"worktrees.remove"> {
  return useMutation("worktrees.remove", {
    invalidates: ["worktrees.list", "session.workBranchState"],
  });
}

// ── The project mark (#900) ───────────────────────────────────────────────────
// Three `project.*` verbs rather than `settings.*`: the logo BYTES live under the
// host's per-project directory (ADR 0004), not on the settings ladder — only the
// `mark` pref that chooses between them does. They bind here anyway, so the whole
// Projects surface names its commands in one file and every write declares the same
// pair of reads it stales: `project.logos` carries the bytes, `settings.get` carries
// the resolved `mark` that decides which of them shows.

/** Every logo file Rennet holds, or just one project's. The sidebar takes the whole
 *  set in ONE read — a read per project row would fan out over the whole tree. */
export function useProjectLogos(projectId?: string): CommandResult<{ logos: ProjectLogo[] }> {
  return useCommand("project.logos", projectId === undefined ? {} : { projectId });
}

/** Store a picked image as the project's logo and make it the project's mark. */
export function useUploadProjectLogo(): MutationResult<"project.uploadLogo"> {
  return useMutation("project.uploadLogo", { invalidates: ["settings.get", "project.logos"] });
}

/** Re-run logo detection over the project's repos and re-copy what it finds. */
export function useDetectProjectLogo(): MutationResult<"project.detectLogo"> {
  return useMutation("project.detectLogo", { invalidates: ["settings.get", "project.logos"] });
}

/** Write a repo's guidance rules to its `.rennet/conventions.json`. Stales BOTH reads
 *  that carry them: the per-repo `settings.guidance` panel and the row on `settings.get`. */
export function useSetGuidance(): MutationResult<"settings.setGuidance"> {
  return useMutation("settings.setGuidance", {
    invalidates: ["settings.get", "settings.guidance"],
  });
}
