// The benchmark record contract (#731, design D8). ONE versioned record schema over the
// durable per-phase timings #725 already writes — not a second timing system. The lens
// and report stages of a `generation` run are a PROJECTION of `Generation.timings`; the
// repo-map stages are the deterministic snapshot build's own progress boundaries, which
// have no generation to ride. Nothing here re-measures anything the spine already measured.
//
// The rule the schema exists to enforce (D8): a stage record names the harness and model
// that ACTUALLY executed it. The Model Council routes per job, so one run legitimately
// spans providers, and a run-level "dual-model" label read off settings would be a guess.
// Every surface therefore DERIVES its mode from the stages through
// {@link deriveBenchmarkMode} — the derivation is a function, never a stored field, so a
// panel and the docs page cannot disagree about the same run.

import { z } from "zod";
import type { CouncilHarnessId } from "./domain";
import { LENS_KINDS, type LensKind } from "./manifests";
import type { GenerationPhase } from "./session/model";

/** The record-schema version. Bump when a record's MEANING changes; adding an optional
 *  field does not, since every reader already tolerates its absence. */
export const BENCHMARK_RECORD_VERSION = 1;

const councilHarnessIds = ["claude-code", "codex"] as const satisfies readonly CouncilHarnessId[];

/** What one benchmark run measured. Two kinds, because two pipelines produce durable
 *  timings from different places: the deterministic Repo Map build, and one drafting
 *  generation (its report gate and its lens lanes together — they share a clock and a
 *  generation id, and splitting them would make the report's share of the wait unfindable). */
export const benchmarkRunKindSchema = z.enum(["repo-map", "generation"]);
export type BenchmarkRunKind = z.infer<typeof benchmarkRunKindSchema>;

/**
 * The Repo Map build's real stage boundaries — `SnapshotBuildStage` verbatim, plus the
 * `scout` that runs before it and the `total` this repo's own stages sum to. These are the
 * stages the generator genuinely emits progress for; there are no model-backed layers to
 * time since the context-map kill, so the whole run is deterministic.
 *
 * `total` IS THE SUM OF THIS REPO'S OWN STAGE DURATIONS, not the wall clock from its first
 * stage to its last. The distinction is load-bearing and was a real defect: a project
 * processes every repo's `scout` in one pass and every repo's map in a LATER pass, so a
 * wall-clock span from `scout` to `store` charges each repo for every sibling scouted or
 * mapped in between. Within a pass the timer never closes a stage until the next one
 * opens, so any wait between two stages is already inside a stage's duration and the sum
 * hides nothing — the only thing it excludes is other repositories' work.
 *
 * A stage set is therefore honest rather than complete: a resumed run whose scout already
 * persisted records no `scout` (it did not run), and `rennet map` never has one by design
 * — see {@link benchmarkProducerSchema}, which says which stages a run COULD have carried.
 */
export const REPO_MAP_STAGES = [
  "scout",
  "resolve",
  "tree",
  "workspace",
  "conventions",
  "symbols",
  "build",
  "verify",
  "store",
  "total",
] as const;

/**
 * The generation's stages. `report`/`report-classification`/`lens-draft`/`lens-repair`/
 * `lens-post-process`/`reveal`/`first-core-board`/`first-element` are the #725 phases
 * verbatim (`coverage` is the retired cross-lens gate's phase, kept so older records
 * parse) — a benchmark stage IS a spine phase, renamed nowhere.
 *
 * There is deliberately no `lens-total`, `lens-dual-review` or `whole-process` stage:
 * those are SPANS OVER the per-seat records ({@link benchmarkLensTotals},
 * {@link benchmarkSpan}), and storing them would be a second number that can disagree
 * with the records it summarises.
 */
export const GENERATION_STAGES = [
  "report",
  "report-classification",
  "lens-draft",
  "lens-repair",
  "lens-post-process",
  "coverage",
  "reveal",
  "first-core-board",
  "first-element",
] as const satisfies readonly GenerationPhase[];

export const benchmarkStageNameSchema = z.enum([...REPO_MAP_STAGES, ...GENERATION_STAGES]);
export type BenchmarkStageName = z.infer<typeof benchmarkStageNameSchema>;

/** The stages that measure ONE lens lane and must name it — the spine's `LENS_SCOPED_PHASES`,
 *  which this list mirrors exactly. Every other stage is run-wide and must not carry a lens. */
export const LENS_SCOPED_STAGES = [
  "lens-draft",
  "lens-repair",
  "lens-post-process",
  "first-core-board",
  "first-element",
] as const satisfies readonly BenchmarkStageName[];

