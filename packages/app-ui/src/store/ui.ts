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

export interface UiState {
  /** The sidebar region is open (the layout renders it; the tree inside is a projection). */
  readonly sidebarOpen: boolean;
  /** Per-node collapse state, keyed by node id. Absent ⇒ the node's default (expanded). */
  readonly sidebarFolds: Readonly<Record<string, boolean>>;
  /** The chat dock is open (its slot is always mounted; this toggles its visible width). */
  readonly chatOpen: boolean;
  /** The chat dock width in px. */
  readonly chatWidth: number;
  /** The ⌘K command menu is open. */
  readonly commandMenuOpen: boolean;
  /** The stack of open dialog ids (top = frontmost); empty ⇒ no dialog. */
  readonly openDialogs: readonly string[];
  /**
   * A `ProjectSource` the NEXT Add Project open should preselect — the one `ui` hop
   * behind Add Environment's "Browse Its Projects" (C12 §10.3). Set with the dialog,
   * consumed (and cleared) by the Add Project body. Absent ⇒ Add Project opens on Local.
   */
  readonly pendingAddProjectSource?: string;
}

export interface UiSlice {
  readonly ui: UiState;
  readonly uiActions: {
    setSidebarOpen(open: boolean): void;
    toggleSidebar(): void;
    toggleFold(nodeId: string): void;
    setChatOpen(open: boolean): void;
    setChatWidth(width: number): void;
    setCommandMenuOpen(open: boolean): void;
    openDialog(id: string): void;
    closeDialog(id: string): void;
    /** Open Add Project preselected to `source` (Add Environment → Browse Its Projects). */
    openAddProjectForSource(source: string): void;
    /** Clear the pending preselection once the Add Project body has consumed it. */
    clearAddProjectSource(): void;
  };
}

const initialUi: UiState = {
  sidebarOpen: true,
  sidebarFolds: {},
  chatOpen: false,
  // 420 — the INVENTORY §1 double-click reset, made the default too (proposal
  // reconciliation 8: C01's interim 360 corrected here, one number, inventory wins).
  chatWidth: 420,
  commandMenuOpen: false,
  openDialogs: [],
};

export const createUiSlice: StateCreator<RennetState, [], [], UiSlice> = (set) => ({
  ui: initialUi,
  uiActions: {
    setSidebarOpen: (open) => set((s) => ({ ui: { ...s.ui, sidebarOpen: open } })),
    toggleSidebar: () => set((s) => ({ ui: { ...s.ui, sidebarOpen: !s.ui.sidebarOpen } })),
    toggleFold: (nodeId) =>
      set((s) => ({
        ui: {
          ...s.ui,
          sidebarFolds: { ...s.ui.sidebarFolds, [nodeId]: !s.ui.sidebarFolds[nodeId] },
        },
      })),
    setChatOpen: (open) => set((s) => ({ ui: { ...s.ui, chatOpen: open } })),
    setChatWidth: (width) => set((s) => ({ ui: { ...s.ui, chatWidth: width } })),
    setCommandMenuOpen: (open) => set((s) => ({ ui: { ...s.ui, commandMenuOpen: open } })),
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
  },
});

// ── Selectors (beside the slice) ─────────────────────────────────────────────
/** True when node `nodeId` is folded (collapsed). */
export const selectFolded = (nodeId: string) => (s: RennetState) =>
  s.ui.sidebarFolds[nodeId] === true;
/** True when dialog `id` is open. */
export const selectDialogOpen = (id: string) => (s: RennetState) => s.ui.openDialogs.includes(id);
/** The frontmost open dialog id, or null. DERIVED — never stored as its own field. */
export const selectTopDialog = (s: RennetState): string | null => s.ui.openDialogs.at(-1) ?? null;
