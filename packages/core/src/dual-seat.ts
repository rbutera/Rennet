/**
 * resolveDualSeat — the dual-model seat resolver (issue #41).
 *
 * `pipeline.ts` has an internal `resolveSeat` that resolves ONE model-facing seat
 * (the council's assignment → provenance seed + executor). Dual-model review needs
 * the SAME lens runner run on TWO seats — one per installed provider — so their
 * findings can be reconciled into agreement/disagreement. This is the ordered-pair
 * sibling of that resolver, extracted so both the finding dual path and (later) the
 * pipeline can share it.
 *
 * It returns the seats in a FIXED provider order — Claude first, then Codex —
 * filtered to the providers that are BOTH installed AND have an executor. The
 * provenance is honest per seat: the provider the council actually assigned this
 * job carries the resolved model + effort + resolution trace; the other provider
 * carries a provider-default model with NO trace (the council did not pick it —
 * dual-model added the second opinion). That second-seat default is the
 * STRONGEST Codex model, not the light utility model — see
 * `DEFAULT_CODEX_SECOND_SEAT_MODEL`. The harness always follows the model
 * (`providerHarness`), so no `model=codex`/`harness=claude` provenance lie is
 * possible (Rule 75, double-switched honesty circuit — the same guarantee
 * `resolveSeat` makes).
 *
 * Under a single installed provider it returns ONE seat — dual-model is a
 * capability that lights up when two providers are installed, never a requirement.
 */

import type {
  CouncilHarnessId,
  CouncilJobId,
  CouncilResolveContext,
  OfferedManifest,
  ResolutionTrace,
  RspCapabilitySnapshot,
  RspDocType,
  RspModelReportedBy,
} from "@rennet/protocol";
import { createCodexRunTurn } from "./codex-run-turn";
import type { CodexUtilityPort } from "./codex-utility-port";
import type { HarnessTurnResult } from "./harness-run-turn";
import { providerHarness, resolveAssignment } from "./model-council";

type RunTurn = (prompt: string, attempt: number) => Promise<HarnessTurnResult>;

/**
 * A model-seat provenance seed: the harness/model/effort a seat runs under, stamped
 * onto every RSP document it emits. Inlined from the deleted `finding-generation`
 * pass (B2) — `dual-seat` is its surviving home; the seat resolver is the only code
 * that still shapes it. The council overwrites `harness`/`model`/`effort` per seat.
 */
export interface FindingProvenanceSeed {
  readonly harness: string;
  readonly harnessVersion: string;
  readonly adapterVersion: string;
  readonly model: string;
  readonly modelReportedBy: RspModelReportedBy;
  readonly capability: RspCapabilitySnapshot;
  /** The Model Council effort for this seat, when the council resolved it (#69). */
  readonly effort?: string;
  /** The Model Council resolution trace, when the council resolved this seat (#69). */
  readonly resolutionTrace?: ResolutionTrace;
}

/** The default display labels for the two provider seats. */
export const DEFAULT_SEAT_LABELS: Readonly<Record<CouncilHarnessId, string>> = {
  "claude-code": "Claude",
  codex: "Codex",
};

/** The fixed provider order every dual set is emitted in (Claude first, Codex second). */
const PROVIDER_ORDER: readonly CouncilHarnessId[] = ["claude-code", "codex"];

/**
 * The Codex second-seat default (Rai's ruling): when the council assigned this
 * job to Claude, the second opinion pairs the STRONGEST Codex model against the
 * drafter — not the light-tier utility model. A second opinion is only worth
 * reading if it can disagree with the primary seat on the merits, so this is
 * deliberately NOT `DEFAULT_CODEX_UTILITY_*` (that stays the cheap formatting
 * default for genuine light-tier utility calls). Still a default: a council task
 * override for the job wins over it, and the assigned seat's own resolution
 * always wins.
 */
export const DEFAULT_CODEX_SECOND_SEAT_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_SECOND_SEAT_EFFORT = "high";

/** One resolved provider seat: its label, honest provenance seed, and executor. */
export interface DualSeat {
  readonly provider: CouncilHarnessId;
  /** The label shown beside this seat's answers in a disagreement (e.g. "Claude"). */
  readonly label: string;
  readonly seed: FindingProvenanceSeed;
  /** The turn that runs this seat's lens attempt. Present ⇒ the seat can run. */
  readonly runTurn: RunTurn;
}

