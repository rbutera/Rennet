import { describe, expect, it } from "vitest";
import {
  actionEntries,
  buildMenuEntries,
  COMMAND_GROUP_ORDER,
  groupEntries,
  MENU_ACTION_KINDS,
  type RegistryRowView,
  registryCommandEntries,
  SEARCH_GROUP_ORDER,
  sessionEntries,
  settingsEntries,
} from "./command-menu-entries";
import type { SidebarHost } from "./sidebar-data";

// The projected tree the menu reads — sessions from the projection, projects real.
const HOSTS: readonly SidebarHost[] = [
  {
    id: "local",
    label: "This machine",
    kind: "local",
    projects: [
      {
        id: "p1",
        name: "atlas",
        fallbackName: "org/atlas",
        sessions: [
          { id: "s1", slug: "s1", title: "Alpha", time: "2h", target: "your-branch" },
          { id: "s2", slug: "s2", title: "Beta", time: "3h", target: "your-pr", archived: true },
        ],
      },
    ],
  },
];

/** A registry where every row is `commandMenu:false` — the honest today (reconciliation 2). */
const ALL_HIDDEN: Record<string, RegistryRowView> = {
  "settings.get": { label: "settings.get", exposure: { commandMenu: false } },
  "projects.list": { label: "projects.list", exposure: { commandMenu: false } },
};

/** A fixture with ONE flipped row — proves a `commandMenu:true` row surfaces (B10). */
const ONE_EXPOSED: Record<string, RegistryRowView> = {
  "settings.get": { label: "settings.get", exposure: { commandMenu: false } },
  "harness.detect": { label: "harness.detect", exposure: { commandMenu: true } },
};

describe("command-menu entries — projections for navigation, the registry for commands", () => {
  it("sessions: excludes archived, carries project+host keywords, opens the session", () => {
    const entries = sessionEntries(HOSTS);
    expect(entries).toHaveLength(1); // Beta is archived → excluded
    const alpha = entries[0];
    expect(alpha?.title).toBe("Alpha");
    expect(alpha?.group).toBe("Session");
    expect(alpha?.keywords).toEqual(["atlas", "This machine"]);
    expect(alpha?.action).toEqual({ kind: "open-session", slug: "s1" });
  });

  it("settings: the four §9 pages route to their /settings/* paths", () => {
    const entries = settingsEntries();
    expect(entries.map((e) => e.title)).toEqual([
      "Environments",
      "Appearance",
      "Keyboard Shortcuts",
      "Projects",
    ]);
    expect(entries.every((e) => e.action.kind === "navigate")).toBe(true);
  });

  it("actions: Add Project / Add Environment open their dialog", () => {
    const entries = actionEntries();
    expect(entries.map((e) => e.action)).toEqual([
      { kind: "open-dialog", dialog: "add-project" },
      { kind: "open-dialog", dialog: "add-environment" },
    ]);
  });

  it("registry commands: zero rows today, and a flipped row surfaces with an id-derived label", () => {
    // Reconciliation 2: every row initializes commandMenu:false → the channel renders nothing.
    expect(registryCommandEntries(ALL_HIDDEN)).toEqual([]);
    // A flipped row surfaces the instant B10 flips it — label derived from the command id.
    const exposed = registryCommandEntries(ONE_EXPOSED);
    expect(exposed).toHaveLength(1);
    expect(exposed[0]).toMatchObject({
      title: "harness.detect",
      group: "Commands",
      action: { kind: "registry-command", command: "harness.detect" },
    });
  });

  it("#477 fence: entries are sourced only from projections + the registry, never content", () => {
    // The guard is structural: buildMenuEntries takes ONLY hosts + a registry, so no
    // board/diff content can enter, and every action stays inside the allowed kinds.
    const entries = buildMenuEntries({ hosts: HOSTS, registry: ONE_EXPOSED });
    for (const entry of entries) {
      expect(MENU_ACTION_KINDS).toContain(entry.action.kind);
    }
    // With the real-today registry (all hidden), the only entries are navigation.
    const live = buildMenuEntries({ hosts: HOSTS, registry: ALL_HIDDEN });
    expect(live.some((e) => e.action.kind === "registry-command")).toBe(false);
  });

  it("groups entries in the mode's order", () => {
    const entries = buildMenuEntries({ hosts: HOSTS, registry: ONE_EXPOSED });
    const search = groupEntries(entries, SEARCH_GROUP_ORDER).map(([g]) => g);
    const command = groupEntries(entries, COMMAND_GROUP_ORDER).map(([g]) => g);
    // Search leads with Session; command leads with Commands.
    expect(search[0]).toBe("Session");
    expect(command[0]).toBe("Commands");
    expect(search).not.toEqual(command);
  });
});
