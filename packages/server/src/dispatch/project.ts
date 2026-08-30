import {
  type CommandInput,
  type CommandOutput,
  type ProjectProcessEvent,
  parseCommandInput,
  parseCommandOutput,
} from "@rennet/protocol";
import type { CommandHandler, DispatchContext, DispatchRuntime } from "./runtime";

export function runProjectProcess(
  rt: DispatchRuntime,
  input: CommandInput<"project.process">,
  ctx?: DispatchContext,
): Promise<CommandOutput<"project.process">> {
  const { deps, liveProjectRuns, attachProjectProgress, progressReplayLimit } = rt;
  const existing = liveProjectRuns.get(input.commandId);
  if (existing) {
    if (existing.projectId !== input.projectId)
      return Promise.reject(
        new Error("A live project.process command ID cannot address another project"),
      );
    attachProjectProgress(existing, ctx);
    return existing.result;
  }

  const events: ProjectProcessEvent[] = [];
  const recipients = new Map<unknown, (event: ProjectProcessEvent) => void>();
  const emit = (event: ProjectProcessEvent): void => {
    events.push(event);
    if (events.length > progressReplayLimit) events.splice(0, events.length - progressReplayLimit);
    for (const recipient of recipients.values()) recipient(event);
  };
  let resolve!: (result: CommandOutput<"project.process">) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<CommandOutput<"project.process">>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  const run = { projectId: input.projectId, events, recipients, result };
  liveProjectRuns.set(input.commandId, run);
  attachProjectProgress(run, ctx);

  try {
    void deps
      .processProject({ projectId: input.projectId, commandId: input.commandId }, emit)
      .then((processed) => {
        emit({
          kind: "done",
          repos: processed.repos,
          ...(processed.run ? { run: processed.run } : {}),
        });
        resolve(processed);
      }, reject);
  } catch (reason) {
    reject(reason);
  }
  const cleanup = (): void => {
    if (liveProjectRuns.get(input.commandId) === run) liveProjectRuns.delete(input.commandId);
  };
  void result.then(cleanup, cleanup);
  return result;
}

export function projectHandlers(rt: DispatchRuntime) {
  const { deps, assertAllowedRepository } = rt;
  return {
    "project.rename": async (rawInput) => {
      const name = "project.rename" as const;
      // Rename the stored display name (C12 cluster 7). An emptied name is not stored
      // empty — the store restores the `org/repo` identity from the project's own path
      // (R67), so the row reads its identity again instead of an unnamed blank. An id
      // that is not stored answers `project: null` with the untouched list, never a throw.
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(
        name,
        deps.projects.rename({ projectId: input.projectId, name: input.name }),
      );
    },
    "project.discover": async (rawInput) => {
      const name = "project.discover" as const;
      // Read-only discovery over the path the user just chose (`repository.choose`
      // granted it). The allowlist is the read-only discovery gate: only a chosen
      // path is scanned, never an arbitrary renderer-supplied one.
      const input = parseCommandInput(name, rawInput);
      assertAllowedRepository(input.path);
      const discovery = await deps.discoverProject({ path: input.path, kind: input.kind });
      // `discoverProject` runs on the selected source's daemon but can't name
      // itself (an in-distro POSIX path is indistinguishable from local), so it
      // hardcodes `source: "local"`. Stamp the SELECTED source onto the discovery
      // the client gets, so it rides through `projects.add` into the persisted
      // Project — without this, every project persists as `local`.
      return parseCommandOutput(name, { discovery: { ...discovery, source: input.source } });
    },
    "project.process": async (rawInput, ctx) => {
      const name = "project.process" as const;
      // The initial context dump: build each included repo's ProjectSnapshot,
      // streaming the real generator stages as live narration. The host owns the
      // generator + store; dispatch owns the terminal `done` event and the
      // resolved value, so both always agree. Soft per-repo failures are carried
      // in the summaries (never a throw), so one bad repo never aborts the rest.
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(name, await runProjectProcess(rt, input, ctx));
    },
    "project.detail": async (rawInput, ctx) => {
      const name = "project.detail" as const;
      // Read-only substrate for a project the user has added. No repository
      // capture, no model spend: real local work (git) + live GitHub OPEN PRs +
      // viewer, which the renderer folds into one list. A missing GitHub token
      // degrades to the local-only half, never a failed fetch shown as zero PRs.
      const input = parseCommandInput(name, rawInput);
      // When the input carried a commandId the transport built `emitProgress`
      // (keyed to that id); pass it as the detail's PR-fetch narration sink. A
      // plain request/response otherwise — no live-run registry: the fetch is
      // short and the renderer subscribes before invoking, so no replay needed.
      return parseCommandOutput(
        name,
        await deps.projectDetail(
          input.projectId,
          input.prStates,
          input.localOnly,
          ctx?.emitProgress,
        ),
      );
    },
    "project.cleanupWorktree": async (rawInput) => {
      const name = "project.cleanupWorktree" as const;
      // The merged-PR read-only row's clean-up. A destructive local act, so it is a
      // command rather than a renderer effect; the host handler runs a real, NON-
      // forcing `git worktree remove` (a dirty worktree is refused, never swept).
      const input = parseCommandInput(name, rawInput);
      const result = await deps.cleanupWorktree({
        projectId: input.projectId,
        worktreeId: input.worktreeId,
      });
      return parseCommandOutput(name, result);
    },
    "project.contextMap": async (rawInput) => {
      const name = "project.contextMap" as const;
      // Pure read of the persisted Repo Map — no rebuild, no model spend. An
      // absent or gate-failing snapshot returns the typed absent, never a
      // fabricated or partially-served map.
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(name, await deps.projectContextMap(input));
    },
    "project.contextAsk": async (rawInput) => {
      const name = "project.contextAsk" as const;
      // Project-scoped ask over the persisted snapshot + knowledge set. A real
      // model turn through the user's own harness; an absent harness or a
      // snapshot refusal is an honest failed result carrying its cost.
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(name, await deps.projectContextAsk(input));
    },
    "project.knowledgeDisposition": async (rawInput) => {
      const name = "project.knowledgeDisposition" as const;
      // The human-confirm surface (R54): flip the statement's status by id and
      // persist. Disposition never edits the claim, so the id stays stable.
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(name, await deps.knowledgeDisposition(input));
    },
  } satisfies Record<string, CommandHandler>;
}
