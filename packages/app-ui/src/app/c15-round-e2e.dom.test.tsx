// @vitest-environment happy-dom
//
// ─────────────────────────────────────────────────────────────────────────────
// The C15 packet E2E (task 5.1) — the WHOLE regeneration chain over the REAL app
// surfaces and the LIVE rounds seam. C09's `rounds-e2e.dom.test.tsx` proved the same
// chain over the FIXTURE timeline clock; this one proves it over the real wire:
//
//   real dispatch (`round.dispatch` over the bridge, from the hand-off's own button)
//     → the `runRound` trigger's progress, streaming as `RoundEvent`s
//     → the run route's rows advancing on those events (no fixture clock anywhere)
//     → the round report GREETING while the drafters still regenerate
//     → **View the New Boards** appearing at real composition
//     → the durable `RoundRecord` in the ledger, its frozen gen-1 reachable
//     → the kicker reading verbatim "Regenerating the Boards" → "Regenerated the Boards"
//
// WHAT IS REAL HERE, AND WHAT IS NOT:
//   • The SOURCE is the production one — `useLiveRoundsSource()`, the same seam body the
//     app tree binds (`routes/app.tsx`). Its round state is the `session.roundEvents`
//     catch-up read with the `roundProgress` push channel folded in, reduced through the
//     production `advance`. No fixture clock, no tick, no `setTimeout`.
//   • The EVENTS are the server's. Every one below is emitted verbatim by production —
//     `create-server.ts`'s dispatch half (`dispatched`/`prep`/`worker`/`gate`/`committed`,
//     the "Folded the round's asks into one work order" and "Ran the work order" labels)
//     and `rounds.ts`'s regeneration half (`report`, the per-lens `lens` lanes with the
//     `LENS_LANE_LABEL` names and the `carrying forward`/`reworked` verdicts, `composed`).
//     Each is PARSED through protocol's `RoundEventSchema` before it is pushed, so this
//     file cannot drift from the wire; that the server really emits this walk is proven
//     server-side in `server/src/runtime/round-progress.test.ts` (3.1/3.3), over a real
//     `runRound` with only the model seats faked. The two halves meet at the schema.
//   • The RECORD is the durable one — parsed through `RoundLedgerRecordSchema`, carrying the
//     `frozenPredecessor` C15 2.2 stamps (distinct from `boardGeneration`), which is what
//     un-parks C09 finding F3 and gives the ledger's switcher a real gen-1 to open. Its exact
//     report projection is the production `session.rounds` shape, so the live source supplies
//     the greeting without a fixture-only provider override.
// ─────────────────────────────────────────────────────────────────────────────
import type {
  ComposedHandoffBundle,
  Review,
  RoundEvent,
  RoundLedgerRecord,
} from "@rennet/protocol";
import { RoundEventSchema, RoundLedgerRecordSchema } from "@rennet/protocol";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Route, Router, Switch } from "wouter";
import { BridgeProvider } from "../data";
import { RoundsSourceProvider, useLiveRoundsSource } from "../rounds/rounds-data";
import { RunRoute } from "../rounds/run-route";
import { memoryHistory } from "../routes/history";
import { ROUTES } from "../routes/url";
import { useRennetStore } from "../store";
import { act, mount, waitFor } from "../test/dom";
import { fixtureBoardRead } from "../test/fixtures/boards";
import { reportBoardFixture } from "../test/fixtures/rounds";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { ReviewWorkspace } from "./review-workspace-route";

const store = () => useRennetStore.getState();

/** This fixture exercises the legacy review-id route fallback. Durable session slugs
 *  resolve their attached review separately in rounds-live.dom.test and the desktop journey. */
const REVIEW_ID = "rev-c15";

const review = {
  id: REVIEW_ID,
  activePatchsetId: "ps-1",
  repositoryRoot: "/home/dev/rennet",
} as unknown as Review;

const routeResolutionHandlers: MemoryBridgeHandlers = {
  "session.list": () => ({ sessions: [] }),
  "review.load": ({ reviewId }) => {
    if (reviewId !== REVIEW_ID) throw new Error(`unexpected review ${reviewId}`);
    return { review, repositoryPresent: true };
  },
};

const REPORT_BOARD_ID = "report-round-1";

/**
 * The round the server ran, as it really came over the wire. Parsed — not cast —
 * through `RoundEventSchema`, so an event shape this file gets wrong fails here rather
 * than quietly diverging from the emitter.
 */
