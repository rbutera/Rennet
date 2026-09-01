// The ONE benchmark recorder (#731, D8). Two producers feed it and neither re-measures
// anything: a generation hands over the #725 phase records it already wrote durably, and
// a Repo Map build hands over the stage boundaries its own progress stream already emits.
// This module only shapes them into the versioned record and asks the store to keep it.

import type {
  BenchmarkOutcome,
  BenchmarkRun,
  BenchmarkStage,
  BenchmarkSubject,
  GenerationPhaseTiming,
} from "@rennet/protocol";
import { REPO_MAP_STAGES } from "@rennet/protocol";

/** What a recorder needs from its host: somewhere to put the record, and whether the
 *  reviewer wants records kept at all. */
export interface BenchmarkRecorder {
  /** Record one measured run. A no-op while recording is disabled — the caller does not
   *  branch, so the toggle can never change what the pipeline itself does. */
  record(run: BenchmarkRun): void;
}

/**
 * Turn one generation's durable phase records into a benchmark run. The phases map
 * one-to-one onto stages (a benchmark stage IS a spine phase), so the harness/model each
 * phase recorded rides through untouched — which is what makes
 * {@link import("@rennet/protocol").deriveBenchmarkMode} an observation rather than a guess.
 *
 * A generation that FAILED still produces a record: its outcome says so, and its phases
 * are the ones it managed to complete. A pipeline whose failures vanished would report
 * only the half of its latency that worked.
 */
export function generationBenchmarkRun(input: {
  readonly id: string;
  readonly subject: BenchmarkSubject;
  readonly phases: readonly GenerationPhaseTiming[];
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly outcome: BenchmarkOutcome;
  readonly failure?: string;
}): BenchmarkRun {
  const stages: BenchmarkStage[] = input.phases.map((phase) => ({
    stage: phase.phase,
    ...(phase.lens === undefined ? {} : { lens: phase.lens }),
    startedAtMs: phase.startedAtMs,
    durationMs: phase.durationMs,
    ...(phase.harness === undefined ? {} : { harness: phase.harness }),
    ...(phase.model === undefined ? {} : { model: phase.model }),
  }));
  return {
    version: 1,
    id: input.id,
    kind: "generation",
    subject: input.subject,
    startedAtMs: input.startedAtMs,
    durationMs: Math.max(0, input.endedAtMs - input.startedAtMs),
    outcome: input.outcome,
    ...(input.failure === undefined ? {} : { failure: input.failure }),
    stages,
  };
}

/** The Repo Map build's stage names, minus the `total` this timer computes itself. */
type MapStage = Exclude<(typeof REPO_MAP_STAGES)[number], "total">;

const MAP_STAGES = new Set<string>(REPO_MAP_STAGES);

/** Whether a snapshot-generator progress stage is one this contract names. Guards the
 *  seam where a future generator stage would otherwise be silently dropped. */
export function isMapBenchmarkStage(stage: string): stage is MapStage {
  return MAP_STAGES.has(stage) && stage !== "total";
}

/**
 * A stage timer over a sequential pipeline. `enter` closes the stage in flight and opens
 * the named one; `finish` closes the last. Re-entering a stage already in flight is
 * ignored, because the generator emits the same stage twice (once opening, once with its
 * detail) and treating that as two stages would halve the reported duration of every one.
 *
 * The `total` stage spans the first `enter` to `finish`, so it covers the gaps between
 * stages too — a total that only summed its parts would hide any wait between them.
 */
export function createStageTimer(now: () => number) {
  const stages: BenchmarkStage[] = [];
  let open: { stage: MapStage; from: number } | undefined;
  let firstFrom: number | undefined;

  const close = (): void => {
    if (open === undefined) return;
    stages.push({
      stage: open.stage,
      startedAtMs: open.from,
      durationMs: Math.max(0, Math.floor(now()) - open.from),
    });
    open = undefined;
  };

  return {
    enter(stage: MapStage): void {
      if (open?.stage === stage) return;
      close();
      const from = Math.floor(now());
      firstFrom ??= from;
      open = { stage, from };
    },
    /** Close the stage in flight without opening another. The scout needs this: a repo's
     *  scout must not stay open across a SIBLING repo's scout, or the first repo's number
     *  absorbs the second's. */
    leave(): void {
      close();
    },
    /** Close the pipeline and stamp its end-to-end total. Returns every stage recorded. */
    finish(): BenchmarkStage[] {
      close();
      if (firstFrom !== undefined) {
        stages.push({
          stage: "total",
          startedAtMs: firstFrom,
          durationMs: Math.max(0, Math.floor(now()) - firstFrom),
        });
      }
      return stages;
    },
    /** The stages recorded so far, without closing the pipeline. */
    get recorded(): readonly BenchmarkStage[] {
      return stages;
    },
  };
}
