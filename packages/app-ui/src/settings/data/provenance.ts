import type { SettingsLayer } from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// The provenance KEEP contract (C10 §2, reconciliation 8). The spike's
// `settings-data.ts` fixture DIES, but its `{ value, layer }` shape is a product
// feature (B10 serves it): every layered value the settings surface reads carries
// the ladder rung it resolved from, so a write knows which rung it lands on and a
// Reset knows there is a rung to fall back to.
//
// The rung is not BADGED on the project surfaces — Repository and Issue Tracker
// render the controls and their values, not a layer chip (the Appearance page's
// `ProvenanceChip` reads the live resolver's own `ResolvedProvenance` directly).
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
