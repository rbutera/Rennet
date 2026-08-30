import type { ProjectProcessEvent } from "@rennet/protocol";
import type { StateCreator } from "zustand";
import type { RennetState } from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// The `ui` slice (C01 §3): app chrome interaction state — sidebar open + per-node
// fold state, chat dock open + width, the command menu, and open dialogs. There is
// NO `sidebar` slice: the host/project/session TREE is a server projection (its rows
// and their mutations are C3's commands, read through the data seam); what remains of
// the spike's sidebar slice is fold state, which is `ui`. The active-session highlight
// is DERIVED from the route, never stored here.
// ─────────────────────────────────────────────────────────────────────────────

/** The ⌘P/⌘K command menu's default view. `⌘P` opens it search-first, `⌘K`
 *  command-first — one dialog, two entry modes (C11 reconciliation 1). */
export type CommandMenuMode = "search" | "command";

export interface UiState {
  /** The sidebar region is open (the layout renders it; the tree inside is a projection). */
  readonly sidebarOpen: boolean;
  /** Per-node collapse state, keyed by node id: `true` ⇒ folded. ABSENT means the
   *  reviewer has not touched this node, so the surface picks its own default —
   *  the sidebar's projects default to folded unless the node holds the active
   *  session. That is why the write is `setFolded(id, folded)` and not a bare
   *  toggle: from an absent entry a flip has no current value to invert. */
  readonly sidebarFolds: Readonly<Record<string, boolean>>;
  /** The chat dock is open (its slot is always mounted; this toggles its visible width). */
  readonly chatOpen: boolean;
  /** Monotonic signal for moving keyboard focus into the always-mounted chat composer. */
  readonly chatComposerFocusRevision: number;
  /** The chat dock width in px. */
  readonly chatWidth: number;
  /** The ⌘P/⌘K command menu is open. */
  readonly commandMenuOpen: boolean;
  /** Which view the open menu defaults to — set by the chord/affordance that opened it. */
  readonly commandMenuMode: CommandMenuMode;
  /** The stack of open dialog ids (top = frontmost); empty ⇒ no dialog. */
  readonly openDialogs: readonly string[];
  /**
   * A `ProjectSource` the NEXT Add Project open should preselect — the one `ui` hop
   * behind Add Environment's "Browse Its Projects" (C12 §10.3). Set with the dialog,
   * consumed (and cleared) by the Add Project body. Absent ⇒ Add Project opens on Local.
   */
  readonly pendingAddProjectSource?: string;
  /**
   * Projects with a `project.process` run the client kicked off still in flight — the
   * sidebar row's "indexing" spinner (C12 §10.6). NOT derivable from the projection
   * cache: it is genuine client-initiated ephemeral state (like `openDialogs`), set by
   * the indexing view on start and cleared when the run resolves, so leaving the view
   * never cancels it (the spinner tracks the real run, not the mounted screen).
   */
  readonly processingProjectIds: readonly string[];
  /**
   * Background narration per project — the proactive rehydration pass and the
   * knowledge swarm that rides it. Ephemeral client state for the same reason
   * `processingProjectIds` is: it tracks the real background RUN, not the
   * mounted screen. It lives here because the run outlives the screen — a swarm
   * that failed while the reader was elsewhere used to be gone by the time they
   * looked, which made "we narrate failures" true only for whoever was watching.
   * Capped at `BACKGROUND_EVENT_LIMIT` per project, oldest dropped first.
   */
  readonly backgroundEvents: Readonly<Record<string, readonly ProjectProcessEvent[]>>;
}

/** Retained background lines per project. A long swarm narrates one line per partition. */
export const BACKGROUND_EVENT_LIMIT = 500;

export interface UiSlice {
  readonly ui: UiState;
  readonly uiActions: {
    setSidebarOpen(open: boolean): void;
    toggleSidebar(): void;
    setFolded(nodeId: string, folded: boolean): void;
    setChatOpen(open: boolean): void;
    /** Open the dock and move keyboard focus to its composer. */
    focusChatComposer(): void;
    setChatWidth(width: number): void;
    /** Open/close the command menu; opening without a mode defaults to `"search"`. */
    setCommandMenuOpen(open: boolean, mode?: CommandMenuMode): void;
    setCommandMenuMode(mode: CommandMenuMode): void;
    openDialog(id: string): void;
    closeDialog(id: string): void;
    /** Open Add Project preselected to `source` (Add Environment → Browse Its Projects). */
    openAddProjectForSource(source: string): void;
    /** Clear the pending preselection once the Add Project body has consumed it. */
    clearAddProjectSource(): void;
    /** Mark (or unmark) a project as processing — drives the sidebar indexing spinner. */
    setProjectProcessing(projectId: string, processing: boolean): void;
    /** Retain one background narration line for `projectId`. */
    appendBackgroundEvent(projectId: string, event: ProjectProcessEvent): void;
  };
}

