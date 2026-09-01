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
 *
 * The id is `(generationId, attempt)` and NOT a clock reading. A restart redrafts the same
 * generation, so a timestamped id appended two records that no reader could tell apart —
 * two rows for one generation, both claiming to be it. Attempt 0 is the fresh draft and
 * attempt 1 the redraft, so both are honest and reconcilable; a re-archive of ONE attempt
 * carries the same id and replaces its predecessor in the store, because it is the same
 * attempt measured again rather than a second one.
 */
export function generationBenchmarkRun(input: {
  readonly subject: BenchmarkSubject & { readonly generationId: string };
  readonly attempt: number;
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
    id: `${input.subject.generationId}:${input.attempt}`,
    kind: "generation",
    producer: "daemon",
    attempt: input.attempt,
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

/** Stages this predicate has already complained about, so a build with a hundred progress
 *  events for one unknown stage warns once rather than a hundred times. */
const unnamedStages = new Set<string>();

/**
 * Whether a snapshot-generator progress stage is one this contract names.
 *
 * This IS the drop — a `false` means the stage is not recorded — so it warns rather than
 * returning quietly. The comment here used to claim it "guards the seam where a stage
 * would otherwise be silently dropped", which described the opposite of what the code did:
 * a generator stage added later would vanish from every benchmark with nothing said. One
 * `console.warn` is the whole fix, and the archive stays a projection of what the pipeline
 * measured rather than a contract that silently narrows it.
 */
export function isMapBenchmarkStage(stage: string): stage is MapStage {
  if (MAP_STAGES.has(stage)) return stage !== "total";
  if (!unnamedStages.has(stage)) {
    unnamedStages.add(stage);
    console.warn(
      `benchmarks: the snapshot generator emitted an unnamed stage '${stage}'; it is not being timed. Add it to REPO_MAP_STAGES.`,
    );
  }
  return false;
}

/**
 * A stage timer over a sequential pipeline. `enter` closes the stage in flight and opens
 * the named one; `finish` closes the last. Re-entering a stage already in flight is
 * ignored, because the generator emits the same stage twice (once opening, once with its
 * detail) and treating that as two stages would halve the reported duration of every one.
 *
 * `total` IS THE SUM of this timer's own stage durations, starting at its first `enter`.
 * It used to be the wall clock from the first `enter` to `finish`, and that was wrong the
 * moment a project processed more than one repository: the daemon scouts EVERY repo in one
 * pass and maps them in a LATER one, so a repo's timer opens at its scout and closes after
 * its map — and a wall-clock span charged it for every sibling scouted or mapped in
 * between. Repo A's `total` grew with the size of the project rather than with its own
 * work.
 *
 * The sum hides nothing that belongs to this repo: within a pass the timer never closes a
 * stage until the next one opens, so any wait between two stages is already inside a
 * stage's duration. The only thing it excludes is other repositories' work, which is the
 * point. A whole-project wall time is a different measurement and is not invented here.
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
    /** Close the pipeline and stamp its total — the SUM of this timer's own stages, from
     *  the first one's start. Returns every stage recorded. */
    finish(): BenchmarkStage[] {
      close();
      if (firstFrom !== undefined) {
        stages.push({
          stage: "total",
          startedAtMs: firstFrom,
          durationMs: stages.reduce((sum, stage) => sum + stage.durationMs, 0),
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
