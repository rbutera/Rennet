import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

/**
 * The workspace inventory's two commands (workspace-settings D6).
 *
 * Both are keyed by `repoPath` and NEVER by a project id: a workspace project holds many
 * repositories under one identity and that mapping is not invertible, so the two repos of
 * one workspace list — and remove — separately (CLAUDE.md, 2026-08-28). The composition
 * root resolves the path through that repository's own locus, which is what makes a WSL
 * repository list its worktrees through the git inside its distro.
 *
 * Neither command confirms anything: the list is a read, and the removal runs on the first
 * click (Rule Zero). What stops a removal is git itself, and git's refusal is what comes
 * back.
 */
export function worktreesHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "worktrees.list": async (rawInput) => {
      const name = "worktrees.list" as const;
      const input = parseCommandInput(name, rawInput);
      // No inventory seam wired ⇒ an honestly empty list. Not a fabricated row, and not
      // a throw: the surface renders its empty state, which is the truth for this daemon.
      if (!deps.worktrees) return parseCommandOutput(name, { rows: [], truncated: false });
      return parseCommandOutput(name, await deps.worktrees.list(input.repoPath));
    },
    "worktrees.remove": async (rawInput) => {
      const name = "worktrees.remove" as const;
      const input = parseCommandInput(name, rawInput);
      if (!deps.worktrees) {
        return parseCommandOutput(name, {
          status: "not-removable",
          id: input.id,
          reason: "not a workspace Rennet knows for this repository",
        });
      }
      return parseCommandOutput(
        name,
        await deps.worktrees.remove({ repoPath: input.repoPath, id: input.id }),
      );
    },
  } satisfies Record<string, CommandHandler>;
}