const SERVER_ROUND: readonly RoundEvent[] = [
  // ── create-server.ts's dispatch half ──
  { type: "dispatched" },
  {
    type: "prep",
    rows: [
      {
        id: "asks",
        label: "Folded the round's asks into one work order",
        status: "done",
        detail: "2 asks",
      },
    ],
  },
  { type: "worker", rows: [{ id: "turn", label: "Ran the work order", status: "running" }] },
  {
    type: "worker",
    rows: [{ id: "turn", label: "Ran the work order", status: "done", detail: "3 files changed" }],
  },
  { type: "gate" },
  { type: "committed" },
  // ── rounds.ts's regeneration half (runRound's onProgress sink) ──
  { type: "report", reportBoardId: REPORT_BOARD_ID },
  {
    type: "lens",
    lanes: [
      { id: "design", label: "Design", status: "running" },
      { id: "sequence", label: "Sequence", status: "queued" },
      { id: "decisions", label: "Decisions", status: "queued" },
      { id: "flagged", label: "Flagged", status: "queued" },
      { id: "noise", label: "Noise", status: "queued" },
    ],
  },
  {
    type: "lens",
    lanes: [
      // Design's sections MOVED this generation, so its lane reads `reworked` — the 3.3
      // hard constraint at the reviewer's eye. The rest carried byte-identically.
      { id: "design", label: "Design", status: "done", verdict: "reworked" },
      { id: "sequence", label: "Sequence", status: "done", verdict: "carrying-forward" },
      { id: "decisions", label: "Decisions", status: "done", verdict: "carrying-forward" },
      { id: "flagged", label: "Flagged", status: "done", verdict: "reworked" },
      { id: "noise", label: "Noise", status: "done", verdict: "carrying-forward" },
    ],
  },
  { type: "composed", generation: "gen2" },
].map((event) => RoundEventSchema.parse(event));

/** The DURABLE record the round wrote (C15 2.2) — the frozen predecessor is a distinct
 *  id from the generation it composed, which is the whole of finding F3. */
const DURABLE_RECORD: RoundLedgerRecord = RoundLedgerRecordSchema.parse({
  asksDispatched: ["ask-observability", "ask-network"],
  workerCommitRange: { from: "commit-from", to: "commit-to" },
  mintedPatchsetGeneration: "gen2",
  frozenPredecessor: "gen1",
  boardGeneration: "gen2",
  reportBoard: REPORT_BOARD_ID,
  run: {
    startedAt: Date.UTC(2026, 7, 29, 9, 30),
    sourceTarget: { kind: "branch", branch: "fix/token-refresh-observability" },
    gate: { outcome: "passed", command: "pnpm check", durationMs: 12_400, projectCount: 7 },
  },
  report: reportBoardFixture,
  // The report's own verified tally (C15 finding 10) — two of this round's outcomes were
  // not `untouched`. Equal to the ask count here by coincidence of the fixture, and the
  // ledger's own tests hold the two apart.
  reworkCount: 2,
} satisfies RoundLedgerRecord);

/** A minimal-but-schema-real `round.dispatch` answer — the command's output shape. The
 *  UI ignores it (dispatch returns void); it exists so the write is a real command
 *  round-trip rather than a swallowed rejection. */
const dispatchAnswer = (
  reviewId: string,
): { workOrder: ComposedHandoffBundle } & {
  dispatched: boolean;
} => ({
  workOrder: {
    reviewId,
    patchsetId: "ps-1",
    tasks: [],
    prompt: "",
    digest: "d",
    composed: true,
    traceMap: {},
  },
  dispatched: true,
});

function LiveScope({ children }: { readonly children: ReactNode }) {
  const live = useLiveRoundsSource();
  return <RoundsSourceProvider value={live}>{children}</RoundsSourceProvider>;
}

afterEach(() =>
  act(() => {
    store().reviewActions.resetReview();
    store().runActions.resetRun();
  }),
);

function appTree(history: ReturnType<typeof memoryHistory>, bridge: MemoryBridge): ReactElement {
  return (
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <LiveScope>
          <Switch>
            <Route path={ROUTES.sessionRun}>{(p) => <RunRoute slug={p.slug ?? ""} />}</Route>
            <Route path={ROUTES.session}>{() => <ReviewWorkspace review={review} />}</Route>
          </Switch>
        </LiveScope>
      </Router>
    </BridgeProvider>
  );
}

/**
 * The daemon, as far as this app tree can tell: an append-only round log per review
 * (`RoundProgressHub`'s own semantics — a `dispatched` RESETS it) that both the
 * `session.roundEvents` catch-up read and the `roundProgress` push channel serve, and a
 * `round.dispatch` that — like production — acknowledges the accepted work order while
 * the round continues asynchronously. The durable ledger row lands before the terminal
 * progress receipt; that receipt is what tells the client the row is now ready to read.
 */
