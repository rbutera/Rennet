import type { CommandName } from "@rennet/protocol";
import { newChatPath, projectMapPath, settingsPath } from "../routes/url";
import type { SidebarHost } from "./sidebar-data";

// ─────────────────────────────────────────────────────────────────────────────
// Command-menu entries — projections for navigation, the registry for commands
// (INVENTORY §9). PURE builders, no store/router/DOM, so the entry set is unit-
// testable and the #477 fence (entries come ONLY from projections + the registry,
// never from board/diff CONTENT) is a property of the inputs: the builders take a
// projected `hosts` tree and a command registry, and nothing else.
//
// Each entry carries a DESCRIPTOR of its effect (`MenuAction`), not a closure — the
// menu component maps the descriptor to the live store/router effect. That keeps the
// builders pure and one honest step from the seam.
// ─────────────────────────────────────────────────────────────────────────────

/** What selecting an entry does — a descriptor the menu executes (never a closure here). */
export type MenuAction =
  | { readonly kind: "open-session"; readonly slug: string }
  | { readonly kind: "navigate"; readonly path: string }
  | { readonly kind: "open-dialog"; readonly dialog: string }
  | { readonly kind: "registry-command"; readonly command: CommandName };

/** The set of action kinds the menu can produce — the #477 guard asserts entries never
 *  escape it (no board/diff content-search kind exists). */
export const MENU_ACTION_KINDS = [
  "open-session",
  "navigate",
  "open-dialog",
  "registry-command",
] as const;

export interface MenuEntry {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  /** Extra fuzzy-match terms beyond the title (project, host, keywords). */
  readonly keywords: readonly string[];
  readonly action: MenuAction;
}

/** The minimal registry-row shape the menu reads: a label + the `commandMenu` flag.
 *  The real `commands` table (and a test's fixture registry) both satisfy it. */
export interface RegistryRowView {
  readonly label: string;
  readonly exposure: { readonly commandMenu: boolean };
}

/** Sessions (§9): title as the value, project + host as keywords, ARCHIVED excluded.
 *  Running one opens the chat and routes to the session (the menu supplies the effect). */
export function sessionEntries(hosts: readonly SidebarHost[]): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const host of hosts) {
    for (const project of host.projects) {
      for (const session of project.sessions) {
        if (session.archived) continue;
        entries.push({
          id: `session:${session.id}`,
          group: "Session",
          title: session.title,
          keywords: [project.name, host.label],
          action: { kind: "open-session", slug: session.slug },
        });
      }
    }
  }
  return entries;
}

/** Projects (§9): a Context Map entry and a New Chat entry per project. */
export function projectEntries(hosts: readonly SidebarHost[]): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const host of hosts) {
    for (const project of host.projects) {
      entries.push({
        id: `project-map:${project.id}`,
        group: "Project",
        title: `${project.name} — Context Map`,
        keywords: [project.name, "context map"],
        action: { kind: "navigate", path: projectMapPath(project.id) },
      });
      entries.push({
        id: `project-newchat:${project.id}`,
        group: "Project",
        title: `New Chat in ${project.name}`,
        keywords: [project.name, "new chat"],
        action: { kind: "navigate", path: newChatPath(project.id) },
      });
    }
  }
  return entries;
}

/** The four settings pages (§9), each routing to its `/settings/*` path. */
export function settingsEntries(): MenuEntry[] {
  const pages: ReadonlyArray<readonly [string, string]> = [
    ["machine", "Environments"],
    ["appearance", "Appearance"],
    ["shortcuts", "Keyboard Shortcuts"],
    ["projects", "Projects"],
  ];
  return pages.map(([page, title]) => ({
    id: `settings:${page}`,
    group: "Settings",
    title,
    keywords: ["settings"],
    action: { kind: "navigate", path: settingsPath(page) },
  }));
}

/** Action entries (§9): Add Project / Add Environment open their dialog (C12 internals). */
export function actionEntries(): MenuEntry[] {
  return [
    {
      id: "action:add-project",
      group: "Actions",
      title: "Add Project",
      keywords: ["add", "project"],
      action: { kind: "open-dialog", dialog: "add-project" },
    },
    {
      id: "action:add-environment",
      group: "Actions",
      title: "Add Environment",
      keywords: ["add", "environment", "host", "remote"],
      action: { kind: "open-dialog", dialog: "add-environment" },
    },
  ];
}

/**
 * Registry commands (R4): the ONE `commands` table filtered by `exposure.commandMenu`,
 * each surviving row rendered with a label DERIVED from its id (`label`, which #465
 * initializes to the id). ONE row is exposed today; which rows and why is
 * `docs/developing/reference/command-menu-exposure.md`.
 */
export function registryCommandEntries(
  registry: Readonly<Record<string, RegistryRowView>>,
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const [name, row] of Object.entries(registry)) {
    if (row.exposure.commandMenu !== true) continue;
    entries.push({
      id: `command:${name}`,
      group: "Commands",
      title: row.label,
      keywords: [name],
      action: { kind: "registry-command", command: name as CommandName },
    });
  }
  return entries;
}

/** The whole entry set: navigation from the projected tree, commands from the registry. */
export function buildMenuEntries(input: {
  readonly hosts: readonly SidebarHost[];
  readonly registry: Readonly<Record<string, RegistryRowView>>;
}): MenuEntry[] {
  return [
    ...sessionEntries(input.hosts),
    ...projectEntries(input.hosts),
    ...settingsEntries(),
    ...actionEntries(),
    ...registryCommandEntries(input.registry),
  ];
}

/** Group order for the menu's two modes. `⌘P` (search) leads with navigation; `⌘K`
 *  (command) leads with the registry commands + actions — the same entries, re-led. */
export const SEARCH_GROUP_ORDER = ["Session", "Project", "Settings", "Actions", "Commands"];
export const COMMAND_GROUP_ORDER = ["Commands", "Actions", "Settings", "Project", "Session"];

/** Bucket entries by group, emitted in `order` (groups absent from `order` trail behind). */
export function groupEntries(
  entries: readonly MenuEntry[],
  order: readonly string[],
): Array<readonly [string, MenuEntry[]]> {
  const byGroup = new Map<string, MenuEntry[]>();
  for (const entry of entries) {
    const bucket = byGroup.get(entry.group);
    if (bucket) bucket.push(entry);
    else byGroup.set(entry.group, [entry]);
  }
  const seen = new Set<string>();
  const out: Array<readonly [string, MenuEntry[]]> = [];
  for (const group of order) {
    const bucket = byGroup.get(group);
    if (bucket) {
      out.push([group, bucket]);
      seen.add(group);
    }
  }
  for (const [group, bucket] of byGroup) {
    if (!seen.has(group)) out.push([group, bucket]);
  }
  return out;
}
