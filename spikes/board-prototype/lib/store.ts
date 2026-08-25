import { create } from "zustand"
import { buildInitialHosts, type HostItem } from "@/lib/sidebar-data"
import { DEFAULT_CHAT_WIDTH } from "@/components/resize-handle"
import type { TargetState } from "@/components/target-badge"
import type { TargetKind } from "@/lib/target-language"
import type { Ask, CodeComments, QuoteComment, RetiredBlock } from "@/components/code-comments"

/**
 * The one prototype store. Slices are spread inline in a single create() call
 * (ui / sidebar / run). No persist middleware — this is throwaway demo state.
 * Active-session highlight is NOT stored: it's derived from the route in Shell.
 */

/** Descriptor for a minted (new-chat) session rendered by SessionView. */
export interface SessionViewState {
  id: string
  projectName: string
  targetLabel: string
  targetKind: "pr" | "branch"
  badge: { kind: TargetKind; state?: TargetState }
  initialMessage?: string
}

let counter = 0
const mintId = (prefix: string) => `${prefix}-${++counter}`

interface AppState {
  // ── ui slice ──────────────────────────────────────────────────────────
  sidebarOpen: boolean
  chatOpen: boolean
  chatWidth: number
  addProjectOpen: boolean
  addProjectHostId?: string
  addRemoteOpen: boolean
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  setChatOpen: (open: boolean) => void
  setChatWidth: (width: number) => void
  openAddProject: (hostId?: string) => void
  setAddProjectOpen: (open: boolean) => void
  setAddRemoteOpen: (open: boolean) => void

  // ── sidebar slice ─────────────────────────────────────────────────────
  hosts: HostItem[]
  addProject: (hostId: string, name: string) => string
  addRemote: (label: string) => string
  renameProject: (id: string, name: string) => void
  setProjectIcon: (id: string, icon: string) => void
  removeProject: (id: string) => void
  renameSession: (id: string, name: string) => void
  togglePinSession: (id: string) => void
  toggleArchiveSession: (id: string) => void
  mintSession: (projectId: string, title: string) => string
  stampSession: (id: string, subtitle: string) => void

  // ── run slice ─────────────────────────────────────────────────────────
  greetingOpen: boolean
  setGreetingOpen: (open: boolean) => void
  sessionTurns: string[]
  boardsReady: boolean
  appendSessionTurn: (turn: string) => void
  setBoardsReady: (ready: boolean) => void
  /** Carrier for the active minted session's SessionView props (see mint flow). */
  sessionView: SessionViewState | null
  startSessionView: (view: SessionViewState) => void

  // ── review slice ──────────────────────────────────────────────────────
  // Per-line code comments, quote threads, staged asks, and the retired
  // ledger — one app-wide store (was CodeCommentsProvider in wave 1).
  comments: CodeComments
  quoteComments: QuoteComment[]
  setComment: (path: string, line: number, text: string | null) => void
  addQuoteComment: (quote: string, text: string) => string
  addQuoteReply: (id: string, author: "user" | "orchestrator", text: string) => void
  removeQuoteComment: (id: string) => void
  focusedThreadId: string | null
  focusThread: (id: string | null) => void
  asks: Ask[]
  stageAsk: (text: string, intent: Ask["intent"], source: string, codeAnchor?: Ask["codeAnchor"]) => string
  unstageAsk: (id: string) => void
  retired: RetiredBlock[]
  retireBlock: (text: string, reason: string) => void
  restoreRetired: (id: string) => void
  clear: () => void
}

let quoteSeq = 0
let askSeq = 0

/** Map every host's sessions through a transform (the old hand-rolled pattern). */
function mapSessions(
  hosts: HostItem[],
  fn: (s: HostItem["projects"][number]["sessions"][number]) => HostItem["projects"][number]["sessions"][number],
): HostItem[] {
  return hosts.map((h) => ({
    ...h,
    projects: h.projects.map((p) => ({ ...p, sessions: p.sessions.map(fn) })),
  }))
}

