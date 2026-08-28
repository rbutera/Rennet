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
import { useMemo, useState } from "react";
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
  /** The last registry-command dispatch that FAILED, shown in the dialog. A menu row that
   *  cannot run says so — it never closes on a rejected invoke and calls that success. */
  const [failure, setFailure] = useState<string | null>(null);

  // Sessions ride the SAME projection the sidebar tree reads (empty until B9); projects
  // are real today. Registry entries come from the passed table.
  const { hosts } = useSidebarTree();
  const entries = useMemo(() => buildMenuEntries({ hosts, registry }), [hosts, registry]);
  const groups = useMemo(
    () => groupEntries(entries, mode === "command" ? COMMAND_GROUP_ORDER : SEARCH_GROUP_ORDER),
    [entries, mode],
  );

  // A dispatch failure belongs to the open session that produced it: once the menu is
  // closed, drop it so the next ⌘K never opens onto a stale error (React's sanctioned
  // "adjust state during render" pattern — no effect, no extra commit).
  if (!open && failure !== null) setFailure(null);

  function execute(action: MenuAction): void {
    setFailure(null);
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
      case "registry-command": {
        // Live dispatch through the one seam. The registry's `exposure.commandMenu`
        // inventory only carries rows whose schema accepts `{}` (see MENU_EXPOSED in
        // `@rennet/protocol`), so the empty input is the row's real input, not a stub.
        // A rejection re-opens the menu carrying the reason — never a silent success.
        const command = action.command;
        invoke(command, {} as CommandInput<typeof command>).then(
          () => setCommandMenuOpen(false),
          (reason: unknown) => {
            setFailure(
              `${command} failed: ${reason instanceof Error ? reason.message : String(reason)}`,
            );
          },
        );
        // The menu stays open until the dispatch settles — it closes on success, and on
        // failure it stays put carrying the reason. Returning here skips the close below.
        return;
      }
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
      {failure ? (
        <p role="alert" className="m-0 px-3 py-2 text-2xs text-destructive">
          {failure}
        </p>
      ) : null}
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
