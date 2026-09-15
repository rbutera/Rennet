import { afterEach, expect, it, vi } from "vitest";
import { lensActivityKey, useLensActivityHistory } from "./lens-activity-state";
import type { LensSeatState } from "./lens-seats";

const seat = (text: string, threadId = "thread-1"): LensSeatState => ({
  lens: "sequence",
  label: "Sequence",
  register: "working",
  cut: "open",
  seated: true,
  drafting: true,
  reworked: false,
  waitingOn: [],
  voices: [
    {
      seat: "sequence",
      thread: { environmentId: "local", threadId },
      speech: { text, quiet: false },
    },
  ],
});
afterEach(() => {
  vi.restoreAllMocks();
  useLensActivityHistory.setState({ byRun: {} });
});
// What this pins: the first observation's clock is kept, the history is newest-first and
// capped at four, an identical re-observation is a no-op, a NEW GENERATION is a fresh run
// with its own clock — and a new seat thread WITHIN a run is NOT. The key ignores voices and
// threads now, so a late-binding thread (or Flagged's compiler joining its two review legs
// mid-run) carries the history forward instead of rotating the key and wiping the whole feed
// to a lone "queued" line. It does not mount a tab or replay a bridge reconnect.
it("keeps the first observed time and four newest events per run, carries history across a thread change, and starts a fresh run only for a new generation", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  const observe = useLensActivityHistory.getState().observe;
  observe("review-1", "gen-1", [{ lens: "sequence", seat: seat("First") }]);
  now.mockReturnValue(9000);
  for (const text of ["Second", "Third", "Fourth", "Fifth"])
    observe("review-1", "gen-1", [{ lens: "sequence", seat: seat(text) }]);
  const key = lensActivityKey("review-1", "gen-1", seat("Fifth"));
  const record = useLensActivityHistory.getState().byRun[key];
  expect(record).toEqual({ observedAt: 1000, history: ["Fifth", "Fourth", "Third", "Second"] });
  observe("review-1", "gen-1", [{ lens: "sequence", seat: seat("Fifth") }]);
  expect(useLensActivityHistory.getState().byRun[key]).toBe(record);
  // A new generation is a fresh run with its own clock.
  observe("review-1", "gen-2", [{ lens: "sequence", seat: seat("New run") }]);
  expect(
    useLensActivityHistory.getState().byRun[lensActivityKey("review-1", "gen-2", seat("New run"))],
  ).toEqual({ observedAt: 9000, history: ["New run"] });
  // A new THREAD on the same review/generation/lens is the SAME run: the key ignores the
  // thread, so the history carries forward (newest-first, still capped at four) and the clock
  // is unchanged. Old behaviour rotated the key here and stranded the feed — the "queued" wipe.
  observe("review-1", "gen-1", [{ lens: "sequence", seat: seat("Retry", "thread-2") }]);
  expect(useLensActivityHistory.getState().byRun[key]).toEqual({
    observedAt: 1000,
    history: ["Retry", "Fifth", "Fourth", "Third"],
  });
});