export const useAppStore = create<AppState>((set, get) => ({
  // ── ui slice ──
  sidebarOpen: true,
  chatOpen: true,
  chatWidth: DEFAULT_CHAT_WIDTH,
  addProjectOpen: false,
  addProjectHostId: undefined,
  addRemoteOpen: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setChatOpen: (open) => set({ chatOpen: open }),
  setChatWidth: (width) => set({ chatWidth: width }),
  openAddProject: (hostId) => set({ addProjectOpen: true, addProjectHostId: hostId }),
  setAddProjectOpen: (open) => set({ addProjectOpen: open }),
  setAddRemoteOpen: (open) => set({ addRemoteOpen: open }),

  // ── sidebar slice ──
  hosts: buildInitialHosts(),
  addProject: (hostId, name) => {
    const projectId = mintId("added")
    set((s) => ({
      hosts: s.hosts.map((h) =>
        h.id === hostId
          ? { ...h, projects: [...h.projects, { id: projectId, name, repo: name, sessions: [], indexing: true }] }
          : h,
      ),
    }))
    // Processing settles after a few seconds; the sidebar row carries the state.
    setTimeout(() => {
      set((s) => ({
        hosts: s.hosts.map((h) =>
          h.id === hostId
            ? { ...h, projects: h.projects.map((p) => (p.id === projectId ? { ...p, indexing: false } : p)) }
            : h,
        ),
      }))
    }, 10500)
    return projectId
  },
  addRemote: (label) => {
    const hostId = mintId("remote")
    set((s) => ({ hosts: [...s.hosts, { id: hostId, label, kind: "remote", projects: [] }] }))
    return hostId
  },
  renameProject: (id, name) =>
    set((s) => ({
      hosts: s.hosts.map((h) => ({
        ...h,
        projects: h.projects.map((p) => (p.id === id ? { ...p, name } : p)),
      })),
    })),
  setProjectIcon: (id, icon) =>
    set((s) => ({
      hosts: s.hosts.map((h) => ({
        ...h,
        projects: h.projects.map((p) => (p.id === id ? { ...p, icon: icon as never } : p)),
      })),
    })),
  removeProject: (id) =>
    set((s) => ({
      hosts: s.hosts.map((h) => ({ ...h, projects: h.projects.filter((p) => p.id !== id) })),
    })),
  renameSession: (id, name) => set((s) => ({ hosts: mapSessions(s.hosts, (x) => (x.id === id ? { ...x, title: name } : x)) })),
  togglePinSession: (id) =>
    set((s) => ({ hosts: mapSessions(s.hosts, (x) => (x.id === id ? { ...x, pinned: !x.pinned } : x)) })),
  toggleArchiveSession: (id) =>
    set((s) => ({ hosts: mapSessions(s.hosts, (x) => (x.id === id ? { ...x, archived: !x.archived } : x)) })),
  mintSession: (projectId, title) => {
    const id = mintId("sess")
    set((s) => ({
      hosts: s.hosts.map((h) => ({
        ...h,
        projects: h.projects.map((p) =>
          p.id === projectId
            ? { ...p, sessions: [...p.sessions, { id, title, time: "now", target: "your-branch" }] }
            : p,
        ),
      })),
    }))
    return id
  },
  stampSession: (id, subtitle) =>
    set((s) => ({ hosts: mapSessions(s.hosts, (x) => (x.id === id ? { ...x, time: subtitle } : x)) })),

  // ── run slice ──
  greetingOpen: true,
  setGreetingOpen: (open) => set({ greetingOpen: open }),
  sessionTurns: [],
  boardsReady: false,
  appendSessionTurn: (turn) => set((s) => ({ sessionTurns: [...s.sessionTurns, turn] })),
  setBoardsReady: (ready) => set({ boardsReady: ready }),
  sessionView: null,
  startSessionView: (view) =>
    set({ sessionView: view, sessionTurns: view.initialMessage ? [view.initialMessage] : [], boardsReady: false }),

  // ── review slice ──
  comments: {},
  quoteComments: [],
  setComment: (path, line, text) =>
    set((s) => {
      const next = { ...s.comments }
      const lineMap = { ...(next[path] ?? {}) }
      if (text === null) {
        delete lineMap[line]
      } else {
        lineMap[line] = text
      }
      if (Object.keys(lineMap).length > 0) {
        next[path] = lineMap
      } else {
        delete next[path]
      }
      return { comments: next }
    }),
  addQuoteComment: (quote, text) => {
    const id = `quote-${quoteSeq++}`
    set((s) => ({ quoteComments: [...s.quoteComments, { id, quote, messages: [{ author: "user", text }] }] }))
    return id
  },
  addQuoteReply: (id, author, text) =>
    set((s) => ({
      quoteComments: s.quoteComments.map((entry) =>
        entry.id === id ? { ...entry, messages: [...entry.messages, { author, text }] } : entry,
      ),
    })),
  removeQuoteComment: (id) => set((s) => ({ quoteComments: s.quoteComments.filter((entry) => entry.id !== id) })),
  focusedThreadId: null,
  focusThread: (id) => set({ focusedThreadId: id }),
  asks: [],
  stageAsk: (text, intent, source, codeAnchor) => {
    const id = `ask-${askSeq++}`
    set((s) => ({ asks: [...s.asks, { id, text, intent, source, codeAnchor }] }))
    return id
  },
  unstageAsk: (id) => set((s) => ({ asks: s.asks.filter((ask) => ask.id !== id) })),
  retired: [],
  retireBlock: (text, reason) =>
    set((s) => ({ retired: [...s.retired, { id: `retired-${s.retired.length}`, text, reason }] })),
  restoreRetired: (id) => set((s) => ({ retired: s.retired.filter((entry) => entry.id !== id) })),
  clear: () => set({ comments: {}, quoteComments: [], focusedThreadId: null }),
}))
