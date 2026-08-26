"use client"

import * as React from "react"
import { create } from "zustand"

/**
 * The coach-mark system. One mark on screen at a time, ever — never a linear
 * N-of-M tour. Marks register themselves when their surface mounts; the store
 * picks the first unseen registered mark in system order and shows only that.
 * Dismissing one opens a short gap before the next on the same surface fires,
 * so a board reads lenses → highlight → FAB instead of all three at once.
 *
 * Marks anchor to chrome only (buttons, switchers, containers) — never to a
 * board content element, which is generated and moves.
 */

export type MarkId =
  | "new-chat"
  | "smart-list"
  | "lenses"
  | "highlight"
  | "fab"
  | "verdict"
  | "draft"
  | "dispatch"

export interface Mark {
  id: MarkId
  title: string
  body: string
  side?: "top" | "bottom" | "left" | "right" | "inline-start" | "inline-end"
  align?: "start" | "center" | "end"
  /** Park the card in the middle of the anchor — for full-region anchors. */
  centered?: boolean
}

/** System order. Chaining is this order: the first unseen registered mark wins. */
export const MARKS: Mark[] = [
  {
    id: "new-chat",
    title: "Start Here",
    body: "Pick a branch or pull request to review. Add Project brings in another repo.",
    side: "inline-end",
    align: "start",
  },
  {
    id: "smart-list",
    title: "One List",
    body: "Your branches and open pull requests, together. Rows marked Needs You are waiting on your review.",
    side: "top",
    align: "center",
  },
  {
    id: "lenses",
    title: "Five Lenses",
    body: "One change, read five ways. Design checks the spec, Sequence orders the read, Decisions and Flagged carry judgment and defects, Noise holds the mechanical.",
    side: "bottom",
    align: "center",
  },
  {
    id: "highlight",
    title: "Highlight to Act",
    body: "Highlight any sentence to comment, ask for an explanation, or request a change.",
    centered: true,
  },
  {
    id: "fab",
    title: "The Way Out",
    body: "Everything you stage lands here: the review you post, or the round you dispatch.",
    side: "top",
    align: "end",
  },
  {
    id: "verdict",
    title: "Verdict",
    body: "Proposed from your review. You decide what posts.",
    side: "bottom",
    align: "start",
  },
  {
    id: "draft",
    title: "The Living Draft",
    body: "The draft reworks itself as you stage and steer. Highlight any of its text to revise or drop it.",
    side: "inline-start",
    align: "start",
  },
  {
    id: "dispatch",
    title: "Dispatch",
    body: "Asks become a work order. Dispatch runs them in a detached worktree and returns a fresh board.",
    side: "inline-end",
    align: "center",
  },
]

export const MARK_BY_ID = Object.fromEntries(MARKS.map((m) => [m.id, m])) as Record<MarkId, Mark>

const STORAGE_KEY = "rennet-tour-v1"
/** Gap between a dismissed mark and the next one on the same surface. */
const CHAIN_DELAY_MS = 600

type Flags = Partial<Record<MarkId, boolean>>

interface Persisted {
  seen: MarkId[]
  skipAll: boolean
}

const EMPTY: Persisted = { seen: [], skipAll: false }

/** Read once, at module load. `?tour=reset` wipes the record first. */
function readPersisted(): Persisted {
  if (typeof window === "undefined") return EMPTY
  try {
    if (new URLSearchParams(window.location.search).get("tour") === "reset") {
      window.localStorage.removeItem(STORAGE_KEY)
      return EMPTY
    }
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return { seen: parsed.seen ?? [], skipAll: parsed.skipAll === true }
  } catch {
    return EMPTY
  }
}

function pick(seen: Flags, registered: Flags, skipAll: boolean): MarkId | null {
  if (skipAll) return null
  return MARKS.find((m) => registered[m.id] && !seen[m.id])?.id ?? null
}

interface TourState {
  seen: Flags
  skipAll: boolean
  /** Marks whose surface is currently mounted. */
  registered: Flags
  active: MarkId | null
  register: (id: MarkId) => void
  unregister: (id: MarkId) => void
  /** Retire a mark for good — dismissed by ✕, or learned by using the anchor. */
  dismiss: (id: MarkId) => void
  skipEverything: () => void
  replay: () => void
}

/** Non-null while the post-dismiss gap is open; suppresses the next mark. */
let chainTimer: ReturnType<typeof setTimeout> | null = null

const initial = readPersisted()

export const useTourStore = create<TourState>((set, get) => ({
  seen: Object.fromEntries(initial.seen.map((id) => [id, true])) as Flags,
  skipAll: initial.skipAll,
  registered: {},
  active: null,
  register: (id) => {
    if (get().registered[id]) return
    const registered = { ...get().registered, [id]: true }
    set({ registered, active: chainTimer ? null : pick(get().seen, registered, get().skipAll) })
  },
  unregister: (id) => {
    if (!get().registered[id]) return
    const registered = { ...get().registered }
    delete registered[id]
    set({ registered, active: chainTimer ? null : pick(get().seen, registered, get().skipAll) })
  },
  dismiss: (id) => {
    if (get().seen[id]) return
    set({ seen: { ...get().seen, [id]: true }, active: null })
    if (chainTimer) clearTimeout(chainTimer)
    chainTimer = setTimeout(() => {
      chainTimer = null
      const s = get()
      set({ active: pick(s.seen, s.registered, s.skipAll) })
    }, CHAIN_DELAY_MS)
  },
  skipEverything: () => set({ skipAll: true, active: null }),
  replay: () => {
    if (chainTimer) {
      clearTimeout(chainTimer)
      chainTimer = null
    }
    set({ seen: {}, skipAll: false, active: pick({}, get().registered, false) })
  },
}))

useTourStore.subscribe((state, previous) => {
  if (state.seen === previous.seen && state.skipAll === previous.skipAll) return
  try {
    const payload: Persisted = {
      seen: Object.keys(state.seen).filter((id) => state.seen[id as MarkId]) as MarkId[],
      skipAll: state.skipAll,
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Private mode / quota — the tour degrades to per-session memory.
  }
})

/**
 * Register a mark's availability for as long as the caller is mounted, and
 * report whether the store elected it. The store owns "which one" — a caller
 * only says "my surface is here".
 */
export function useCoachmark(id: MarkId, enabled = true): boolean {
  const active = useTourStore((s) => s.active === id)
  React.useEffect(() => {
    if (!enabled) return
    const { register, unregister } = useTourStore.getState()
    register(id)
    return () => unregister(id)
  }, [id, enabled])
  return active
}
