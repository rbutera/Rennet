import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Command,
  effectiveKeybinding,
  filterCommands,
  findConflicts,
  formatKeybinding,
  type KeybindingOverrides,
  normalizeChord,
} from "../command/commands";

// ─────────────────────────────────────────────────────────────────────────────
// The ⌘K command palette (wireframes screen 16). A searchable, keyboard-driven
// overlay over the command registry: type to fuzzy-filter, ↑/↓ to move, Enter to
// run, Escape or a click outside to close. It runs the SELECTED command's `run`
// (the app's own handler) then closes.
//
// It is app-wide chrome, so it mounts OUTSIDE `.canvas-app` and dresses in the
// glass tokens (which live on `:root`), matching the collation/publish overlays:
// a dimmed backdrop with one floating frosted window.
// ─────────────────────────────────────────────────────────────────────────────

export interface CommandPaletteProps {
  open: boolean;
  commands: Command[];
  /** User keybinding overrides (#44) — the palette displays the EFFECTIVE chord. */
  overrides?: KeybindingOverrides;
  onClose(): void;
}

export function CommandPalette({ open, commands, overrides, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Conflict disclosure (#44): every chord claimed by more than one command that can
  // fire in this context. Both colliding rows show the chord with a plain collision
  // note naming the other command — never a block, never a refused write (Rule Zero).
  const conflicts = useMemo(() => findConflicts(commands, overrides), [commands, overrides]);
  const titleById = useMemo(
    () => new Map(commands.map((command) => [command.id, command.title])),
    [commands],
  );

  // A fresh open always starts empty, at the top, with the caret ready — the
  // palette is a jump-anywhere prompt, never a surface that remembers a stale query.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Focus after mount so the very first keystroke lands in the search field.
      inputRef.current?.focus();
    }
  }, [open]);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  // Keep the highlight inside the (shrinking) result list as the query narrows it.
  const activeIndex = results.length === 0 ? -1 : Math.min(active, results.length - 1);

  if (!open) return null;

  function runAt(index: number): void {
    const command = results[index];
    if (!command) return;
    // Run the wrapped action FIRST, then close — closing before running would drop
    // a command whose handler reads palette-adjacent state on the same tick.
    command.run();
    onClose();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (results.length === 0 ? 0 : (current + 1) % results.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) =>
        results.length === 0 ? 0 : (current - 1 + results.length) % results.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runAt(activeIndex);
    }
  }

  return (
    <div className="command-palette-backdrop" role="presentation">
      {/* The scrim is a real button: click-out-to-close is a focusable, keyboard-
          operable control, so the dismiss affordance carries no static-element
          handler. It sits behind the dialog, so a click on the dialog never hits it. */}
      <button
        type="button"
        className="command-palette-scrim"
        aria-label="Close the command palette"
        onClick={onClose}
      />
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          type="text"
          className="command-palette-input"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          placeholder="Type a command…"
          aria-label="Search commands"
          aria-controls="command-palette-list"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <ul className="command-palette-list" id="command-palette-list">
          {results.length === 0 ? (
            <li className="command-palette-empty">No commands match “{query.trim()}”.</li>
          ) : (
            results.map((command, index) => (
              <li key={command.id}>
                <button
                  type="button"
                  className={`command-palette-row ${index === activeIndex ? "is-active" : ""}`}
                  aria-current={index === activeIndex ? "true" : undefined}
                  // Hover previews the row the way arrow-keys land on it.
                  onMouseMove={() => setActive(index)}
                  onClick={() => runAt(index)}
                >
                  <span className="command-palette-group">{command.group}</span>
                  <span className="command-palette-title">{command.title}</span>
                  {renderKey(command, overrides, conflicts, titleById)}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
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
): React.ReactNode {
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
      className={`command-palette-key ${conflict ? "is-conflict" : ""}`}
      title={conflict ? `Also bound to ${otherTitles}` : undefined}
      data-conflict={conflict ? "true" : undefined}
    >
      {formatKeybinding(token)}
    </kbd>
  );
}
