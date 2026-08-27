import { type CommandName, commands } from "@rennet/protocol";
import type { ZodTypeAny } from "zod";
import type { DispatchContext } from "./dispatch";

// The `app_*` in-process agent tool surface (#465). The orchestrator's app tools are the
// THIRD reader of the one command registry (`protocol/commands`), alongside the dispatch
// map and the ⌘K menu — none carries its own list. This module derives the tools by
// ITERATING the registry for rows where `exposure.agent` is true; flipping a row into
// `AGENT_EXPOSED` (in protocol) makes its tool appear here with no edit — the surface is a
// pure projection of the flag. The whiteboard five (`WhiteboardClient`, #455-locked names)
// are HTTP MCP tools and are NOT part of this loop; they stay exactly as they are.

/** The dispatch surface the app tools call through — the exact shape `createDispatch` returns. */
export type AppToolDispatch = (
  name: CommandName,
  rawInput: unknown,
  ctx?: DispatchContext,
) => Promise<unknown>;

/**
 * One in-process `app_*` SDK tool, derived from a registry row. A neutral descriptor — name +
 * zod input schema + a `run()` that dispatches the command — that the orchestrator turn maps
 * onto the harness SDK's `tool()` when it constructs a turn (no MCP transport for these). The
 * whiteboard five are excluded by construction: their names are `WhiteboardClient` methods, not
 * registry command ids, so they can never fall into this set.
 */
export interface AppTool {
  /** `app_<commandId with '.'→'_'>` — the MCP/SDK tool-name grammar (no dots). */
  readonly name: string;
  readonly commandId: CommandName;
  readonly description: string;
  readonly inputSchema: ZodTypeAny;
  readonly run: (input: unknown, ctx?: DispatchContext) => Promise<unknown>;
}

/** `projects.add` → `app_projects_add`. Command ids carry dots; tool names may not. */
export function appToolName(commandId: string): string {
  return `app_${commandId.replaceAll(".", "_")}`;
}

/**
 * Build the `app_*` tool surface by iterating the command registry (#465): every row whose
 * `exposure.agent` is true becomes exactly one in-process tool, its args schema and label taken
 * from the row. Rule Zero: this is a plain projection — no per-tool allow/deny list, no gate.
 */
export function buildAppTools(dispatch: AppToolDispatch): readonly AppTool[] {
  return (Object.keys(commands) as CommandName[])
    .filter((id) => commands[id].exposure.agent)
    .map((id) => ({
      name: appToolName(id),
      commandId: id,
      description: commands[id].label,
      inputSchema: commands[id].args,
      run: (input: unknown, ctx?: DispatchContext) => dispatch(id, input, ctx),
    }));
}
