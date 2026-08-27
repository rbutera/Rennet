/**
 * `core/session/context-meter.ts` — the ask-don't-estimate context meter (B09
 * cluster 3, #466 res. 3 ripple). Reports ONLY what the harness stated about its
 * context window: the tokens it says are occupying the window, the window
 * capacity when it gave one, and a fraction-remaining ONLY when it gave both.
 *
 * The rule is honest surfacing, not a gate (CLAUDE.md): when the harness reported
 * no occupancy the meter is ABSENT (undefined) — not zero, not an estimate. A
 * turn that carried no context figure is not one at zero usage, and a "%
 * remaining" the harness never gave is a fabrication, so the meter refuses to
 * invent one from a single figure. Pure; no I/O, no model, no Node — the harness
 * event stream (a `compact_boundary`'s post_tokens, a completed outcome's
 * `contextWindowTokens`) supplies the reported figures; the reader renders what
 * this returns.
 */

export interface ContextMeter {
  /** Context tokens the harness reports currently occupying its window. */
  readonly usedTokens: number;
  /** The window capacity, when the harness reported it. Absent otherwise. */
  readonly windowTokens?: number;
  /**
   * Fraction of the window still free (0..1), ONLY when BOTH the occupancy and
   * the capacity are harness-reported. Absent otherwise — never estimated from
   * one figure alone.
   */
  readonly fractionRemaining?: number;
}

/**
 * Build the meter from the harness's reported figures. Absent (`undefined`) when
 * the harness reported no occupancy — the honest "unknown", never a zero. The
 * fraction is derived only when a positive capacity is also reported, and is
 * clamped to [0, 1] so a stale occupancy above capacity never reads as negative.
 */
export function contextMeter(reported: {
  readonly usedTokens?: number;
  readonly windowTokens?: number;
}): ContextMeter | undefined {
  const { usedTokens, windowTokens } = reported;
  if (usedTokens === undefined) return undefined;
  const fractionRemaining =
    windowTokens !== undefined && windowTokens > 0
      ? Math.max(0, Math.min(1, (windowTokens - usedTokens) / windowTokens))
      : undefined;
  return {
    usedTokens,
    ...(windowTokens === undefined ? {} : { windowTokens }),
    ...(fractionRemaining === undefined ? {} : { fractionRemaining }),
  };
}
