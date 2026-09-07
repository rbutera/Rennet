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
it("retains observed time and four events across tab subscriptions and reconnect snapshots, with distinct successor runs", () => {
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
  observe("review-1", "gen-2", [{ lens: "sequence", seat: seat("New run") }]);
  expect(
    useLensActivityHistory.getState().byRun[lensActivityKey("review-1", "gen-2", seat("New run"))],
  ).toEqual({ observedAt: 9000, history: ["New run"] });
  observe("review-1", "gen-1", [{ lens: "sequence", seat: seat("Retry", "thread-2") }]);
  expect(
    useLensActivityHistory.getState().byRun[
      lensActivityKey("review-1", "gen-1", seat("Retry", "thread-2"))
    ]?.history,
  ).toEqual(["Retry"]);
});
