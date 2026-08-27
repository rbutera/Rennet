import type { ReactNode } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// The honest disclosure a Projects editor shows when no served WRITE store backs it
// yet (the live projection until B10, `projectEditsPersist === false`). It sits beside
// controls left visibly DISABLED — never a fully enabled control wired to a no-op
// setter that silently eats input. This is the same honesty the Environments cards
// already carry (`source-control.tsx`'s "Connect … to detect", `model-mappings.tsx`'s
// "once its Model Council is served"): one quiet line naming the gap, not a gate.
// ─────────────────────────────────────────────────────────────────────────────

/** One quiet line naming why a Projects editor is disabled (no write store yet). */
export function UnbackedNote({ children }: { readonly children: ReactNode }) {
  return (
    <p data-slot="unbacked-note" className="text-xs text-ink-soft">
      {children}
    </p>
  );
}