function mountApp(path: string) {
  const dispatched: string[] = [];
  const log: RoundEvent[] = [];
  let records: readonly RoundLedgerRecord[] = [];
  let ledgerReads = 0;
  const bridge = new MemoryBridge({
    ...routeResolutionHandlers,
    "board.read": fixtureBoardRead,
    "session.roundEvents": () => ({ events: [...log] }),
    "session.rounds": () => {
      ledgerReads += 1;
      return { records: [...records] };
    },
    "round.dispatch": ({ reviewId }) => {
      dispatched.push(reviewId);
      return dispatchAnswer(reviewId);
    },
  });
  const history = memoryHistory(path);
  const r = mount(appTree(history, bridge));
  /** Push one REAL server event down the live channel — the only motion in this file. */
  const push = (event: RoundEvent) => {
    if (event.type === "dispatched") log.length = 0;
    log.push(event);
    act(() => bridge.emitRoundProgress(REVIEW_ID, event));
  };
  return {
    r,
    history,
    bridge,
    dispatched,
    push,
    persistRound: () => {
      records = [DURABLE_RECORD];
    },
    ledgerReads: () => ledgerReads,
  };
}

const evidence: string[] = [];
const shown = (line: string) => {
  evidence.push(line);
};

describe("C15 packet E2E — the regeneration chain over the live seam", () => {
  it("dispatch → live progress → greeting → reveal → gen2 → ledger with a reachable gen-1", async () => {
    // ── 1 · REAL DISPATCH ────────────────────────────────────────────────────
    // The hand-off's Dispatch Round is live because the LIVE source carries `dispatch`
    // (over the honest-absent source it is undefined and the button stays disabled).
    act(() =>
      store().reviewActions.stageAsk({
        id: "src/a.ts:5",
        anchor: "src/a.ts:5",
        type: "request-change",
        body: "guard the boundary",
      }),
    );
    const { r, history, dispatched, push, persistRound, ledgerReads } = mountApp(
      `/s/${REVIEW_ID}?view=handoff`,
    );
    const button = r.getByRole("button", { name: "Dispatch Round" });
    expect(button.hasAttribute("disabled")).toBe(false);
    await r.user.click(button);
    await waitFor(() => expect(dispatched).toEqual([REVIEW_ID]));
    // The run route TOOK OVER and HELD it — before the daemon has said a word. The
    // reviewer's own dispatch is the round's first fact, so the takeover does not bounce
    // off an `absent` round it simply has not been told about yet.
    const run = () => r.container.querySelector('[data-screen="session-run"]');
    expect(history.history.at(-1)).toBe(`/s/${REVIEW_ID}/run`);
    expect(run()?.getAttribute("data-phase")).toBe("dispatching");
    shown(`1 · dispatch → round.dispatch(${REVIEW_ID}) → held ${history.history.at(-1)}`);

    // ── 2 · LIVE PROGRESS (real events, no fixture clock) ────────────────────
    for (const event of SERVER_ROUND.slice(0, 3)) push(event);
    expect(run()?.getAttribute("data-phase")).toBe("working");
    expect(r.container.querySelector('[data-row="asks"]')?.textContent).toContain(
      "Folded the round's asks into one work order",
    );
    expect(r.container.querySelector('[data-row="turn"]')?.textContent).toContain("running");
    push(SERVER_ROUND[3] as RoundEvent); // the worker turn settles — one real event forward
    expect(r.container.querySelector('[data-row="turn"]')?.textContent).toContain(
      "3 files changed",
    );
    push(SERVER_ROUND[4] as RoundEvent); // gate
    expect(run()?.getAttribute("data-phase")).toBe("gating");
    push(SERVER_ROUND[5] as RoundEvent); // committed
    expect(run()?.getAttribute("data-phase")).toBe("committing");
    shown("2 · run route walked working → gating → committing on real events (no clock)");

    // ── 3 · THE RUN HOLDS THROUGH REPORT AND REGENERATION ─────────────────────
    push(SERVER_ROUND[6] as RoundEvent);
    push(SERVER_ROUND[7] as RoundEvent); // the first lens lane starts
    expect(history.history.at(-1)).toBe(`/s/${REVIEW_ID}/run`);
    expect(run()?.getAttribute("data-phase")).toBe("composing");
    expect(r.container.querySelector('[data-screen="round-greeting"]')).toBeNull();
    expect(r.queryByTestId("reveal-new-boards")).toBeNull();
    shown("3 · report and regeneration held the run route; reveal absent");

    // ── 4 · SETTLED LANES STILL DO NOT NAVIGATE EARLY ────────────────────────
    push(SERVER_ROUND[8] as RoundEvent); // every lane settles with its real verdict
    expect(history.history.at(-1)).toBe(`/s/${REVIEW_ID}/run`);

    // ── 5 · VERIFIED COMPLETION RETURNS WITH THE SETTLED ACCOUNT ─────────────
    const readsBeforeRecord = ledgerReads();
    persistRound();
    await act(async () => {
      await Promise.resolve();
    });
    // Persisting server truth does not invent a client refresh. Only the terminal receipt
    // below proves that the durable row is ready and changes the live ledger projection.
    expect(ledgerReads()).toBe(readsBeforeRecord);
    push(SERVER_ROUND[9] as RoundEvent); // composed, generation gen2
    await waitFor(() => expect(ledgerReads()).toBeGreaterThan(readsBeforeRecord));
    await waitFor(() => expect(history.history.at(-1)).toBe(`/s/${REVIEW_ID}`));
    expect(r.container.querySelector('[data-screen="round-greeting"]')).not.toBeNull();
    expect(r.getByTestId("report-tally").textContent).toContain("addressed");
    const progress = () => r.getByTestId("regeneration-progress");
    expect(progress().textContent).toContain("Regenerated the Boards");
    const laneText = (id: string) =>
      r.container.querySelector(`[data-row="${id}"]`)?.textContent ?? "";
    expect(laneText("design")).toContain("reworked");
    expect(laneText("design")).not.toContain("carrying forward");
    expect(laneText("sequence")).toContain("carrying forward");
    // 4.2's post-process and composed receipts are present on the returned surface.
    expect(r.container.querySelector('[data-step="post-process"]')?.textContent).toContain(
      "Cleaning up drafts · post-process pass",
    );
    expect(r.container.querySelector('[data-step="composed"]')?.textContent).toContain(
      "Composed generation gen2",
    );
    shown("4 · completion returned with settled regeneration receipts");

    // ── 6 · VIEW THE NEW BOARDS ──────────────────────────────────────────────
    const reveal = r.getByTestId("reveal-new-boards");
    expect(reveal.hasAttribute("disabled")).toBe(false); // present, never disabled
    await r.user.click(reveal);
    expect(r.container.querySelector('[data-screen="round-greeting"]')).toBeNull(); // one consume
    await waitFor(() =>
      expect(r.container.querySelector('article[data-generation="gen2"]')).not.toBeNull(),
    );
    const boardSwitcher = r.container.querySelector('[data-kind="generation-switcher"]');
    expect(
      boardSwitcher?.querySelector('[data-generation="gen1"][data-frozen="true"]'),
    ).not.toBeNull();
    shown('5 · "Regenerated the Boards" + reveal → gen2 boards over board.read');

    // ── 6 · THE DURABLE RECORD IN THE LEDGER, GEN-1 REACHABLE ────────────────
    act(() => history.navigate(`/s/${REVIEW_ID}?view=rounds`));
    await waitFor(() =>
      expect(r.container.querySelector('[data-screen="rounds-ledger"]')).not.toBeNull(),
    );
    // C15 4.3 — the retrospective line, off the durable record's real numbers.
    const retro = r.getByTestId("round-retrospective");
    expect(retro.textContent).toContain("Regenerated the boards · 2 reworks · generation gen2");
    // C15 4.4 — the generation/round intro line, and the switcher offering the FROZEN gen-1
    // the record's `frozenPredecessor` names (C09 F3, un-parked).
    expect(r.getByTestId("board-intro").textContent).toContain("Generation 2 · Round 1");
    const switcher = r.container.querySelector('[data-kind="generation-switcher"]');
    expect(switcher).not.toBeNull();
    const gen1Tab = switcher?.querySelector('[data-generation="gen1"]') as HTMLElement | null;
    expect(gen1Tab).not.toBeNull();
    await r.user.click(gen1Tab as HTMLElement);
    await waitFor(() =>
      expect(r.container.querySelector('article[data-generation="gen1"]')).not.toBeNull(),
    );
    shown("6 · retrospective line + gen-1 drill-down off the durable frozenPredecessor");

    // The evidence chain, SHOWN — the nine C9 claims walked over one live round.
    console.log(`[c15-e2e]\n  ${evidence.join("\n  ")}`);
  });

  it("a cold deep-link mid-round folds the catch-up read and never dispatches", async () => {
    // The reviewer opens `/s/:slug/run` cold while the round is in flight. The live
    // source's `session.roundEvents` read IS the catch-up; the run route only reads.
    const dispatched: string[] = [];
    const bridge = new MemoryBridge({
      ...routeResolutionHandlers,
      "board.read": fixtureBoardRead,
      "session.roundEvents": () => ({ events: SERVER_ROUND.slice(0, 5) }), // through `gate`
      "session.rounds": () => ({ records: [] }),
      "round.dispatch": ({ reviewId }) => {
        dispatched.push(reviewId);
        return dispatchAnswer(reviewId);
      },
    });
    const history = memoryHistory(`/s/${REVIEW_ID}/run`);
    const r = mount(appTree(history, bridge));
    await waitFor(() =>
      expect(
        r.container.querySelector('[data-screen="session-run"]')?.getAttribute("data-phase"),
      ).toBe("gating"),
    );
    expect(dispatched).toEqual([]); // mounting never dispatches
  });
});
