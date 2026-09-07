import { create } from "zustand";
import type { LensBoardEntry } from "./board-data";
import type { LensSeatState } from "./lens-seats";

export function lensActivityKey(reviewId: string, generation: string, seat: LensSeatState): string {
  return JSON.stringify([
    reviewId,
    generation,
    seat.lens,
    seat.voices.map((voice) => [voice.seat, voice.thread?.environmentId, voice.thread?.threadId]),
  ]);
}

export function lensActivityAction(seat: LensSeatState): string {
  return seat.voices
    .map((voice) => (voice.latest?.kind === "tool" ? "Inspecting the change" : voice.speech.text))
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
