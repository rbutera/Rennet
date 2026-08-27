import { type CommandName, commands } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { appToolName, buildAppTools } from "./agent-tools";

// The registry-iteration proof (#465, task 2.4). The `app_*` surface is built by iterating the
// command registry for `exposure.agent` rows — no hand-kept list. This asserts the surface is a
// pure projection of that flag, so a command flipped into `AGENT_EXPOSED` (protocol) materializes
// as a tool with NO change to `agent-tools.ts`.
//
// Positive control (shown once, never committed failing): adding an id to `AGENT_EXPOSED` in
// protocol makes `agentRows` and the tool set grow together and the first `toEqual` still holds
// while the v1-membership `toBe(true)` for the new id would pass with no edit here; removing a row
// from either side breaks the `toEqual`. Both directions can fail.

const agentRows = (Object.keys(commands) as CommandName[]).filter(
  (id) => commands[id].exposure.agent,
);
const noop: () => Promise<unknown> = async () => undefined;

describe("app_* agent tool surface (#465)", () => {
  it("emits exactly one tool per exposure.agent row — a pure projection of the registry flag", () => {
    const tools = buildAppTools(noop);
    expect(tools.map((t) => t.commandId).sort()).toEqual([...agentRows].sort());
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it("includes the v1 non-session set and excludes the v1-OUT commands", () => {
    const ids = new Set(buildAppTools(noop).map((t) => t.commandId));
    for (const on of [
      "projects.add",
      "projects.list",
      "review.openPr",
      "review.capture",
    ] as const) {
      expect(ids.has(on)).toBe(true);
    }
    // remove-project stays off; search / pair-remote have no command id at all (v1 OUT).
    expect(ids.has("projects.remove" as CommandName)).toBe(false);
  });

  it("names tools in app_<id> grammar with dots flattened", () => {
    expect(appToolName("projects.add")).toBe("app_projects_add");
    for (const t of buildAppTools(noop)) expect(t.name).toMatch(/^app_[a-z0-9_]+$/i);
  });

  it("carries the registry args schema and dispatches its command id on run", async () => {
    const dispatch = vi.fn(noop);
    const add = buildAppTools(dispatch).find((t) => t.commandId === "projects.add");
    expect(add?.inputSchema).toBe(commands["projects.add"].args);
    await add?.run({ path: "/x" });
    expect(dispatch).toHaveBeenCalledWith("projects.add", { path: "/x" }, undefined);
  });

  it("does not fold in the whiteboard five — every tool is a registry command, app_-prefixed", () => {
    const tools = buildAppTools(noop);
    for (const t of tools) {
      expect(t.name.startsWith("app_")).toBe(true);
      expect(Object.hasOwn(commands, t.commandId)).toBe(true);
    }
    // The whiteboard five are WhiteboardClient methods, not registry ids — structurally absent.
    for (const wb of ["create", "schema", "apply", "describe", "events"]) {
      expect(tools.some((t) => t.name === wb || t.name === `app_${wb}`)).toBe(false);
    }
  });
});
