import {
  BENCHMARK_MODE_LABEL,
  type BenchmarkMode,
  type BenchmarkRun,
  type BenchmarkStage,
  benchmarkDualReview,
  benchmarkLensTotals,
  deriveBenchmarkMode,
} from "@rennet/protocol";
import { Collapse, cn, Switch } from "@rennet/ui";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Icon } from "../components/icon";
import { Row, Section } from "./atoms";
import { useBenchmarks, useSetBenchmarkRecording, useSettingsView } from "./data";

// ─────────────────────────────────────────────────────────────────────────────
// The Settings benchmarks panel (#731 9.5–9.6, design D8). Two things live here: the
// default-on recording toggle, and the recorded history.
//
// The panel DERIVES every run's mode from its own stage records rather than reading a
// stored label, because the Model Council routes per job and a run can legitimately span
// providers. A dual-seat lane records one draft per seat, so a run that put one lane on
// each harness names both here — which is the whole reason the mode is a function and not
// a field. Runs are split into a section per mode: averaging a Claude-only run together
// with a council run would state a number describing no configuration that exists.
//
// Staying smooth on a long history is two things, neither of them a virtualization
// library. The served list is CAPPED (`benchmarks.list` takes a limit), and a run's stage
// rows — the bulk of the DOM, dozens per run — exist only while that run is expanded,
// because `Collapse` unmounts closed children. The summary rows that remain also carry
// `content-visibility: auto`, so the browser skips layout and paint for the ones scrolled
// out of view. The perf check in `benchmarks.dom.test.tsx` asserts the mounted stage-row
// count stays flat as the history grows, which is the property that actually decides it.
// ─────────────────────────────────────────────────────────────────────────────

/** Section order: the configurations first, the honest "no provider stage" bucket last. */
const MODE_ORDER: readonly BenchmarkMode[] = [
  "dual-model",
  "claude-only",
  "codex-only",
  "unattributed",
];

const KIND_LABEL: Record<BenchmarkRun["kind"], string> = {
  "repo-map": "Repo Map build",
  generation: "Lens generation",
};

/** Human duration. Sub-second stays in ms because a 40 ms deterministic stage rounding to
 *  "0.0 s" would read as free, and several of the map stages genuinely are that fast. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatStarted(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** One stage's line. The executor is stated where there was one and omitted where there
 *  was not — a deterministic map stage has no harness, and printing a guess would be the
 *  exact lie the per-stage contract exists to prevent. */
function StageLine({
  stage,
  indent,
}: {
  readonly stage: BenchmarkStage;
  readonly indent?: boolean;
}) {
  return (
    <div
      data-slot="benchmark-stage"
      className={cn("flex items-baseline gap-2 py-0.5 text-xs", indent && "pl-4")}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{stage.stage}</span>
      {stage.harness ? (
        <span className="shrink-0 text-2xs text-ink-faint">
          {stage.harness}
          {stage.model ? ` · ${stage.model}` : ""}
        </span>
      ) : null}
      <span className="shrink-0 tabular-nums text-ink">{formatMs(stage.durationMs)}</span>
    </div>
  );
}

