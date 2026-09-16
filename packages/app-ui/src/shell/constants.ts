// Consumer-owned frame constants (C03, proposal reconciliation 3 of C02: the kit
// `ResizeHandle` carries no widths — the app that mounts it owns them). The chat
// dock and the main surface each keep a minimum; the chat's maximum is whatever the
// container leaves once the surface holds its minimum (measured in the frame, no
// arbitrary cap). Double-clicking the divider resets the chat to DEFAULT_CHAT_WIDTH
// (INVENTORY §1: 420 — reconciliation 8 corrects C01's 360 to match).

export const MIN_CHAT_WIDTH = 320;
// The surface never shrinks below the top bar it must hold. This is the width of the
// COLLAPSED (icon-only) bar — the five-lens rail with labels folded, the two pills folded
// to glyphs, the left slot and the paddings — so the bar always renders on ONE row and its
// controls are never clipped. Below this the chat-drag maximum clamps (layout.tsx), keeping
// the divider from squeezing the board under the bar. It is NOT a labelled-bar floor: labels
// come back progressively above it (the lens rail's chat-aware fold, `lens-switcher.tsx`;
// the pills' fold, `top-bar.tsx`). Measured from those elements' own widths; tune against
// the running app if a control clips at the floor.
export const MIN_SURFACE_WIDTH = 520;
export const DEFAULT_CHAT_WIDTH = 420;

/** The bare canvas between the chat's right hairline and the main surface — the dock's
 *  wrapper is `chatWidth + 4` and pads these 4px off, so the chat itself renders at
 *  `chatWidth` (the prototype's `chatWidth + 4` wrapper over a `chatWidth` column,
 *  `spikes/board-prototype/components/shell.tsx` + `components/chat-column.tsx`). The
 *  divider is not what needs them: it is 6px wide on -3px margins, a net-zero footprint. */
export const DOCK_DIVIDER_GUTTER = 4;

/** How long after the LAST divider width change before the dock's width transition
 *  re-arms (INVENTORY §1) — a trailing debounce, exactly as the prototype writes it. */
export const DOCK_TRANSITION_REARM_MS = 200;

/** The expanded sidebar's width. Collapsed is 0 — C20 deleted the 48px icon rail,
 *  so there is no second width to name. The frame reads this to compute the chat's
 *  measured maximum. */
export const SIDEBAR_PANEL_WIDTH = 256;
