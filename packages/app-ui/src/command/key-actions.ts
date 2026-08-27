import type { CommandDef } from "./commands";

// ─────────────────────────────────────────────────────────────────────────────
// The app-level key-action catalogue (C11, §14 item 1 / spike `settings-data.ts`).
//
// Six advertised binds, each a NAMED, remappable app action with a platform-neutral
// default chord (`mod+p` renders `⌘P` on macOS, `Ctrl+P` elsewhere — {@link
// formatKeybinding}). This is the single source both readers agree on:
//   • the ONE global key owner (`shell/key-owner.tsx`) matches a pressed chord
//     against the EFFECTIVE binding (catalogue default overlaid by the user's
//     override) and runs the action, and
//   • the Keyboard Shortcuts settings page lists and remaps these same rows.
// Because the two read one table, what the shortcuts page advertises is exactly what
// the key owner fires — no advertised-but-dead bind (the §14 item 1 UI lie).
//
// Raw `⌘R` is deliberately in NO catalogue and the key owner never binds it (R69,
// registry half): the reload chord stays the browser/native default and the shortcuts
// list carries no reload row. Its on-screen spec-header control is C5's to delete.
//
// The entries are `CommandDef`-shaped so the keybinding helpers C3 kept in
// `command/commands.ts` (`effectiveKeybinding`/`matchKeybinding`/`findConflicts`/
// `formatKeybinding`) apply unchanged — the helpers are imported, never duplicated
// (reconciliation 5). The RUN side (what each id DOES) lives at the key owner, which
// holds the store + router deps; this module is pure data.
// ─────────────────────────────────────────────────────────────────────────────

/** The six app-level key actions, by stable id. */
export type KeyActionId =
  | "search"
  | "commands"
  | "new-chat"
  | "toggle-sidebar"
  | "toggle-chat"
  | "settings";

/**
 * The catalogue. Order is the shortcuts-page order. Each carries a default chord;
 * `search`/`commands` open the ⌘P/⌘K menu (search / command mode), the rest toggle
 * or navigate (the run map lives at the key owner).
 */
export const KEY_ACTIONS: readonly CommandDef[] = [
  { id: "search", title: "Search", group: "General", keybinding: "mod+p" },
  { id: "commands", title: "Command Menu", group: "General", keybinding: "mod+k" },
  { id: "new-chat", title: "New Chat", group: "General", keybinding: "mod+n" },
  { id: "toggle-sidebar", title: "Toggle Sidebar", group: "View", keybinding: "mod+b" },
  { id: "toggle-chat", title: "Toggle Chat", group: "View", keybinding: "mod+j" },
  { id: "settings", title: "Settings", group: "General", keybinding: "mod+," },
];

/** True for one of the six catalogued action ids. */
export function isKeyActionId(id: string): id is KeyActionId {
  return KEY_ACTIONS.some((def) => def.id === id);
}