const stagesForKind: Record<BenchmarkRunKind, ReadonlySet<BenchmarkStageName>> = {
  "repo-map": new Set(REPO_MAP_STAGES),
  generation: new Set(GENERATION_STAGES),
};

/**
 * One stage's record. `startedAtMs` is a wall-clock epoch so overlapping stages stay
 * orderable without a shared cursor; `durationMs` is the measured span. `harness`/`model`
 * name what ran the stage and are ABSENT for a stage no provider ran — a deterministic
 * map stage carries neither, and inventing one would be the exact lie D8 forbids.
 */
export const benchmarkStageSchema = z
  .object({
    stage: benchmarkStageNameSchema,
    lens: z.enum(LENS_KINDS).optional(),
    startedAtMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    harness: z.enum(councilHarnessIds).optional(),
    model: z.string().min(1).optional(),
  })
  .superRefine((stage, ctx) => {
    const laneScoped = (LENS_SCOPED_STAGES as readonly BenchmarkStageName[]).includes(stage.stage);
    if (laneScoped && stage.lens === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["lens"],
        message: `the ${stage.stage} stage measures one lane and must name its lens`,
      });
    }
    if (!laneScoped && stage.lens !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["lens"],
        message: `the ${stage.stage} stage is run-wide and must not name a lens`,
      });
    }
    // Attribution is one fact, not two fields. A harness with no model says "Claude ran
    // this, and we will not say which model", and a model with no harness names a string
    // nothing can be held to — both are half-attributions, and a half-attribution reads
    // on the surfaces exactly like a whole one.
    if ((stage.harness === undefined) !== (stage.model === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [stage.harness === undefined ? "harness" : "model"],
        message: `the ${stage.stage} stage must name its harness AND its model, or neither`,
      });
    }
  });
export type BenchmarkStage = z.infer<typeof benchmarkStageSchema>;

/**
 * What the run was measured AGAINST, so a number is always attributable. A repo-map run
 * carries its repo and the snapshot revision it built; a generation carries the session,
 * generation and — when a coding round produced it — that round.
 *
 * The fields are optional HERE and required per kind by {@link benchmarkRunSchema}, which
 * is the only place that knows which kind it is looking at. `roundId` stays genuinely
 * optional: an askless first generation has no round, and demanding one would force a
 * producer to invent an id.
 */
export const benchmarkSubjectSchema = z.object({
  /** Human-readable label for the surfaces (a repo name, a session's review). */
  label: z.string().min(1),
  /** The built snapshot's base OID, for a repo-map run. */
  revision: z.string().min(1).optional(),
  repoKey: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  generationId: z.string().min(1).optional(),
  roundId: z.string().min(1).optional(),
});
export type BenchmarkSubject = z.infer<typeof benchmarkSubjectSchema>;

/**
 * Which pipeline recorded the run, and therefore WHICH STAGES IT COULD HAVE CARRIED. The
 * daemon's project process scouts a repo before it maps it; `rennet map` has no scout pass
 * at all, by design. Without this field a `resolve` row and no `scout` row read as "the
 * scout was lost", when for the CLI it means "there was never one" — and the docs page,
 * which aggregates, cannot tell those apart from the stage list alone.
 *
 * Optional because it is a later addition and an archive written before it exists is not
 * wrong, only unlabelled; every reader states "unrecorded" rather than guessing "daemon".
 */
export const benchmarkProducerSchema = z.enum(["daemon", "cli-map"]);
export type BenchmarkProducer = z.infer<typeof benchmarkProducerSchema>;

/** Reader-facing names, in ONE place so the panel and the docs page agree. */
export const BENCHMARK_PRODUCER_LABEL: Record<BenchmarkProducer | "unrecorded", string> = {
  daemon: "Rennet daemon (scout, then map)",
  "cli-map": "`rennet map` (no scout pass)",
  unrecorded: "Unrecorded producer",
};

/** A run that died is a measurement, not an absence (D8): a pipeline whose slow half only
 *  ever fails would look fast if failures vanished. `aborted` is a cancelled run. */
export const benchmarkOutcomeSchema = z.enum(["complete", "failed", "aborted"]);
export type BenchmarkOutcome = z.infer<typeof benchmarkOutcomeSchema>;

/** The subject fields a run of each kind must carry. Requiredness lives per KIND rather
 *  than on the subject object, because "a repo-map run with no repo" and "a generation
 *  with no generation id" are records nothing downstream can attribute, while the same
 *  field is meaningless on the other kind. */