export interface ResolveDualSeatInput {
  /**
   * The Model Council context (installed harnesses + overrides). When absent, only
   * the Claude seat is offered (mirrors `resolveSeat`'s council-absent fallback).
   */
  readonly council?: CouncilResolveContext;
  /** The lens job the seats run (e.g. "finding-generation"). */
  readonly jobId: CouncilJobId;
  /** The document type the seats emit (e.g. "finding"); the Codex port's schema. */
  readonly docType: RspDocType;
  /** The patchset the seats' documents bind to (for the Codex port's validation). */
  readonly patchsetId: string;
  /** The offered manifest anchors resolve against — shared by both seats. */
  readonly manifest: OfferedManifest;
  /** The placeholder provenance seed; each seat overwrites harness/model/effort. */
  readonly baseSeed: FindingProvenanceSeed;
  /** The injected Claude turn. Present ⇒ the Claude seat can run (claude installed). */
  readonly claudeTurn?: RunTurn;
  /** The Codex port. Present ⇒ the Codex seat can run (codex installed). */
  readonly codexPort?: CodexUtilityPort;
  /** Optional label overrides; defaults to `DEFAULT_SEAT_LABELS`. */
  readonly labels?: Partial<Record<CouncilHarnessId, string>>;
}

/** The set of providers the council reports installed (Claude-only when absent). */
function installedProviders(council: CouncilResolveContext | undefined): Set<CouncilHarnessId> {
  if (council === undefined) return new Set<CouncilHarnessId>(["claude-code"]);
  return new Set(council.availability.installed);
}

/**
 * Resolve the ordered dual-seat set. Each entry is a provider that is installed
 * AND executable; the list is length 2 under `both`, length 1 under a single
 * provider, and length 0 only when nothing can run (the caller then fails loud).
 */
export function resolveDualSeat(input: ResolveDualSeatInput): DualSeat[] {
  const installed = installedProviders(input.council);
  // The council's assignment for this job (a model job resolves to one provider).
  const resolution =
    input.council === undefined ? undefined : resolveAssignment(input.jobId, input.council);
  const assigned =
    resolution !== undefined && resolution.kind === "model"
      ? { provider: providerHarness(resolution.model), resolution }
      : undefined;

  const seats: DualSeat[] = [];
  for (const provider of PROVIDER_ORDER) {
    if (!installed.has(provider)) continue;

    const label = input.labels?.[provider] ?? DEFAULT_SEAT_LABELS[provider];

    // The provider the council actually assigned carries its resolved model +
    // effort + trace; the other provider carries a provider-default (no trace).
    const councilPicked = assigned?.provider === provider ? assigned.resolution : undefined;

    if (provider === "claude-code") {
      if (input.claudeTurn === undefined) continue;
      const seed: FindingProvenanceSeed = councilPicked
        ? {
            ...input.baseSeed,
            harness: "claude-code",
            model: councilPicked.model,
            modelReportedBy: "config",
            effort: councilPicked.effort,
            resolutionTrace: councilPicked.trace,
          }
        : { ...input.baseSeed, harness: "claude-code" };
      seats.push({ provider, label, seed, runTurn: input.claudeTurn });
      continue;
    }

    // Codex seat: executed through the utility port via createCodexRunTurn, so the
    // council's cross-harness routing is EXECUTED, not merely stamped.
    if (input.codexPort === undefined) continue;
    const model = councilPicked ? councilPicked.model : DEFAULT_CODEX_SECOND_SEAT_MODEL;
    const effort = councilPicked ? councilPicked.effort : DEFAULT_CODEX_SECOND_SEAT_EFFORT;
    const seed: FindingProvenanceSeed = councilPicked
      ? {
          ...input.baseSeed,
          harness: "codex",
          model,
          modelReportedBy: "config",
          effort,
          resolutionTrace: councilPicked.trace,
        }
      : { ...input.baseSeed, harness: "codex", model, modelReportedBy: "config", effort };
    const runTurn = createCodexRunTurn(input.codexPort, {
      docType: input.docType,
      patchset: { id: input.patchsetId },
      manifest: input.manifest,
      model,
      effort,
    });
    seats.push({ provider, label, seed, runTurn });
  }

  return seats;
}
