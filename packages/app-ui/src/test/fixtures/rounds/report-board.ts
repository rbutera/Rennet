import type { HostElement, RoundLedgerRecord, RoundReportBoard } from "@rennet/protocol";
import { board, codeRef, prose, section } from "../boards/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// The completed-round fixtures (C09 task 1.3) — the spike's `round-report.tsx` reborn
// as protocol shape. A round report is NOT a bespoke component: it is a `RoundReportBoard`
// (Reconciliation 3) whose elements are a prose greeting plus `round_outcome` items,
// rendered through the report registry (cluster 2). `round_outcome` is excluded from a
// LENS board's registry, so it lives only here, on the report surface.
//
// Behind the import fence: a surface never imports this directory; a test hands a
// fixture `RoundsSource` (see `./index.ts`) to `RoundsSourceProvider`.
// ─────────────────────────────────────────────────────────────────────────────

/** The round report is authored by the orchestrator (it composes the successor account). */
const ORCH = { kind: "orchestrator", id: "fixture-orchestrator" } as const;

/** One `round_outcome` element — how one dispatched ask fared this round. `code_ref` is
 *  the id of a `code_ref` element in the board pool (rendered through `AnchorReveal`). */
export function roundOutcome(
  id: string,
  opts: {
    status: "addressed" | "partial" | "untouched" | "beyond";
    ask: { ref: string; text: string };
    note: string;
    codeRef?: string;
  },
): HostElement {
  return {
    id,
    kind: "round_outcome",
    data: {
      author: ORCH,
      status: opts.status,
      ask: opts.ask,
      note: opts.note,
      ...(opts.codeRef === undefined ? {} : { code_ref: opts.codeRef }),
    },
  };
}

/**
 * The round-1 report board — the greeting prose over four outcomes (one of each status),
 * the `addressed` one carrying a `code_ref`. Its id is what {@link completedRoundRecord}
 * points at.
 */
export const reportBoardFixture: RoundReportBoard = {
  ...board("design", "gen2", "report-round-1", [
    section("greeting", "What changed", "The refresh path now records every terminal outcome.", [
      prose(
        "greeting-prose",
        "The refresh layer now writes a terminal record on every exit, and the post-send failure is reported as unknown.",
      ),
    ]),
    section(
      "outcomes",
      "Outcomes",
      "1 addressed · 1 partial · 1 untouched · 1 beyond",
      [
        roundOutcome("ro-observability", {
          status: "addressed",
          ask: {
            ref: "ask-observability",
            text: "Log every refresh exit without leaking the token.",
          },
          note: "The refresh layer emits a typed record on each exit; no field can hold a credential.",
          codeRef: "ro-cr-observability",
        }),
        roundOutcome("ro-network", {
          status: "partial",
          ask: { ref: "ask-network", text: "Report the post-send failure honestly." },
          note: "The failure is reported as unknown, but the copy still reads as a hard error.",
        }),
        roundOutcome("ro-retry", {
          status: "untouched",
          ask: { ref: "ask-retry", text: "Cap the retry loop." },
          note: "Left untouched — the cap needs a decision before a worker can act on it.",
        }),
        roundOutcome("ro-tests", {
          status: "beyond",
          ask: { ref: "ask-tests", text: "Tighten the tests." },
          note: "The worker went beyond the ask and covered the persistence-failure exit too.",
        }),
      ],
      { refs: [codeRef("ro-cr-observability", "packages/adapters/src/github-auth.ts", 53, 63)] },
    ),
  ]),
  lens: "report",
  document: {
    title: "Token refresh exits are now observable",
    introMarkdown: "Every terminal path now leaves a typed record without retaining credentials.",
    measure: "reading",
  },
};

/** A map of report boards by id — what the fixture source's `reportBoard` read resolves. */
export const FIXTURE_REPORT_BOARDS: Readonly<Record<string, RoundReportBoard>> = {
  [reportBoardFixture.boardId]: reportBoardFixture,
};

/**
 * The completed round-1 record — the ledger row (C09 §6), PRODUCER-SHAPED (finding 3). A
 * landed round reports against the generation its OWN worker just minted, so the real
 * producer sets `boardGeneration === mintedPatchsetGeneration` — both the newly minted `gen2`
 * (`server/src/runtime/rounds.ts:319`). The earlier draft fixture set them to two different
 * ids (`gen1`/`gen2`) — a shape the producer never emits — which made the ledger's
 * dedup-to-one look like a two-generation history it can never actually be.
 *
 * The frozen PREDECESSOR (the pre-round generation the reviewer would drill back to) is NOT
 * on the `RoundRecord`: the runtime freezes it as `RoundOutcome.frozenPrevious` but does not
 * persist it into the record. So a producer-shaped record carries exactly ONE generation, and
 * frozen-generation reachability through the switcher is parked pending a B9 `RoundRecord`
 * predecessor field (see the C09 ledger, F3).
 */
export const completedRoundRecord: RoundLedgerRecord = {
  asksDispatched: ["ask-observability", "ask-network"],
  workerCommitRange: { from: "commit-from", to: "commit-to" },
  mintedPatchsetGeneration: "gen2",
  boardGeneration: "gen2",
  reportBoard: "report-round-1",
  run: {
    startedAt: Date.UTC(2026, 7, 29, 9, 30),
    sourceTarget: { kind: "branch", branch: "fix/token-refresh-observability" },
    harness: { id: "codex", version: "0.146.0" },
    workspaceRoot: "/Users/rai/code/rennet",
    checkpoint: { threadId: "thread-7", turnId: "turn-12", turnCount: 3 },
    gate: { outcome: "passed", command: "pnpm check", durationMs: 12_400, projectCount: 7 },
  },
  report: reportBoardFixture,
};
