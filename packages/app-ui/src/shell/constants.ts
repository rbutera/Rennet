// Consumer-owned frame constants (C03, proposal reconciliation 3 of C02: the kit
// `ResizeHandle` carries no widths — the app that mounts it owns them). The chat
// dock and the main surface each keep a minimum; the chat's maximum is whatever the
// container leaves once the surface holds its minimum (measured in the frame, no
// arbitrary cap). Double-clicking the divider resets the chat to DEFAULT_CHAT_WIDTH
// (INVENTORY §1: 420 — reconciliation 8 corrects C01's 360 to match).

export const MIN_CHAT_WIDTH = 320;
export const MIN_SURFACE_WIDTH = 400;
export const DEFAULT_CHAT_WIDTH = 420;

/** The expanded sidebar's width. Collapsed is 0 — C20 deleted the 48px icon rail,
 *  so there is no second width to name. The frame reads this to compute the chat's
 *  measured maximum. */
export const SIDEBAR_PANEL_WIDTH = 256;