function RunStages({ run }: { readonly run: BenchmarkRun }) {
  if (run.stages.length === 0) {
    return (
      <p className="py-1 text-xs text-ink-soft">
        This run recorded no stage — it ended before its first measured boundary.
      </p>
    );
  }
  if (run.kind === "repo-map") {
    return (
      <div className="pb-2">
        {run.stages.map((stage) => (
          <StageLine key={`${stage.stage}:${stage.startedAtMs}`} stage={stage} />
        ))}
      </div>
    );
  }
  // A generation splits into the run-wide gate stages and the per-lens lanes. The lane
  // total and the dual-review span are computed from the seat records beside them, never
  // stored, so a lane's summary can never disagree with the records it summarises.
  const wide = run.stages.filter((stage) => stage.lens === undefined);
  const lanes = benchmarkLensTotals(run.stages);
  return (
    <div className="pb-2">
      {wide.map((stage) => (
        <StageLine key={`${stage.stage}:${stage.startedAtMs}`} stage={stage} />
      ))}
      {lanes.map((lane) => {
        const dual = benchmarkDualReview(run.stages, lane.lens);
        return (
          <div key={lane.lens} className="pt-1">
            <div className="flex items-baseline gap-2 py-0.5 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{lane.lens}</span>
              {dual ? (
                <span className="shrink-0 text-2xs text-ink-faint">
                  dual review · {dual.harnesses.join(" + ")} · {formatMs(dual.durationMs)}
                </span>
              ) : null}
              <span className="shrink-0 tabular-nums text-ink">{formatMs(lane.durationMs)}</span>
            </div>
            {run.stages
              .filter((stage) => stage.lens === lane.lens)
              .map((stage) => (
                <StageLine
                  key={`${stage.stage}:${stage.startedAtMs}:${stage.harness ?? ""}`}
                  stage={stage}
                  indent
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}

function RunRow({ run }: { readonly run: BenchmarkRun }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-slot="benchmark-run"
      data-outcome={run.outcome}
      // Native rendering virtualization: the browser skips layout and paint for rows
      // outside the viewport, and the intrinsic size keeps the scrollbar honest while
      // they are skipped. No library, no windowing maths, no scroll listener.
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 44px" }}
      className="py-1"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-baseline gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-raised/60"
      >
        <Icon
          icon={ChevronRight}
          className={cn("size-3 shrink-0 text-ink-faint transition-transform", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate text-13 text-ink">{run.subject.label}</span>
        {run.outcome === "complete" ? null : (
          <span className="shrink-0 text-2xs text-accent">{run.outcome}</span>
        )}
        <span className="shrink-0 text-2xs text-ink-faint">{formatStarted(run.startedAtMs)}</span>
        <span className="shrink-0 tabular-nums text-13 text-ink">{formatMs(run.durationMs)}</span>
      </button>
      {run.failure ? <p className="px-6 text-2xs text-ink-soft">{run.failure}</p> : null}
      <Collapse open={open}>
        <div className="px-6">
          <RunStages run={run} />
        </div>
      </Collapse>
    </div>
  );
}

export function BenchmarksPage() {
  const { data: view } = useSettingsView();
  const { data, pending, error } = useBenchmarks();
  const { mutate, pending: writing } = useSetBenchmarkRecording();
  const [writeError, setWriteError] = useState<string>();

  const recording = view?.benchmarkRecording ?? true;
  const runs = data?.runs ?? [];

  async function toggle(next: boolean) {
    if (writing || next === recording) return;
    setWriteError(undefined);
    try {
      await mutate({ enabled: next });
    } catch (reason) {
      setWriteError(errorText(reason));
    }
  }

  // Grouped by DERIVED mode, and by run kind within a mode, so no surface ever averages
  // a Repo Map build together with a lens generation or one configuration with another.
  const byMode = new Map<BenchmarkMode, BenchmarkRun[]>();
  for (const run of runs) {
    const mode = deriveBenchmarkMode(run.stages);
    const bucket = byMode.get(mode);
    if (bucket === undefined) byMode.set(mode, [run]);
    else bucket.push(run);
  }

  return (
    <>
      <Section title="Benchmarks" caption="~/.rennet/client-settings.json">
        <Row
          label="Record benchmarks"
          hint="Keeps a local timing record of every Repo Map build and lens generation. On by default; nothing leaves this machine."
        >
          <Switch
            size="sm"
            aria-label="Record benchmarks"
            checked={recording}
            disabled={writing}
            onCheckedChange={(next: boolean) => void toggle(next)}
          />
        </Row>
        {writeError ? (
          <Row label="Write failed" hint={writeError}>
            <span className="text-xs text-accent">not saved</span>
          </Row>
        ) : null}
      </Section>

      <Section title="Recorded runs" caption="~/.rennet/benchmarks.jsonl">
        {pending ? (
          <Row label="History" hint="reading the archive">
            <span className="text-xs text-ink-soft">Loading…</span>
          </Row>
        ) : error ? (
          <Row label="History" hint={errorText(error)}>
            <span className="text-xs text-accent">unavailable</span>
          </Row>
        ) : runs.length === 0 ? (
          <Row
            label="No runs recorded yet"
            hint={
              recording
                ? "A record lands the first time a Repo Map builds or a generation settles."
                : "Recording is off, so nothing new is being written."
            }
          >
            <span className="text-xs text-ink-faint">—</span>
          </Row>
        ) : (
          <div className="py-1">
            {MODE_ORDER.filter((mode) => byMode.has(mode)).map((mode) => {
              const modeRuns = byMode.get(mode) ?? [];
              return (
                <section key={mode} data-benchmark-mode={mode} className="py-1">
                  <h3 className="flex items-baseline gap-2 py-1 text-xs font-medium text-ink">
                    {BENCHMARK_MODE_LABEL[mode]}
                    <span className="text-2xs font-normal text-ink-faint">
                      {modeRuns.length} {modeRuns.length === 1 ? "run" : "runs"} ·{" "}
                      {[...new Set(modeRuns.map((run) => KIND_LABEL[run.kind]))].join(", ")}
                    </span>
                  </h3>
                  {modeRuns.map((run) => (
                    <RunRow key={run.id} run={run} />
                  ))}
                </section>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}
