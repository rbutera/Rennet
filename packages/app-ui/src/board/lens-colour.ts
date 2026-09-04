import type { LensKind } from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Which lens takes which hue slot.
//
// `packages/theme` owns five PORTABLE slots — `--rn-lens-red|yellow|blue|green|
// neutral` — and every theme pack binds them from its own palette, so the register
// survives a theme change without anyone re-picking colours. It knows nothing about
// lenses. This file is the other half: the product's mapping from a lens to a slot,
// in one place, so the rail and the bench cannot disagree about what Design's colour
// is.
//
//   Flagged  red      — the register that stops you
//   Decisions yellow  — gold in the default theme, because gold IS Rennet's decision
//                       register (root DESIGN.md); each pack uses its own yellow
//   Design   blue     — the one hue the Affineur's Bench did not already carry
//   Sequence green    — order, read forward
//   Noise    neutral  — the lens that asks for less attention gets the quiet slot
//
// A lens BINDS its slot to `--rn-lens` on its own subtree, and everything inside
// reads `lens` / `lens-soft` / `lens-line` without knowing which lens it is in
// (theme.css declares those `@theme inline`, so the nearest binding wins). That is
// why this is a class per lens and not a colour per element: a mark component stays
// lens-agnostic, and adding a lens is one row here.
//
// The hue is a MARK — a core sample, a stop, a socket — and NEVER type. The palette
// holds the lens slots to WCAG's 3:1 non-text bar (theme.test.ts computes it per pack
// per scheme), which is the right bar for a rule and the wrong one for a sentence, so
// a lens label or a lane's speech set in the lens hue would be a legibility claim
// nothing checks. `text-lens` appears at exactly two call sites, both to drive
// `currentColor` on an SVG mark, and `lens-colour.dom.test.tsx` asserts the label and
// the speech line stay on the ink ramp.
// ─────────────────────────────────────────────────────────────────────────────

/** The palette slot each lens draws from — the readable half of the mapping. */
export const LENS_SLOT: Readonly<Record<LensKind, string>> = {
  design: "blue",
  sequence: "green",
  decisions: "yellow",
  flagged: "red",
  noise: "neutral",
};

/**
 * The class that binds a lens's slot to `--rn-lens` for its whole subtree. Written
 * as five literal strings because Tailwind reads source text: a template built from
 * `LENS_SLOT` would generate no CSS at all.
 */
export const LENS_TINT: Readonly<Record<LensKind, string>> = {
  design: "[--rn-lens:var(--rn-lens-blue)]",
  sequence: "[--rn-lens:var(--rn-lens-green)]",
  decisions: "[--rn-lens:var(--rn-lens-yellow)]",
  flagged: "[--rn-lens:var(--rn-lens-red)]",
  noise: "[--rn-lens:var(--rn-lens-neutral)]",
};

/** A lane id off the wire is a string, not a `LensKind`. An id this client has never
 *  heard of gets the quiet slot rather than an unbound subtree. */
export function lensTint(id: string): string {
  return LENS_TINT[id as LensKind] ?? LENS_TINT.noise;
}

/** The slot name for an id — what the DOM stamps, and what the tests read. */
export function lensSlot(id: string): string {
  return LENS_SLOT[id as LensKind] ?? LENS_SLOT.noise;
}
