import {
  advanceNoveltyLifecycle,
  type NoveltyAdvance,
  type NoveltyLifecycleState,
} from "@rennet/core";
import type { Patchset } from "@rennet/protocol";
import type { NoveltyLedgerFailure, NoveltyLedgerReader } from "./novelty-ledger-reader";

export type NoveltyLifecycleAdvanceResult =
  | { readonly ok: true; readonly advance: NoveltyAdvance }
  | { readonly ok: false; readonly failure: NoveltyLedgerFailure };

/** Reclassify an in-flight review after its effective baseline advances. */
export class NoveltyLifecycleReader {
  constructor(private readonly reader: NoveltyLedgerReader) {}

  advance(
    repoKey: string,
    patchset: Patchset,
    state: NoveltyLifecycleState,
  ): NoveltyLifecycleAdvanceResult {
    const classified = this.reader.classify(repoKey, patchset);
    if (!classified.ok) return classified;
    return { ok: true, advance: advanceNoveltyLifecycle(state, classified.ledger) };
  }
}
