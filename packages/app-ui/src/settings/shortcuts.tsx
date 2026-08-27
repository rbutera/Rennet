import { Button, Input } from "@rennet/ui";
import { type KeyboardEvent as ReactKeyboardEvent, useMemo, useState } from "react";
import {
  type CommandDef,
  chordFromEvent,
  effectiveKeybinding,
  findConflicts,
  formatKeybinding,
  normalizeChord,
} from "../command/commands";
import { KEY_ACTIONS } from "../command/key-actions";
import { Section } from "./atoms";
import { useSetKeybinding, useSettingsView } from "./data";

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard Shortcuts page (C10 §7, claims 639–643). Lists the SIX advertised app
// binds — the `KEY_ACTIONS` catalogue C11 landed (`command/key-actions.ts`) that the
// ONE global key owner (`shell/key-owner.tsx`) actually fires: ⌘P/⌘K/⌘N/⌘B/⌘J/⌘,.
// The page reads and the owner fires ONE table, so what this page advertises is
// exactly what fires — no advertised-but-dead bind (the §14 item 1 UI lie). It does
// NOT render the legacy `COMMAND_CATALOGUE` (the deleted palette's rows), which the
// owner never binds.
//
// Remapping a row writes through the data seam's `settings.setKeybinding` mutation,
// which INVALIDATES `settings.get` on success. The live key owner shares that one
// cached read (it sits above the outlet and never remounts), so it refetches the
// override and rearms AT ONCE — the new chord fires with no reload. A direct
// `bridge.invoke` would leave that shared read stale (autopsy discipline / reconciliation).
//
// Escape in the filter clears the filter BEFORE it can close settings
// (`stopPropagation`), so a reader filtering never loses the whole view to one Escape;
// an already-empty filter lets Escape bubble to the takeover root and leave.
// The binding backing file is `~/.rennet/config.json` (where the landed
// `settings.setKeybinding` writes today) — NOT the `client-settings.json` B10's file
// split will introduce (reconciliation; do not invent it).
// ─────────────────────────────────────────────────────────────────────────────

/** The static-title label for a catalogue row (settings is a context-independent surface). */
function catalogueLabel(def: CommandDef): string {
  return typeof def.title === "string" ? def.title : def.id;
}

