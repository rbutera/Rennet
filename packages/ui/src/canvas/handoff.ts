import type { ComposedHandoffBundle, DispositionType, HandoffDisposition } from "@rennet/types";
import { type CollationDraft, type CollationItem, effectiveBody } from "./collation";

// ─────────────────────────────────────────────────────────────────────────────
// Handoff-bundle composition, the renderer's pure half (issue #72). The composed
// bundle is renderer-HELD derived state (design D1): computed from the staged set,
// keyed to a signature of it, and discarded the moment that set changes. This module
// holds the pure functions app.tsx binds to — the addressed-disposition projection,
// the staleness signature, the "is this composition still current" test, and the
// run-input seam (D2/task 3.5) that passes a HELD, CURRENT composition to a handoff
// run and NEVER a stale one.
//
// The `layer:ui` boundary allows only `@rennet/types` + this package: nothing here
// imports `@rennet/core`, so `HANDOFF_ADDRESSED_TYPES` is mirrored (not imported).
// The core `buildHandoffBundle` re-derives the SAME set server-side and is the
// authority the run verifies against; this projection only needs to change iff the
// staged payload does.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The disposition types a coding-agent handoff addresses — the request-change /
 * comment items that ask for a code change. Mirrors core `HANDOFF_ADDRESSED_TYPES`
 * (the UI layer cannot import core); the server filters to the same set when it
 * rebuilds the mechanical bundle, so the projection here matches what the run keys on.
 */
export const HANDOFF_ADDRESSED_TYPES: readonly DispositionType[] = ["request-change", "comment"];

/** Whether a disposition type is addressed by the handoff (kept in sync with core). */
export function isAddressedByHandoff(type: DispositionType): boolean {
  return HANDOFF_ADDRESSED_TYPES.includes(type);
}

/**
 * The addressed dispositions to hand off, in effective (refined-if-kept, else raw)
 * body form — exactly the shape `review.handoff.compose` / `.run` take. Own-branch
 * handoff hands the reviewer's own coding agent every addressed disposition; there is
 * no ink/blue publish split here (that split is the other-pr posting concern).
 */
export function handoffDispositions(draft: CollationDraft): HandoffDisposition[] {
  return draft.filter((item) => isAddressedByHandoff(item.type)).map(toHandoffDisposition);
}

function toHandoffDisposition(item: CollationItem): HandoffDisposition {
  return {
    path: item.path,
    type: item.type,
    body: effectiveBody(item),
    ...(item.span === undefined ? {} : { span: item.span }),
    ...(item.side === undefined ? {} : { side: item.side }),
  };
}

/**
 * A stable signature of the staged handoff set — the renderer's staleness key
 * (design D1). It changes IFF the staged payload the server would rebuild the
 * mechanical bundle from changes: the active patchset plus every addressed
 * disposition's path/type/effective-body/anchor. It uses the same stable ordering as
 * core: path/span/type are canonical, while otherwise-tied notes preserve draft order.
 * A reorder only invalidates when it changes the mechanical bundle's order; any reword
 * / retype / withdraw / stage change that alters the payload also invalidates.
 */
export function handoffStagedSignature(draft: CollationDraft, patchsetId: string): string {
  const dispositions = handoffDispositions(draft)
    .map((disposition) => ({
      path: disposition.path,
      type: disposition.type,
      body: disposition.body,
      span: disposition.span ?? null,
      side: disposition.side ?? null,
    }))
    .sort((left, right) => {
      if (left.path !== right.path) return left.path < right.path ? -1 : 1;
      const leftStart = left.span?.startLine ?? 0;
      const rightStart = right.span?.startLine ?? 0;
      if (leftStart !== rightStart) return leftStart - rightStart;
      if (left.type !== right.type) return left.type < right.type ? -1 : 1;
      return 0;
    });
  return JSON.stringify({ patchsetId, dispositions });
}

/** A held composition, tagged with the staged signature it was computed from. */
export interface HeldComposition {
  readonly signature: string;
  readonly bundle: ComposedHandoffBundle;
}

/**
 * The held composition IFF it is still current for the given staged signature. A
 * composition computed from a since-changed staged set is not returned — the UI
 * shows the draft as un-composed rather than presenting a stale narrative, and the
 * run seam below never passes it (design D1).
 */
export function currentComposition(
  held: HeldComposition | undefined,
  signature: string,
): ComposedHandoffBundle | undefined {
  return held !== undefined && held.signature === signature ? held.bundle : undefined;
}

/**
 * The `composed` field to pass to `review.handoff.run` (design D2, task 3.5): the
 * held composition ONLY when it is current for the staged set the run addresses, and
 * `undefined` when there is none or it is stale. A stale held composition is never
 * passed — the run would refuse it anyway (the server re-verifies), but not passing it
 * keeps today's mechanical behaviour byte-identical rather than provoking a refusal.
 */
export function runComposition(
  held: HeldComposition | undefined,
  signature: string,
): ComposedHandoffBundle | undefined {
  return currentComposition(held, signature);
}
