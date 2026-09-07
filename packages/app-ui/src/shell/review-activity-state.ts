import type { SidebarSession } from "@rennet/protocol";
import { create } from "zustand";

export type ReviewActivityState =
  | { readonly kind: "running"; readonly runId: string }
  | { readonly kind: "complete"; readonly at: number }
  | { readonly kind: "failed"; readonly reason: string };

export const useReviewActivityState = create<{
  readonly bySession: Readonly<Record<string, ReviewActivityState>>;
  reconcile(rows: readonly SidebarSession[]): void;
  acknowledge(sessionId: string): void;
}>((set) => ({
  bySession: {},
  reconcile: (rows) =>
    set((state) => {
      const next = { ...state.bySession };
      let changed = false;
      const present = new Set(rows.map((row) => row.id));
      for (const id of Object.keys(next)) {
        if (!present.has(id)) {
          delete next[id];
          changed = true;
        }
      }
      for (const row of rows) {
        const previous = next[row.id];
        const preparation = row.preparation;
        const activity = preparation === undefined ? row.reviewActivity : undefined;
        const runId = activity?.operationId ?? row.reviewId ?? row.id;
        const failure =
          preparation?.status === "failed"
            ? preparation.reason
            : activity?.status === "failed"
              ? activity.reason
              : undefined;
        if (
          preparation?.status === "capturing" ||
          preparation?.status === "drafting" ||
          activity?.status === "running"
        ) {
          if (previous?.kind !== "running" || previous.runId !== runId) {
            next[row.id] = { kind: "running", runId };
            changed = true;
          }
        } else if (failure !== undefined) {
          if (previous?.kind !== "failed" || previous.reason !== failure) {
            next[row.id] = { kind: "failed", reason: failure };
            changed = true;
          }
        } else if (preparation?.status === "cancelled") {
          if (previous) {
            delete next[row.id];
            changed = true;
          }
        } else if (activity?.status === "complete" && previous?.kind === "failed") {
          delete next[row.id];
          changed = true;
        } else if (previous?.kind === "running" && row.reviewId !== undefined) {
          next[row.id] = { kind: "complete", at: Date.now() };
          changed = true;
        }
      }
      return changed ? { bySession: next } : state;
    }),
  acknowledge: (sessionId) =>
    set((state) => {
      if (state.bySession[sessionId]?.kind !== "complete") return state;
      const next = { ...state.bySession };
      delete next[sessionId];
      return { bySession: next };
    }),
}));