const initialUi: UiState = {
  sidebarOpen: true,
  sidebarFolds: {},
  chatOpen: false,
  chatComposerFocusRevision: 0,
  // 420 — the INVENTORY §1 double-click reset, made the default too (proposal
  // reconciliation 8: C01's interim 360 corrected here, one number, inventory wins).
  chatWidth: 420,
  commandMenuOpen: false,
  commandMenuMode: "search",
  openDialogs: [],
  processingProjectIds: [],
  backgroundEvents: {},
};

export const createUiSlice: StateCreator<RennetState, [], [], UiSlice> = (set) => ({
  ui: initialUi,
  uiActions: {
    setSidebarOpen: (open) => set((s) => ({ ui: { ...s.ui, sidebarOpen: open } })),
    toggleSidebar: () => set((s) => ({ ui: { ...s.ui, sidebarOpen: !s.ui.sidebarOpen } })),
    setFolded: (nodeId, folded) =>
      set((s) => ({
        ui: {
          ...s.ui,
          sidebarFolds: { ...s.ui.sidebarFolds, [nodeId]: folded },
        },
      })),
    setChatOpen: (open) => set((s) => ({ ui: { ...s.ui, chatOpen: open } })),
    focusChatComposer: () =>
      set((s) => ({
        ui: {
          ...s.ui,
          chatOpen: true,
          chatComposerFocusRevision: s.ui.chatComposerFocusRevision + 1,
        },
      })),
    setChatWidth: (width) => set((s) => ({ ui: { ...s.ui, chatWidth: width } })),
    // Opening without a mode defaults to "search" (the sidebar Search row's behaviour,
    // reconciliation 1); ⌘P passes "search", ⌘K passes "command". A close leaves the
    // mode reset to "search" for the next open — the flag that matters is `open`.
    setCommandMenuOpen: (open, mode = "search") =>
      set((s) => ({ ui: { ...s.ui, commandMenuOpen: open, commandMenuMode: mode } })),
    setCommandMenuMode: (mode) => set((s) => ({ ui: { ...s.ui, commandMenuMode: mode } })),
    openDialog: (id) =>
      set((s) => ({
        ui: { ...s.ui, openDialogs: [...s.ui.openDialogs.filter((d) => d !== id), id] },
      })),
    closeDialog: (id) =>
      set((s) => ({ ui: { ...s.ui, openDialogs: s.ui.openDialogs.filter((d) => d !== id) } })),
    openAddProjectForSource: (source) =>
      set((s) => ({
        ui: {
          ...s.ui,
          pendingAddProjectSource: source,
          openDialogs: [...s.ui.openDialogs.filter((d) => d !== "add-project"), "add-project"],
        },
      })),
    clearAddProjectSource: () =>
      set((s) => ({ ui: { ...s.ui, pendingAddProjectSource: undefined } })),
    setProjectProcessing: (projectId, processing) =>
      set((s) => {
        const has = s.ui.processingProjectIds.includes(projectId);
        if (processing === has) return s; // idempotent — no spurious re-render.
        const next = processing
          ? [...s.ui.processingProjectIds, projectId]
          : s.ui.processingProjectIds.filter((id) => id !== projectId);
        return { ui: { ...s.ui, processingProjectIds: next } };
      }),
    appendBackgroundEvent: (projectId, event) =>
      set((s) => {
        // `repo-start` IS the run boundary on this channel: a new background pass
        // supersedes the last rather than piling under it. Without this the
        // timeline grows across passes with no mark saying where one ended, which
        // is its own small dishonesty — the reader cannot tell which run failed.
        const prior = event.kind === "repo-start" ? [] : (s.ui.backgroundEvents[projectId] ?? []);
        const next = [...prior, event].slice(-BACKGROUND_EVENT_LIMIT);
        return {
          ui: { ...s.ui, backgroundEvents: { ...s.ui.backgroundEvents, [projectId]: next } },
        };
      }),
  },
});

// ── Selectors (beside the slice) ─────────────────────────────────────────────
/** True when dialog `id` is open. */
export const selectDialogOpen = (id: string) => (s: RennetState) => s.ui.openDialogs.includes(id);
/** The frontmost open dialog id, or null. DERIVED — never stored as its own field. */
export const selectTopDialog = (s: RennetState): string | null => s.ui.openDialogs.at(-1) ?? null;
/** One project's retained background narration (empty when nothing has run). */
export const selectBackgroundEvents =
  (projectId: string) =>
  (s: RennetState): readonly ProjectProcessEvent[] =>
    s.ui.backgroundEvents[projectId] ?? EMPTY_EVENTS;
const EMPTY_EVENTS: readonly ProjectProcessEvent[] = [];

/** The projects currently processing (sidebar indexing spinner). */
export const selectProcessingProjectIds = (s: RennetState): readonly string[] =>
  s.ui.processingProjectIds;
