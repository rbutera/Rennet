import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
} from "react";
import { useLocation } from "wouter";
import {
  type Chord,
  chordFromEvent,
  type KeybindingOverrides,
  matchKeybinding,
} from "../command/commands";
import { isKeyActionId, KEY_ACTIONS, type KeyActionId } from "../command/key-actions";
import { useCommand } from "../data";
import { settingsPath } from "../routes/url";
import { useRennetStore } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// The ONE global key owner (autopsy S7). A SINGLE window-level keydown owner, mounted
// once by the frame, replaces the spike's six-plus hand-rolled Escape listeners with
// one deterministic authority + a priority stack.
//
// Two concerns, two listeners, ONE owner:
//   • Escape — a CAPTURE-phase listener, so it resolves BEFORE an overlay's own
//     dismiss (e.g. the command menu's Base UI dialog) and the priority stack, not a
//     listener race, decides what closes. It is GATED: it only acts while the owner
//     actually owns something open (a dialog, the menu, or a registered layer), so a
//     focused editor's local Escape (C4's line/selection editors) still works when
//     nothing global is open — those adopt {@link useKeyLayer} later without forced churn.
//   • App action chords (⌘P/⌘K/⌘N/⌘B/⌘J/⌘,) — a BUBBLE-phase listener, so a focused
//     element that consumed the key (React `onKeyDown` + `stopPropagation`, e.g. the
//     settings keybinding recorder) preempts it before it reaches the window.
//
// Escape resolves top-down: the frontmost `ui.openDialogs` entry, else `ui.commandMenuOpen`
// (close the menu), else the topmost registered layer, else no-op. Non-Escape keys give
// the top live registered layer first refusal, then match the effective app binding
// (catalogue default overlaid by the user's override) and run the action. Raw `⌘R` is in
// no catalogue, so the owner never binds it (R69).
// ─────────────────────────────────────────────────────────────────────────────

/** A key layer's handler: returns true when it consumed the key. */
export type KeyLayerHandler = (event: KeyboardEvent, chord: Chord) => boolean;

/** One registered layer: a priority + the latest handler (via refs, so a re-render
 *  never re-registers and the newest closure always runs). */
interface LayerEntry {
  readonly seq: number;
  readonly priority: RefObject<number>;
  readonly onKey: RefObject<KeyLayerHandler>;
}

/** The layer stack. Highest priority wins; ties break toward the most recently
 *  registered layer (a stack), so a later overlay sits above an earlier peer. */
class LayerStack {
  #entries: LayerEntry[] = [];
  #seq = 0;

  add(priority: RefObject<number>, onKey: RefObject<KeyLayerHandler>): () => void {
    const entry: LayerEntry = { seq: this.#seq++, priority, onKey };
    this.#entries.push(entry);
    return () => {
      this.#entries = this.#entries.filter((e) => e !== entry);
    };
  }

  /** The frontmost live layer, or null when the stack is empty. */
  top(): LayerEntry | null {
    let best: LayerEntry | null = null;
    for (const entry of this.#entries) {
      if (
        best === null ||
        entry.priority.current > best.priority.current ||
        (entry.priority.current === best.priority.current && entry.seq > best.seq)
      ) {
        best = entry;
      }
    }
    return best;
  }
}

const LayerStackContext = createContext<LayerStack | null>(null);

/**
 * Register a key layer for the lifetime of the calling component. The highest live
 * layer gets first refusal on a non-Escape key and sits atop the Escape priority stack
 * (below the built-in dialog + menu layers). Must be used within a {@link KeyOwner}.
 */
export function useKeyLayer(options: { priority: number; onKey: KeyLayerHandler }): void {
  const stack = useContext(LayerStackContext);
  if (!stack) throw new Error("useKeyLayer must be used within <KeyOwner>");
  const priority = useRef(options.priority);
  priority.current = options.priority;
  const onKey = useRef(options.onKey);
  onKey.current = options.onKey;
  // Register once per stack; the refs carry the live priority/handler, so a re-render
  // must NOT re-register (that would churn the stack order).
  useEffect(() => stack.add(priority, onKey), [stack]);
}

/** Run one app action by id — the RUN side of the key-action catalogue. */
function runKeyAction(id: KeyActionId, navigate: (to: string) => void): void {
  const { ui, uiActions } = useRennetStore.getState();
  switch (id) {
    case "search":
      uiActions.setCommandMenuOpen(true, "search");
      return;
    case "commands":
      uiActions.setCommandMenuOpen(true, "command");
      return;
    case "new-chat":
      // The dialog internals are C12; C11 only opens it (pushes its id).
      uiActions.openDialog("new-chat");
      return;
    case "toggle-sidebar":
      uiActions.toggleSidebar();
      return;
    case "toggle-chat":
      uiActions.setChatOpen(!ui.chatOpen);
      return;
    case "settings":
      navigate(settingsPath("appearance"));
      return;
  }
}

/**
 * The frame's key owner. Mounts the window listeners once, provides the layer stack to
 * its descendants (the command menu + the outlet), and renders its children.
 */
export function KeyOwner({ children }: { readonly children: ReactNode }): ReactNode {
  const stack = useRef(new LayerStack()).current;
  const [, navigate] = useLocation();

  // The effective keybinding overrides load on boot through `settings.get`, so after a
  // reload the owner already matches a remapped chord. A read error (or a bridge with no
  // handler) degrades to the catalogue defaults — never a crash.
  const { data } = useCommand("settings.get", {});
  const overridesRef = useRef<KeybindingOverrides>({});
  overridesRef.current = data?.keybindings ?? {};
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const consume = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
    };

    // Escape — capture phase, gated to owner-tracked state so focused editors keep theirs.
    const onEscapeCapture = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const { ui, uiActions } = useRennetStore.getState();
      const topDialog = ui.openDialogs.at(-1) ?? null;
      if (topDialog !== null) {
        uiActions.closeDialog(topDialog);
        consume(event);
        return;
      }
      if (ui.commandMenuOpen) {
        uiActions.setCommandMenuOpen(false);
        consume(event);
        return;
      }
      const top = stack.top();
      if (top?.onKey.current(event, chordFromEvent(event))) {
        consume(event);
        return;
      }
      // Nothing owner-tracked is open — leave Escape for a focused editor's own handler.
    };

    // App action chords — bubble phase, so a focused consumer preempts.
    const onActionBubble = (event: KeyboardEvent): void => {
      if (event.key === "Escape") return;
      const chord = chordFromEvent(event);
      const top = stack.top();
      if (top?.onKey.current(event, chord)) return; // top layer's first refusal
      const action = matchKeybinding(KEY_ACTIONS, chord, overridesRef.current);
      if (!action || !isKeyActionId(action.id)) return;
      event.preventDefault();
      runKeyAction(action.id, navigateRef.current);
    };

    window.addEventListener("keydown", onEscapeCapture, true);
    window.addEventListener("keydown", onActionBubble);
    return () => {
      window.removeEventListener("keydown", onEscapeCapture, true);
      window.removeEventListener("keydown", onActionBubble);
    };
  }, [stack]);

  return <LayerStackContext.Provider value={stack}>{children}</LayerStackContext.Provider>;
}
