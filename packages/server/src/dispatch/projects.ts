import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function projectsHandlers(rt: DispatchRuntime) {
  const { deps, allowedRoots } = rt;
  return {
    "projects.list": async (rawInput) => {
      const name = "projects.list" as const;
      parseCommandInput(name, rawInput);
      const projects = deps.projects.list();
      // Re-grant every persisted project's open target so a project row opened
      // after a relaunch reaches `review.capture` (the user added these paths).
      for (const project of projects) allowedRoots.add(project.openPath);
      return parseCommandOutput(name, { projects });
    },
    "projects.add": async (rawInput) => {
      const name = "projects.add" as const;
      // Confirm. MAIN derives the stored shape from the discovery + the toggle
      // choices, then grants the new open target so the row is immediately openable.
      const input = parseCommandInput(name, rawInput);
      // The daemon this project lives on rides in on the discovery: the discover
      // handler stamped the selected source onto it, and `deriveProjectDraft`
      // persists `discovery.source`. The `?? "local"` only fires for a caller that
      // omitted it entirely (schema default), never masking a real selection.
      const { project, projects } = deps.projects.add({
        discovery: { ...input.discovery, source: input.discovery.source ?? "local" },
        includedRepos: [...input.includedRepos],
        primaryBranch: input.primaryBranch,
      });
      allowedRoots.add(project.openPath);
      return parseCommandOutput(name, { project, projects });
    },
    "projects.remove": async (rawInput) => {
      const name = "projects.remove" as const;
      // Forget a project. The working tree is untouched; only the stored record
      // is dropped. Returns the surviving list so the front door updates at once.
      const input = parseCommandInput(name, rawInput);
      const { projects } = deps.projects.remove({ projectId: input.projectId });
      return parseCommandOutput(name, { projects });
    },
  } satisfies Record<string, CommandHandler>;
}
