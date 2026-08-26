/**
 * Tiny event bus between the review store and the exit FAB (R50): staging an
 * ask, leaving a comment, or an orchestrator update signals the FAB, which
 * flies a colored bubble from the acting element and bumps a register pip.
 * Plain module (no React) so the zustand store can emit without wiring every
 * call site — the acting element is recovered from document.activeElement.
 */
export type PipRegister = "change" | "comment" | "model"

type Listener = (register: PipRegister, source: HTMLElement | null, delta: number) => void

const listeners = new Set<Listener>()

export function onFabSignal(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function signalFab(register: PipRegister, delta = 1): void {
  const active =
    delta > 0 && typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  for (const listener of listeners) listener(register, active, delta)
}