const requiredSubjectFields: Record<BenchmarkRunKind, readonly (keyof BenchmarkSubject)[]> = {
  // `revision` is NOT here: a build that died before its manifest has no revision to name,
  // and demanding one would make the failed builds — the slowest ones — unrecordable. It
  // is required of a COMPLETE map run below.
  "repo-map": ["repoKey"],
  generation: ["sessionId", "generationId"],
};

export const benchmarkRunSchema = z
  .object({
    version: z.literal(BENCHMARK_RECORD_VERSION),
    id: z.string().min(1),
    kind: benchmarkRunKindSchema,
    /** Which pipeline produced this run — see {@link benchmarkProducerSchema}. */
    producer: benchmarkProducerSchema.optional(),
    subject: benchmarkSubjectSchema,
    /**
     * Which attempt at `subject.generationId` this is, counted from 0. A restart redrafts
     * the SAME generation, so `(generationId, attempt)` — not a clock reading — is what
     * tells the second archive of one generation apart from the first. Two attempts are
     * therefore two honest records; a re-archive of ONE attempt replaces its predecessor,
     * because the identity is the same.
     */
    attempt: z.number().int().nonnegative().optional(),
    startedAtMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    outcome: benchmarkOutcomeSchema,
    /** The failure in the runner's own words, when the run did not complete. */
    failure: z.string().min(1).optional(),
    stages: z.array(benchmarkStageSchema),
  })
  .superRefine((run, ctx) => {
    const allowed = stagesForKind[run.kind];
    run.stages.forEach((stage, index) => {
      if (allowed.has(stage.stage)) return;
      ctx.addIssue({
        code: "custom",
        path: ["stages", index, "stage"],
        message: `a ${run.kind} run cannot carry the ${stage.stage} stage`,
      });
    });
    // A repo-map build is deterministic end to end. No stage of one can name a provider,
    // so a harness on any of them is not a routing surprise to be rendered — it is a
    // corrupt record, and `deriveBenchmarkMode` would read it as a configuration label.
    if (run.kind === "repo-map") {
      run.stages.forEach((stage, index) => {
        if (stage.harness === undefined && stage.model === undefined) return;
        ctx.addIssue({
          code: "custom",
          path: ["stages", index, "harness"],
          message: `a repo-map run is deterministic and its ${stage.stage} stage cannot name a provider`,
        });
      });
    }
    for (const field of requiredSubjectFields[run.kind]) {
      if (run.subject[field] !== undefined) continue;
      ctx.addIssue({
        code: "custom",
        path: ["subject", field],
        message: `a ${run.kind} run must name its ${field}`,
      });
    }
    if (
      run.kind === "repo-map" &&
      run.outcome === "complete" &&
      run.subject.revision === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["subject", "revision"],
        message: "a completed repo-map run must name the revision it built",
      });
    }
  });
export type BenchmarkRun = z.infer<typeof benchmarkRunSchema>;

/**
 * The run-level configuration label, DERIVED from the stages that actually executed.
 * `unattributed` is the honest answer for a run whose stages named no provider (every
 * repo-map run, and a generation that failed before a seat resolved) — it is not a
 * fourth configuration, it is "no stage here names one".
 */
export const benchmarkModeSchema = z.enum([
  "dual-model",
  "claude-only",
  "codex-only",
  "unattributed",
]);
export type BenchmarkMode = z.infer<typeof benchmarkModeSchema>;

/**
 * Derive a run's mode from its stage records. Per-seat records are what make this
 * possible: a genuinely dual Flagged lane emits TWO `lens-draft` records, one per seat,
 * so a run that routed one lane to each provider yields both harnesses here — where a
 * merged per-lane record could only have named one of them.
 *
 * Reading the distinct harness set over ALL stages (not just `lens-draft`) is deliberate:
 * a run whose report gate ran on Codex and whose lenses ran on Claude IS dual-model, and
 * scoping the set to drafting would silently relabel it Claude-only.
 */
export function deriveBenchmarkMode(stages: readonly BenchmarkStage[]): BenchmarkMode {
  let claude = false;
  let codex = false;
  for (const stage of stages) {
    if (stage.harness === "claude-code") claude = true;
    if (stage.harness === "codex") codex = true;
  }
  if (claude && codex) return "dual-model";
  if (claude) return "claude-only";
  if (codex) return "codex-only";
  return "unattributed";
}

/** Reader-facing names for the derived modes. One list, so the panel and the docs page
 *  cannot describe the same run differently. */
export const BENCHMARK_MODE_LABEL: Record<BenchmarkMode, string> = {
  "dual-model": "Dual model (council)",
  "claude-only": "Claude only",
  "codex-only": "Codex only",
  unattributed: "No provider stage",
};