export function ShortcutsPage() {
  const { data } = useSettingsView();
  const overrides = data?.keybindings ?? {};
  // A malformed config makes `settings.setKeybinding` REFUSE (Rule 75); the controls
  // disable so an edit never overwrites bytes we could not parse.
  const malformed = data?.appearanceMalformed ?? false;
  const { mutate: writeKeybinding, pending } = useSetKeybinding();

  const [filter, setFilter] = useState("");
  // The row currently capturing its next keydown as a new chord (the recorder), and a
  // note for a rejected capture (unsupported chord / lone modifier).
  const [recording, setRecording] = useState<string | null>(null);
  const [recordingNote, setRecordingNote] = useState<string>();
  const [error, setError] = useState<string>();

  const query = filter.trim().toLowerCase();
  const shown = useMemo(
    () => KEY_ACTIONS.filter((def) => catalogueLabel(def).toLowerCase().includes(query)),
    [query],
  );

  const conflicts = findConflicts(KEY_ACTIONS, overrides);
  const labelById = new Map(KEY_ACTIONS.map((def) => [def.id, catalogueLabel(def)]));

  function onFilterKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    // Escape clears the filter first; only an already-empty filter lets Escape bubble
    // to the takeover root and close settings.
    if (event.key === "Escape" && filter.length > 0) {
      event.stopPropagation();
      setFilter("");
    }
  }

  // The write goes through the mutation seam; `undefined` keybinding RESETS to default,
  // `null` UNBINDS. Success invalidates `settings.get`, so the live key owner rearms.
  async function write(id: string, keybinding: string | null | undefined): Promise<void> {
    if (pending || malformed) return;
    setError(undefined);
    try {
      await writeKeybinding(keybinding === undefined ? { id } : { id, keybinding });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRecording(null);
      setRecordingNote(undefined);
    }
  }

  // The recorder: the next keydown becomes the new chord token (`mod+e`, `j`). Escape
  // cancels without a write. A plain capture — no modal, no confirmation step (Rule Zero).
  function onRecordKey(id: string, event: ReactKeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    setRecordingNote(undefined);
    if (event.key === "Escape") {
      setRecording(null);
      return;
    }
    // Ignore a lone modifier press — wait for the real key.
    if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) return;
    if (event.shiftKey || event.altKey) {
      setRecordingNote("Shift and Alt combinations are not supported.");
      return;
    }
    const chord = chordFromEvent(event);
    if (chord.unsupported) {
      setRecordingNote("Use the platform primary modifier for modified shortcuts.");
      return;
    }
    const token = `${chord.mod ? "mod+" : ""}${chord.key}`;
    if (!normalizeChord(token)) {
      setRecordingNote("That key is not supported by the v1 chord grammar.");
      return;
    }
    void write(id, token);
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
      {error ? <div className="py-1 text-xs text-accent">{error}</div> : null}
      {malformed ? (
        <div className="py-1 text-xs text-ink-soft">
          <code className="font-mono">~/.rennet/config.json</code> is malformed — fix it to remap a
          shortcut.
        </div>
      ) : null}
      {shown.length === 0 ? (
        <div className="py-2 text-xs text-ink-soft">No command matches “{filter}”.</div>
      ) : (
        shown.map((def) => {
          const token = effectiveKeybinding(def, overrides);
          const chord = token ? normalizeChord(token) : null;
          const chordKey = chord ? `${chord.mod ? "mod+" : ""}${chord.key}` : null;
          const colliding = chordKey ? conflicts.get(chordKey) : undefined;
          const others = colliding?.filter((other) => other !== def.id) ?? [];
          const overridden = overrides[def.id] !== undefined;
          return (
            <div
              key={def.id}
              className="group flex min-h-11 flex-wrap items-center gap-3 py-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-line"
            >
              <div className="flex min-w-0 flex-col">
                <span className="text-xs font-medium text-ink">{catalogueLabel(def)}</span>
                <span className="text-2xs text-ink-faint">{def.group}</span>
              </div>
              <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
                {recording === def.id ? (
                  <Input
                    type="text"
                    readOnly
                    // Focus on mount so the very next keystroke is captured as the chord.
                    ref={(node) => node?.focus()}
                    className="w-32 border-accent-line"
                    aria-label={`Press the new chord for ${catalogueLabel(def)}`}
                    placeholder="Press a chord…"
                    onKeyDown={(event) => onRecordKey(def.id, event)}
                    onBlur={() => {
                      setRecording(null);
                      setRecordingNote(undefined);
                    }}
                  />
                ) : token ? (
                  <kbd
                    className={`rounded border px-1.5 py-0.5 font-mono text-2xs ${
                      others.length > 0
                        ? "border-accent-line bg-raised text-ink"
                        : "border-line bg-raised text-ink"
                    }`}
                    title={
                      others.length > 0
                        ? `Also bound to ${others.map((id) => labelById.get(id) ?? id).join(", ")}`
                        : undefined
                    }
                  >
                    {formatKeybinding(token)}
                  </kbd>
                ) : (
                  <span className="text-2xs text-ink-faint">Unbound</span>
                )}
                {recording === def.id && recordingNote ? (
                  <span className="text-2xs text-accent">{recordingNote}</span>
                ) : null}
                {others.length > 0 ? (
                  <span className="text-2xs text-accent">
                    conflicts with {others.map((id) => labelById.get(id) ?? id).join(", ")}
                  </span>
                ) : null}
                <span className="inline-flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={`Change ${catalogueLabel(def)}`}
                    onClick={() => {
                      setRecordingNote(undefined);
                      setRecording(def.id);
                    }}
                    disabled={pending || malformed}
                  >
                    Change
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={`Unbind ${catalogueLabel(def)}`}
                    onClick={() => void write(def.id, null)}
                    disabled={pending || malformed}
                  >
                    Unbind
                  </Button>
                  {overridden ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={`Reset ${catalogueLabel(def)}`}
                      onClick={() => void write(def.id, undefined)}
                      disabled={pending || malformed}
                    >
                      Reset
                    </Button>
                  ) : null}
                </span>
              </div>
            </div>
          );
        })
      )}
    </Section>
  );
}
