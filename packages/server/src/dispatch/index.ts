import { type CommandName, isCommandName } from "@rennet/protocol";
import { appHandlers } from "./app";
import { askHandlers } from "./ask";
import { attentionHandlers } from "./attention";
import { deviceHandlers } from "./device";
import { flaggedHandlers } from "./flagged";
import { fsHandlers } from "./fs";
import { githubHandlers } from "./github";
import { harnessHandlers } from "./harness";
import { noiseHandlers } from "./noise";
import { openspecHandlers } from "./openspec";
import { pairingHandlers } from "./pairing";
import { patchsetHandlers } from "./patchset";
import { projectHandlers } from "./project";
import { projectsHandlers } from "./projects";
import { publishHandlers } from "./publish";
import { repositoryHandlers } from "./repository";
import { reviewHandlers } from "./review";
import { reworkHandlers } from "./rework";
import { roundHandlers } from "./round";
import {
  type CommandHandler,
  createDispatchRuntime,
  type DispatchContext,
  type DispatchDeps,
  type DispatchRuntime,
} from "./runtime";
import { settingsHandlers } from "./settings";

// Re-export the public router surface so `./dispatch` stays the single import site
// for consumers (`create-server.ts`, the tests) after the switch became a directory.
export type {
  CommandHandler,
  DispatchContext,
  DispatchDeps,
  DispatchRuntime,
  FlaggedReviewRun,
  PairingCommands,
} from "./runtime";
export { createDispatchRuntime } from "./runtime";

/**
 * The review-scoped turn commands whose run marks their review "running" (#383 batch, finding
 * 2). Each carries an existing `reviewId` in its input, so the review is already on a client's
 * list and can flip to running while the turn is in flight. `review.capture` (first capture)
 * and `review.openPr` mint a NEW review — there is no prior row to mark — so they are excluded;
 * their in-flight state is the review-finished raise on completion, not a running flag.
 */
const RUNNING_TURN_COMMANDS = new Set<CommandName>([
  "review.regenerate",
  "review.refine",
  "review.handoff.run",
  "review.ask",
]);

/** The reviewId a running-turn command operates on, or undefined if it is not one / has none. */
function runningReviewIdOf(name: CommandName, rawInput: unknown): string | undefined {
  if (!RUNNING_TURN_COMMANDS.has(name)) return undefined;
  const reviewId = (rawInput as { reviewId?: unknown } | null | undefined)?.reviewId;
  return typeof reviewId === "string" && reviewId.length > 0 ? reviewId : undefined;
}

/**
 * Assemble the `{ commandId → handler }` table from the per-family modules (#465). This is
 * the registry-driven router that replaced the 2,357-line `switch (name)`: the registry's
 * command ids are the enumeration authority, and the compile-time exhaustiveness check below
 * plus the runtime diff-empty test prove the table serves every command the switch did.
 */
export function buildDispatchTable(rt: DispatchRuntime) {
  const table = {
    ...appHandlers(rt),
    ...askHandlers(rt),
    ...attentionHandlers(rt),
    ...deviceHandlers(rt),
    ...flaggedHandlers(rt),
    ...fsHandlers(rt),
    ...githubHandlers(rt),
    ...harnessHandlers(rt),
    ...noiseHandlers(rt),
    ...openspecHandlers(rt),
    ...pairingHandlers(rt),
    ...patchsetHandlers(),
    ...projectHandlers(rt),
    ...projectsHandlers(rt),
    ...publishHandlers(rt),
    ...repositoryHandlers(rt),
    ...reviewHandlers(rt),
    ...reworkHandlers(rt),
    ...roundHandlers(rt),
    ...settingsHandlers(rt),
  };
  // Compile-time exhaustiveness guard — the successor to the old `switch` default's `never`
  // assertion. If a registry command has no handler (or an id is renamed), `MissingCommand`
  // is that id and the assignment fails to type-check, so a route can never silently go missing.
  type MissingCommand = Exclude<CommandName, keyof typeof table>;
  const _assertExhaustive: [MissingCommand] extends [never] ? true : { missing: MissingCommand } =
    true;
  void _assertExhaustive;
  return table;
}

/**
 * The command router (issue #54 / #465). Build the shared per-invocation runtime, assemble the
 * per-family handler table, and return the same `(name, rawInput, ctx)` dispatch surface the
 * old switch exposed — the DI shape (`createDispatch({...})`) and its `create-server.ts`
 * consumer are preserved. The map is the only router; an unregistered id fails exactly as the
 * switch's `default` did (Rule Zero — no new gate).
 */
export function createDispatch(
  deps: DispatchDeps,
): (name: CommandName, rawInput: unknown, ctx?: DispatchContext) => Promise<unknown> {
  const rt = createDispatchRuntime(deps);
  const table = buildDispatchTable(rt);
  const handlers = new Map<CommandName, CommandHandler>(
    Object.entries(table) as [CommandName, CommandHandler][],
  );

  return async function dispatch(
    name: CommandName,
    rawInput: unknown,
    ctx?: DispatchContext,
  ): Promise<unknown> {
    // Mark the review running for the duration of a review-scoped turn (#383 batch), so a
    // concurrent app.bootstrap / review.load projects `attention.running: true` for it.
    const runningReviewId = runningReviewIdOf(name, rawInput);
    if (runningReviewId) deps.inFlightReviews?.enter(runningReviewId);
    try {
      const handler = handlers.get(name);
      if (!handler) {
        // The map is the only router; an unregistered id fails the same way the switch's
        // `default` did (it was compile-time `never`, so this is reachable only for a bad
        // dynamic call). No new gate — Rule Zero.
        throw new Error(`Unhandled command: ${isCommandName(name) ? name : String(name)}`);
      }
      return await handler(rawInput, ctx);
    } finally {
      if (runningReviewId) deps.inFlightReviews?.leave(runningReviewId);
    }
  };
}
