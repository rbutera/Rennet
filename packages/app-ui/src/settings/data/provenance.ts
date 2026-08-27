import type { ResolvedProvenance, SettingsLayer } from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// The provenance KEEP contract (C10 §2, reconciliation 8). The spike's
// `settings-data.ts` fixture DIES, but its `{ value, layer }` shape is a product
// feature (B10 serves it): every layered value the settings surface reads carries
// the ladder rung it resolved from, and the shared `ProvenanceChip` names it.
//
// Two provenance shapes meet at this seam:
//   • The LIVE commands (`settings.get`, `setAppearance`, …) already return the
//     resolver's own `ResolvedProvenance` — the effective layer plus the full
//     lowest-first contribution list. Those flow straight to the chip.
//   • The B10-absent PROJECTIONS (environments, detection, mappings, glyphs,
//     worktree, tracker) carry a single `{ value, layer }` until the engine serves
//     their contribution ladders. `toProvenance` lifts one into the chip's shape as
//     a single effective contribution — never inventing lower-rung offers we have
//     not detected.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A resolved value tagged with the ladder rung it came from — the keep contract the
 * whole settings surface reads values in. Generic over the value so a projection can
 * carry a typed union (a `TrackerKind`, a `ProjectVisibility`) and stay type-safe.
 */
export interface Layered<T> {
  readonly value: T;
  readonly layer: SettingsLayer;
}

/**
 * Lift a single `{ value, layer }` into the `ResolvedProvenance` the shared
 * {@link ProvenanceChip} renders — one contribution, itself effective. A live value
 * already arrives as `ResolvedProvenance` and skips this; only the B10-absent
 * projections pass through here, and they have no lower-rung offer to show yet.
 */
export function toProvenance({ value, layer }: Layered<unknown>): ResolvedProvenance {
  return { layer, contributions: [{ layer, value: String(value), effective: true }] };
}
