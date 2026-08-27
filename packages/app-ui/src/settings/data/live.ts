import type { SettingsGuidance, SettingsView } from "@rennet/protocol";
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

/** Set (or reset with `scheme: null`) the global appearance scheme. */
export function useSetAppearance(): MutationResult<"settings.setAppearance"> {
  return useMutation("settings.setAppearance", { invalidates: ["settings.get"] });
}

/** Set / unbind (`null`) / reset (omit) a command's keybinding override (#44). */
export function useSetKeybinding(): MutationResult<"settings.setKeybinding"> {
  return useMutation("settings.setKeybinding", { invalidates: ["settings.get"] });
}

/** Set a repo's map visibility (runs the real gitignore switch). */
export function useSetRepoVisibility(): MutationResult<"settings.setRepoVisibility"> {
  return useMutation("settings.setRepoVisibility", { invalidates: ["settings.get"] });
}

/** Set (or clear with `locus: null`) a repo's execution-locus override. */
export function useSetRepoLocus(): MutationResult<"settings.setRepoLocus"> {
  return useMutation("settings.setRepoLocus", { invalidates: ["settings.get"] });
}

/** Reset a repo-scoped value to inheritance (fall back down the ladder). */
export function useResetRepoValue(): MutationResult<"settings.resetRepoValue"> {
  return useMutation("settings.resetRepoValue", { invalidates: ["settings.get"] });
}

/** Pin a repo-scoped value at the repo layer (freeze the current effective value). */
export function usePinRepoValue(): MutationResult<"settings.pinRepoValue"> {
  return useMutation("settings.pinRepoValue", { invalidates: ["settings.get"] });
}
