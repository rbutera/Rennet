import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@rennet/ui";
import { type ReactNode, useMemo } from "react";
import {
  COMMAND_CATALOGUE,
  type Command,
  effectiveKeybinding,
  findConflicts,
  formatKeybinding,
  type KeybindingOverrides,
  normalizeChord,
} from "../command/commands";

// ─────────────────────────────────────────────────────────────────────────────
// The ⌘K command palette (wireframes screen 16). A thin wrapper over the vendored
// kit Command (cmdk): cmdk owns fuzzy filtering and ↑/↓/Enter navigation, the kit
// Dialog (Base UI) owns the portal / focus trap / Escape+outside dismiss. This file
// only feeds the pre-built command registry into CommandItems (grouped by category)
// and runs the SELECTED command's `run` on select, then closes.
//
// The ⌘K open binding lives at the app.tsx window listener (the `palette.toggle`
// registry command); this component stays controlled (`open` + `onClose`) so that
// wiring is unchanged. The keybinding-conflict disclosure (#44) is the one piece of
// bespoke rendering kept — cmdk owns filtering, not the chord column.
// ─────────────────────────────────────────────────────────────────────────────

export interface CommandPaletteProps {
  open: boolean;
  commands: Command[];
  /** User keybinding overrides (#44) — the palette displays the EFFECTIVE chord. */
  overrides?: KeybindingOverrides;
  onClose(): void;
}

export function CommandPalette({ open, commands, overrides, onClose }: CommandPaletteProps) {
  // Conflict disclosure (#44): every chord claimed by more than one command that can
  // fire in this context (the live list plus catalogue-only entries like palette.toggle).
  // Both colliding rows show the chord with a plain note naming the other command —
  // never a block, never a refused write (Rule Zero).
  const conflicts = useMemo(
    () =>
      findConflicts(
        [
          ...commands,
          ...COMMAND_CATALOGUE.filter(
            (definition) => !commands.some((command) => command.id === definition.id),
          ),
        ],
        overrides,
      ),
    [commands, overrides],
  );
  const titleById = useMemo(
    () =>
      new Map([
        ...COMMAND_CATALOGUE.map(
          (definition) =>
            [
              definition.id,
              typeof definition.title === "string" ? definition.title : definition.id,
            ] as const,
        ),
        ...commands.map((command) => [command.id, command.title] as const),
      ]),
    [commands],
  );

  // Group the commands by their category, preserving registry order both within and
  // across groups (an empty query keeps this order; cmdk re-ranks as the query narrows).
  const groups = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, Command[]>();
    for (const command of commands) {
      const bucket = byGroup.get(command.group);
      if (bucket) {
        bucket.push(command);
      } else {
        byGroup.set(command.group, [command]);
        order.push(command.group);
      }
    }
    return order.map((group) => [group, byGroup.get(group) ?? []] as const);
  }, [commands]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className="command-palette"
      title="Command palette"
      description="Type a command to run it."
    >
      <CommandInput
        className="command-palette-input"
        placeholder="Type a command…"
        aria-label="Search commands"
      />
      <CommandList>
        <CommandEmpty className="command-palette-empty">
          No commands match your search.
        </CommandEmpty>
        {groups.map(([group, items]) => (
          <CommandGroup key={group}>
            {items.map((command) => (
              <CommandItem
                key={command.id}
                className="command-palette-row"
                // Filter/rank on "Group Title", the same corpus the old fuzzy filter
                // scored; unique per command so cmdk never dedupes two rows together.
                value={`${command.group} ${command.title}`}
                onSelect={() => {
                  // Run the wrapped action FIRST, then close — closing before running
                  // would drop a command whose handler reads palette-adjacent state.
                  command.run();
                  onClose();
                }}
              >
                {/* The category rides on each row (the original per-row column), not a
                    section heading — keeps the palette's identity and each row's
                    accessible name ("Group Title"). */}
                <span className="command-palette-group min-w-[76px] text-2xs font-semibold tracking-wide text-ink-faint uppercase">
                  {command.group}
                </span>
                <span className="command-palette-title flex-1">{command.title}</span>
                {renderKey(command, overrides, conflicts, titleById)}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

/**
 * The row's keybinding cell: the EFFECTIVE chord (default overlaid by the user's
 * override, #44), formatted per platform. When the chord collides with another live
 * command, the cell carries a `is-conflict` style and a `title` naming the other
 * command — plain disclosure, never a block (Rule Zero). No effective chord ⇒ nothing.
 */
function renderKey(
  command: Command,
  overrides: KeybindingOverrides | undefined,
  conflicts: Map<string, string[]>,
  titleById: Map<string, string>,
): ReactNode {
  const token = effectiveKeybinding(command, overrides);
  if (!token) return null;
  const chord = normalizeChord(token);
  const chordKey = chord ? `${chord.mod ? "mod+" : ""}${chord.key}` : null;
  const colliding = chordKey ? conflicts.get(chordKey) : undefined;
  const others = colliding?.filter((id) => id !== command.id) ?? [];
  const conflict = others.length > 0;
  const otherTitles = others.map((id) => titleById.get(id) ?? id).join(", ");
  return (
    <kbd
      className={`command-palette-key rounded-chip border bg-raised px-1.5 py-0.5 font-sans text-2xs ${conflict ? "is-conflict border-accent-line text-ink" : "border-line-strong text-ink-soft"}`}
      title={conflict ? `Also bound to ${otherTitles}` : undefined}
      data-conflict={conflict ? "true" : undefined}
    >
      {formatKeybinding(token)}
    </kbd>
  );
}
