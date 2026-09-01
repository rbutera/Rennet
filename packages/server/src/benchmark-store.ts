// The benchmark archive (#731, D8). ONE recorder, one durable file: newline-delimited
// runs at `~/.rennet/benchmarks.jsonl`, appended at the moment a measured pipeline ends.
//
// Why an archive rather than reading `Generation.timings` back out of the session store:
// the panel and the export need a HISTORY across sessions and across repo-map builds,
// which no single session carries, and the recording toggle must be able to write nothing
// without disabling the #725 spine that the reveal path depends on. So the spine stays
// unconditional and authoritative, and this file is its append-only projection plus the
// map stages, which have no generation to ride. That is one timing system with an
// archive, not two systems.
//
// Fail-safe on read, like every other store here: a truncated final line (the shape a
// crash mid-append leaves) drops that line and keeps the rest, because losing one run is
// better than a benchmarks panel that refuses to open.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createClientSettingsStore } from "@rennet/adapters";
import { type BenchmarkRun, benchmarkRecordingEnabled, benchmarkRunSchema } from "@rennet/protocol";

/** The archive's file name inside the user data dir. One constant, because the daemon and
 *  the CLI export must address the same file or the export reads an empty history. */
export const BENCHMARK_ARCHIVE_FILE = "benchmarks.jsonl";

export interface BenchmarkStore {
  /** Append one completed (or failed, or aborted) run. */
  record(run: BenchmarkRun): void;
  /** The most recent runs, newest first, capped at `limit`. */
  list(limit: number): BenchmarkRun[];
}

// ponytail: the archive grows unbounded — one line (~1 KB) per measured run, so a heavy
// dogfood year is single-digit MB. Rotate when that stops being true.
export function createBenchmarkStore(filePath: string): BenchmarkStore {
  return {
    record(run) {
      // Parse before writing: a malformed record in the archive would fail the export
      // build later, far from the code that produced it.
      const parsed = benchmarkRunSchema.parse(run);
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, `${JSON.stringify(parsed)}\n`, "utf8");
    },
    list(limit) {
      if (!existsSync(filePath)) return [];
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf8");
      } catch {
        return [];
      }
      const runs: BenchmarkRun[] = [];
      // Walk backwards so a large archive costs only the lines the caller asked for.
      const lines = raw.split("\n");
      for (let index = lines.length - 1; index >= 0 && runs.length < limit; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        const parsed = benchmarkRunSchema.safeParse(value);
        if (parsed.success) runs.push(parsed.data);
      }
      return runs;
    },
  };
}

/**
 * The archive plus the ONE place the recording toggle is enforced. Both producers (the
 * daemon's generation and map recorders, and the daemonless `rennet map`) take their
 * `record` from here, so "recording off writes nothing" is a single check rather than one
 * per call site — and every producer keeps its identical code path either way, which is
 * what makes the toggle observability configuration rather than a branch in the pipeline.
 *
 * Recording is DEFAULT-ON: an untouched or unreadable client-settings file resolves to on,
 * because a measurement that silently stopped would be worse than one nobody asked for.
 */
export function createBenchmarkRecording(dataDir: string): {
  readonly store: BenchmarkStore;
  readonly record: (run: BenchmarkRun) => void;
} {
  const store = createBenchmarkStore(join(dataDir, BENCHMARK_ARCHIVE_FILE));
  const settings = createClientSettingsStore(join(dataDir, "client-settings.json"));
  return {
    store,
    record(run) {
      let enabled = true;
      try {
        enabled = benchmarkRecordingEnabled(settings.readState().config);
      } catch {
        // An unreadable settings file is not a decision to stop measuring.
      }
      if (!enabled) return;
      try {
        store.record(run);
      } catch {
        // Measurement never breaks the thing it measures: an unwritable archive costs a
        // benchmark row, not a review.
      }
    },
  };
}
