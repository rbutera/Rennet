import { create } from "zustand";
import type { LensBoardEntry } from "./board-data";
import type { LensSeatState } from "./lens-seats";

export function lensActivityKey(reviewId: string, generation: string, seat: LensSeatState): string {
  // Stable for the whole generation: reviewId + generation + lens, and nothing else. Keying
  // on the voices (their seat ids, their thread/environment ids) rotated the key MID-RUN —
  // a thread id arrives, or Flagged's compiler seat joins its two review legs — and every
  // rotation orphaned the accumulated history and reseeded a fresh record. That was the
  // "queued" wipe: the moment a late seat appeared, the whole feed became one "queued" line.
  return JSON.stringify([reviewId, generation, seat.lens]);
}

export function lensActivityAction(seat: LensSeatState): string {
  // A settled / absent / failed lens says "ready" through the evidence-green check on its
  // tab, never through a line in this feed — so no terminal word ("reworked", "carrying
  // forward", "drafted") is ever appended once the seat stops working (J).
  if (seat.register !== "working") return "";
  return seat.voices
    .map((voice) => {
      if (voice.latest?.kind === "tool") return "Inspecting the change";
      // Quiet speech is a promise or a lull, not work in progress: "queued", "under way",
      // "waiting on the other lenses", and the idle "quiet for N s" heartbeat. None of it is
      // an activity, so none of it accumulates in the feed (B — no more "quiet for N s" lines).
      if (voice.speech.quiet) return "";
      return voice.speech.text;
    })
    .filter(Boolean)
    .join(" · ");
}

export const useLensActivityHistory = create<{
  readonly byRun: Readonly<
    Record<string, { readonly observedAt: number; readonly history: readonly string[] }>
  >;
  observe(
    reviewId: string,
    generation: string,
    entries: readonly Pick<LensBoardEntry, "lens" | "seat">[],
  ): void;
}>((set) => ({
  byRun: {},
  observe: (reviewId, generation, entries) =>
    set((state) => {
      let next = state.byRun;
      for (const { seat } of entries) {
        if (!seat.seated) continue;
        const key = lensActivityKey(reviewId, generation, seat);
        const action = lensActivityAction(seat);
        const previous = next[key];
        if (previous && (!action || previous.history[0] === action)) continue;
        next = {
          ...next,
          [key]: {
            observedAt: previous?.observedAt ?? Date.now(),
            history: [
              ...(action ? [action] : []),
              ...(previous?.history.filter((text) => text !== action) ?? []),
            ].slice(0, 4),
          },
        };
      }
      return next === state.byRun ? state : { byRun: next };
    }),
}));