/**
 * The span covered by a set of stages: earliest start to latest end. This is how a lane
 * with two seats gets ONE duration without a stored total — exactly the min-start /
 * max-end rule the #725 spine defines for a lane. Returns `undefined` for no stages,
 * because a span over nothing is not zero.
 */
export function benchmarkSpan(
  stages: readonly BenchmarkStage[],
): { startedAtMs: number; durationMs: number } | undefined {
  if (stages.length === 0) return undefined;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const stage of stages) {
    from = Math.min(from, stage.startedAtMs);
    to = Math.max(to, stage.startedAtMs + stage.durationMs);
  }
  return { startedAtMs: from, durationMs: Math.max(0, to - from) };
}

/** Per-lens totals — the whole-lane span across that lens's draft, repair and
 *  post-process records, in `LENS_KINDS` order so two callers agree on ordering. */
export function benchmarkLensTotals(
  stages: readonly BenchmarkStage[],
): { lens: LensKind; startedAtMs: number; durationMs: number }[] {
  const totals: { lens: LensKind; startedAtMs: number; durationMs: number }[] = [];
  for (const lens of LENS_KINDS) {
    const span = benchmarkSpan(stages.filter((stage) => stage.lens === lens));
    if (span !== undefined) totals.push({ lens, ...span });
  }
  return totals;
}

/**
 * The lens lane's dual-review span, present only when the lane genuinely ran more than
 * one seat. Absent means "this lane had one seat" — never "the review was not timed".
 */
export function benchmarkDualReview(
  stages: readonly BenchmarkStage[],
  lens: LensKind,
): { startedAtMs: number; durationMs: number; harnesses: string[] } | undefined {
  const drafts = stages.filter((stage) => stage.stage === "lens-draft" && stage.lens === lens);
  if (drafts.length < 2) return undefined;
  const span = benchmarkSpan(drafts);
  if (span === undefined) return undefined;
  const harnesses = [...new Set(drafts.map((draft) => draft.harness ?? "unattributed"))].sort();
  return { ...span, harnesses };
}

// ── The committed export (D8 consumer 3) ────────────────────────────────────────────────
// The developer-run export lands THIS shape under `docs/`, and the docs benchmarks page
// renders it. Provenance is stated on the artifact, so a stale page is stale-but-labeled
// rather than fresh-but-invented.

export const benchmarkProvenanceSchema = z.object({
  /** The export's own date stamp (ISO). The ONLY clock read in the export path. */
  exportedAt: z.iso.datetime(),
  /** The machine the runs were recorded on ("darwin arm64, 16 GB"). */
  machine: z.string().min(1),
  /** The rennet revision measured. */
  revision: z.string().min(1),
});
export type BenchmarkProvenance = z.infer<typeof benchmarkProvenanceSchema>;

export const benchmarkExportSchema = z.object({
  version: z.literal(BENCHMARK_RECORD_VERSION),
  provenance: benchmarkProvenanceSchema,
  /**
   * One entry per (kind, derived mode, stage, lens, OUTCOME) — the aggregate the docs page
   * renders. Outcome is part of the identity, not a filter: the stage records of a run
   * that died are real measurements (a lane that always fails after 90 s is a fact about
   * the pipeline), but a median mixing them with the completed ones describes neither.
   */
  stages: z.array(
    z.object({
      kind: benchmarkRunKindSchema,
      mode: benchmarkModeSchema,
      outcome: benchmarkOutcomeSchema,
      stage: benchmarkStageNameSchema,
      lens: z.enum(LENS_KINDS).optional(),
      /** How many stage records this row aggregates. */
      samples: z.number().int().positive(),
      medianMs: z.number().int().nonnegative(),
      slowestMs: z.number().int().nonnegative(),
    }),
  ),
  /** One entry per (kind, derived mode) — how many runs, how they ended, and which
   *  pipelines recorded them. */
  runs: z.array(
    z.object({
      kind: benchmarkRunKindSchema,
      mode: benchmarkModeSchema,
      count: z.number().int().positive(),
      complete: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      aborted: z.number().int().nonnegative(),
      /**
       * The median wall time of the COMPLETE runs in this group. Absent when none
       * completed — a group of three failures has no latency, and printing `0` there
       * would read as an instantaneous pipeline rather than as one that never finished.
       */
      medianMs: z.number().int().nonnegative().optional(),
      /** The distinct producers behind this group, sorted; `"unrecorded"` for runs
       *  archived before the field existed. Says which stages the group COULD carry. */
      producers: z.array(z.string().min(1)).min(1),
    }),
  ),
});
export type BenchmarkExport = z.infer<typeof benchmarkExportSchema>;
