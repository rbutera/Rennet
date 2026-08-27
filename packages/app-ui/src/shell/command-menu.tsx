import type { CommandInput } from "@rennet/protocol";
import { commands } from "@rennet/protocol";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandInput as CommandSearchInput,
} from "@rennet/ui";
import { useMemo } from "react";
import { useLocation } from "wouter";
import { useInvoke } from "../data";
import { sessionPath } from "../routes/url";
import { useRennetStore } from "../store";
import {
  buildMenuEntries,
  COMMAND_GROUP_ORDER,
  groupEntries,
  type MenuAction,
  type MenuEntry,
  type RegistryRowView,
  SEARCH_GROUP_ORDER,
} from "./command-menu-entries";
import { useSidebarTree } from "./sidebar-data";

// ─────────────────────────────────────────────────────────────────────────────
// The ⌘P/⌘K command menu (INVENTORY §9). One `@rennet/ui` `Command` dialog controlled
// by `ui.commandMenuOpen`/`commandMenuMode`: cmdk owns fuzzy filtering + ↑/↓/Enter, the
// key owner owns Escape (no private listener here — reconciliation autopsy S7). Ported
// from `spikes/board-prototype/components/command-menu.tsx`: same layout, group-beside-
// title rows, and empty state; the data is sourced from the projection seam + registry
// and navigation runs through wouter (the spike's `next/navigation` dropped).
//
// `⌘P` opens search-first, `⌘K` command-first — one component, the mode reorders the
// groups and swaps the input placeholder. Registry commands render nothing until B10
// flips `exposure.commandMenu` (reconciliation 2); the reader + execution path are real
// and proven against a fixture registry.
// ─────────────────────────────────────────────────────────────────────────────

export function CommandMenu({
  /** The command registry to read registry-command entries from. Defaults to the real
   *  `@rennet/protocol` table (zero `commandMenu:true` rows today); a test injects a
   *  fixture registry to prove a flipped row surfaces + executes. */
  registry = commands as unknown as Readonly<Record<string, RegistryRowView>>,
}: {
  readonly registry?: Readonly<Record<string, RegistryRowView>>;
} = {}) {
  const open = useRennetStore((s) => s.ui.commandMenuOpen);
  const mode = useRennetStore((s) => s.ui.commandMenuMode);
  const setCommandMenuOpen = useRennetStore((s) => s.uiActions.setCommandMenuOpen);
  const setChatOpen = useRennetStore((s) => s.uiActions.setChatOpen);
  const openDialog = useRennetStore((s) => s.uiActions.openDialog);
  const [, navigate] = useLocation();
  const invoke = useInvoke();

  // Sessions ride the SAME projection the sidebar tree reads (empty until B9); projects
  // are real today. Registry entries come from the passed table.
  const { hosts } = useSidebarTree();
  const entries = useMemo(() => buildMenuEntries({ hosts, registry }), [hosts, registry]);
  const groups = useMemo(
    () => groupEntries(entries, mode === "command" ? COMMAND_GROUP_ORDER : SEARCH_GROUP_ORDER),
    [entries, mode],
  );

  function execute(action: MenuAction): void {
    switch (action.kind) {
      case "open-session":
        setChatOpen(true);
        navigate(sessionPath(action.slug));
        break;
      case "navigate":
        navigate(action.path);
        break;
      case "open-dialog":
        openDialog(action.dialog);
        break;
      case "registry-command":
        // Fire-and-forget dispatch (cluster 6). Zero live rows today; a fixture row's
        // handler proves the path. B10 flips real flags + binds live dispatch with no
        // further C11 change.
        void invoke(action.command, {} as CommandInput<typeof action.command>);
        break;
    }
    setCommandMenuOpen(false);
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => setCommandMenuOpen(next)}
      title="Command Menu"
      description="Search sessions, projects, and settings, or run a command."
    >
      <CommandSearchInput
        placeholder={mode === "command" ? "Run a command…" : "Search or run a command…"}
        aria-label={mode === "command" ? "Run a command" : "Search commands"}
      />
      <CommandList>
        <CommandEmpty>No commands match your search.</CommandEmpty>
        {groups.map(([group, items]) => (
          <CommandGroup key={group}>
            {items.map((entry: MenuEntry) => (
              <CommandItem
                key={entry.id}
                value={entry.id}
                keywords={[entry.title, ...entry.keywords]}
                onSelect={() => execute(entry.action)}
              >
                <span className="min-w-[72px] text-2xs font-semibold uppercase tracking-wide text-ink-faint">
                  {group}
                </span>
                <span className="flex-1">{entry.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
