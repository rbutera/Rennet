// Delta-digest count tiles (issue #382 M2, task 6.3). Derived CLIENT-SIDE from the projected
// review's `successorAccount` (the same facts the desktop digest counts), so the phone shows the
// new/resolved/carried breakdown without a new protocol shape. Pure — unit-tested against the
// account shape; the digest screen renders the tiles it returns.

/** A projected successor account (the subset the counts read). */
export interface SuccessorAccountLike {
  readonly asks: ReadonlyArray<{
    readonly status: "addressed" | "partially-addressed" | "untouched";
  }>;
  readonly beyondAsks: readonly string[];
  readonly beyondAskHunks?: readonly unknown[];
}

/** The four delta counts: asks addressed / partially / untouched, and work beyond the asks. */
export interface DeltaCounts {
  readonly addressed: number;
  readonly partially: number;
  readonly untouched: number;
  readonly beyond: number;
}

/**
 * Derive the delta counts from a review's successor account. Absent account ⇒ all zero (a first
 * capture carries no delta — the tiles then read an honest zero, never a fabricated number).
 * `beyond` prefers the hunk-grain `beyondAskHunks` when present (the finer count), else the
 * path-grain `beyondAsks`.
 */
export function deltaCounts(account: SuccessorAccountLike | undefined): DeltaCounts {
  if (!account) return { addressed: 0, partially: 0, untouched: 0, beyond: 0 };
  let addressed = 0;
  let partially = 0;
  let untouched = 0;
  for (const ask of account.asks) {
    if (ask.status === "addressed") addressed += 1;
    else if (ask.status === "partially-addressed") partially += 1;
    else untouched += 1;
  }
  const beyond = account.beyondAskHunks?.length ?? account.beyondAsks.length;
  return { addressed, partially, untouched, beyond };
}
