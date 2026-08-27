import { Button, Input } from "@rennet/ui";
import { type KeyboardEvent, useMemo, useState } from "react";
import {
  COMMAND_CATALOGUE,
  type CommandDef,
  effectiveKeybinding,
  formatKeybinding,
} from "../command/commands";
import { Section } from "./atoms";
import { useSettingsView } from "./data";

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard Shortcuts page (C10 §7, claims 639–643). Lists every named command in
// the live `COMMAND_CATALOGUE` (the single source the palette + key dispatch read),
// each with its EFFECTIVE binding — the catalogue default overlaid by the user's
// `settings.get` override. Filterable by name.
//
// The binding backing file is `~/.rennet/config.json` (where the LANDED
// `settings.setKeybinding` writes today) — NOT the `client-settings.json` B10's file
// split will introduce (reconciliation; do not invent it).
//
// This page SHOWS + routes the Change control; the remap RECORDER (capturing a
// keystroke into a chord) is C11's shared keybinding surface — there is no recorder
// here. `onChangeBinding` is the seam C11 wires; until then Change is a hover-revealed
// affordance. Escape in the filter clears the filter BEFORE it can close settings
// (stopPropagation), so a reader filtering never loses the whole view to one Escape.
// ─────────────────────────────────────────────────────────────────────────────

/** The static-title label for a catalogue row (settings is a context-independent surface). */
function catalogueLabel(def: CommandDef): string {
  return typeof def.title === "string" ? def.title : def.id;
}

export function ShortcutsPage({
  onChangeBinding,
}: {
  /** Route the Change control to C11's remap recorder. Absent ⇒ a no-op affordance. */
  readonly onChangeBinding?: (commandId: string) => void;
}) {
  const { data } = useSettingsView();
  const overrides = data?.keybindings ?? {};
  const [filter, setFilter] = useState("");

  const query = filter.trim().toLowerCase();
  const shown = useMemo(
    () => COMMAND_CATALOGUE.filter((def) => catalogueLabel(def).toLowerCase().includes(query)),
    [query],
  );

  function onFilterKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Escape clears the filter first; only an already-empty filter lets Escape bubble
    // to the takeover root and close settings.
    if (event.key === "Escape" && filter.length > 0) {
      event.stopPropagation();
      setFilter("");
    }
  }

  return (
    <Section title="Keyboard Shortcuts" caption="~/.rennet/config.json">
      <div className="py-2.5">
        <Input
          type="text"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={onFilterKeyDown}
          placeholder="Filter commands…"
          aria-label="Filter commands"
        />
      </div>
      {shown.length === 0 ? (
        <div className="py-2 text-xs text-ink-soft">No command matches “{filter}”.</div>
      ) : (
        shown.map((def) => {
          const token = effectiveKeybinding(def, overrides);
          return (
            <div
              key={def.id}
              className="group flex min-h-11 items-center gap-3 py-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-line"
            >
              <div className="flex min-w-0 flex-col">
                <span className="text-xs font-medium text-ink">{catalogueLabel(def)}</span>
                <span className="text-2xs text-ink-faint">{def.group}</span>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {token ? (
                  <kbd className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-2xs text-ink">
                    {formatKeybinding(token)}
                  </kbd>
                ) : (
                  <span className="text-2xs text-ink-faint">Unbound</span>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={`Change ${catalogueLabel(def)}`}
                  className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() => onChangeBinding?.(def.id)}
                >
                  Change
                </Button>
              </div>
            </div>
          );
        })
      )}
    </Section>
  );
}
