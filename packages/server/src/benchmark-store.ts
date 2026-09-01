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
import {
  BENCHMARK_RECORD_VERSION,
  type BenchmarkRun,
  benchmarkRecordingEnabled,
  benchmarkRunSchema,
} from "@rennet/protocol";

/** The archive's file name inside the user data dir. One constant, because the daemon and
 *  the CLI export must address the same file or the export reads an empty history. */
export const BENCHMARK_ARCHIVE_FILE = "benchmarks.jsonl";

/** What one read of the archive found. `total` and `skipped` exist because a cap and a
 *  corrupt line are both losses, and a list that just came back shorter says neither. */
export interface BenchmarkListing {
  /** The most recent runs, newest first, capped at the requested limit. */
  readonly runs: BenchmarkRun[];
  /** How many distinct runs the archive holds — so a capped read can say it capped. */
  readonly total: number;
  /** Interior lines that could not be read as a run, and why. NOT counted here: a torn
   *  FINAL line, which is what a crash mid-append leaves and is expected. */
  readonly skipped: readonly string[];
}

export interface BenchmarkStore {
  /** Append one completed (or failed, or aborted) run. */
  record(run: BenchmarkRun): void;
  /** The most recent runs, newest first, capped at `limit`, with the counts that say what
   *  the cap and any damage cost. */
  read(limit: number): BenchmarkListing;
  /** The most recent runs, newest first, capped at `limit`. */
  list(limit: number): BenchmarkRun[];
}

/**
 * Which record versions this build can read, and what to do with the rest.
 *
 * Dispatch is EXPLICIT rather than "parse and shrug": a line that fails to parse used to be
 * skipped in silence, so a future record version, a schema tightening, or a genuinely
 * corrupt interior line all looked identical to an archive that simply held fewer runs.
 * The panel showed a shorter history and said nothing, which is the silent-drop failure
 * this codebase keeps re-learning.
 *
 * The one loss that stays silent is a TORN FINAL LINE — an append interrupted by a crash.
 * That is the expected shape of an interrupted write, not damage worth reporting.
 */
const SUPPORTED_VERSIONS: readonly number[] = [BENCHMARK_RECORD_VERSION];

// ponytail: the archive grows unbounded — one line (~1 KB) per measured run, so a heavy
// dogfood year is single-digit MB. Rotate when that stops being true.
export function createBenchmarkStore(filePath: string): BenchmarkStore {
  const store: BenchmarkStore = {
    record(run) {
      // Parse before writing: a malformed record in the archive would fail the export
      // build later, far from the code that produced it.
      const parsed = benchmarkRunSchema.parse(run);
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, `${JSON.stringify(parsed)}\n`, "utf8");
    },
    read(limit) {
      if (!existsSync(filePath)) return { runs: [], total: 0, skipped: [] };
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf8");
      } catch (error) {
        return {
          runs: [],
          total: 0,
          skipped: [`the archive could not be read: ${message(error)}`],
        };
      }
      const runs: BenchmarkRun[] = [];
      const skipped: string[] = [];
      // Every id already returned. A restart redrafts the SAME generation, so the archive
      // can hold two appends of one attempt identity; the LATER one wins, because it is
      // the same attempt measured again rather than a second attempt. Walking backwards
      // means the later one is the one already in hand.
      const seen = new Set<string>();
      let total = 0;
      // Walk backwards so a large archive costs only the lines the caller asked for —
      // except the id/total accounting, which has to see every line to be a count.
      const lines = raw.split("\n");
      // A file ending in the newline `record` writes leaves an empty last element. Anything
      // else there is a torn append, and it is the ONE loss that stays silent.
      const lastIndex = lines.length - 1;
      for (let index = lastIndex; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch (error) {
          if (index !== lastIndex) skipped.push(`line ${index + 1}: not JSON (${message(error)})`);
          continue;
        }
        const version = (value as { version?: unknown })?.version;
        if (typeof version !== "number" || !SUPPORTED_VERSIONS.includes(version)) {
          skipped.push(
            `line ${index + 1}: record version ${String(version)} is not one this build reads (${SUPPORTED_VERSIONS.join(", ")})`,
          );
          continue;
        }
        const parsed = benchmarkRunSchema.safeParse(value);
        if (!parsed.success) {
          if (index !== lastIndex) {
            skipped.push(
              `line ${index + 1}: ${parsed.error.issues[0]?.message ?? "invalid record"}`,
            );
          }
          continue;
        }
        if (seen.has(parsed.data.id)) continue;
        seen.add(parsed.data.id);
        total += 1;
        if (runs.length < limit) runs.push(parsed.data);
      }
      return { runs, total, skipped };
    },
    list(limit) {
      return store.read(limit).runs;
    },
  };
  return store;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
