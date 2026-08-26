/**
 * Tiny event bus between the review store and the exit FAB (R50): staging an
 * ask, leaving a comment, or an orchestrator update signals the FAB, which
 * flies a colored bubble from the acting element and bumps a register pip.
 * Plain module (no React) so the zustand store can emit without wiring every
 * call site — the acting element is recovered from document.activeElement.
 *
 * One gesture = one pip: a composite action (a highlight request-change is a
 * quote comment + a canned reply + the ask) emits several store events in one
 * tick, so signals batch in a short window and collapse to the dominant
 * register (change > comment > model). Genuinely later events — an
 * orchestrator reply arriving seconds on — fall outside the window and pip
 * on their own.
 */
export type PipRegister = "change" | "comment" | "model"

type Listener = (register: PipRegister, source: HTMLElement | null, delta: number) => void

const listeners = new Set<Listener>()

export function onFabSignal(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const DOMINANCE: PipRegister[] = ["change", "comment", "model"]
const GESTURE_WINDOW_MS = 80

let pending: { register: PipRegister; delta: number; source: HTMLElement | null }[] = []
let timer: ReturnType<typeof setTimeout> | null = null

function emit(register: PipRegister, source: HTMLElement | null, delta: number) {
  for (const listener of listeners) listener(register, source, delta)
}

function flush() {
  timer = null
  const batch = pending
  pending = []
  for (const entry of batch.filter((b) => b.delta < 0)) emit(entry.register, null, entry.delta)
  const positives = batch.filter((b) => b.delta > 0)
  if (positives.length > 0) {
    const dominant = DOMINANCE.find((r) => positives.some((p) => p.register === r)) as PipRegister
    const source = positives.find((p) => p.source)?.source ?? null
    emit(dominant, source, 1)
  }
}

let muted = false

/** Programmatic staging (scenario seeding) is not a gesture — no flights, no pops. */
export function muteFabSignals<T>(fn: () => T): T {
  muted = true
  try {
    return fn()
  } finally {
    muted = false
  }
}

export function signalFab(register: PipRegister, delta = 1): void {
  if (muted) return
  const source =
    delta > 0 && typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  pending.push({ register, delta, source })
  if (!timer) timer = setTimeout(flush, GESTURE_WINDOW_MS)
}
