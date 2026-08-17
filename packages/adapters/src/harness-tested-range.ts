/**
 * The recorded tested-version ranges (backlog bead 63).
 *
 * `harness-tested-range.json` is the single source of truth for the `min` and
 * `maxTested` an adapter has actually been exercised against. It is COMMITTED and
 * only ever WRITTEN by a real conformance run (`recordTestedRange`), so a
 * descriptor's `testedRange` is derived, never hand-edited — the failure mode the
 * old hand-written `CLAUDE_TESTED_RANGE` constant invited.
 *
 * The JSON is imported statically so it inlines under the bundler (the desktop
 * build) rather than depending on a sibling file at runtime. A real run extends
 * the file on disk via `recordTestedRange`; the committed values are what the
 * next process reads here.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CapabilityName, ConformanceReport, HarnessId } from "@rennet/core";
import { compareVersions } from "./harness-discovery";
import testedRanges from "./harness-tested-range.json";

export interface TestedRange {
  readonly min: string;
  readonly maxTested: string;
}

/** The committed artifact path — the one file a real run records into. */
export const TESTED_RANGE_ARTIFACT_PATH = fileURLToPath(
  new URL("./harness-tested-range.json", import.meta.url),
);

type RecordedRanges = Partial<Record<HarnessId, TestedRange>>;

export interface ExpectedConformanceMatrix {
  readonly passed: readonly CapabilityName[];
  readonly failed: readonly CapabilityName[];
}

/** A tested range is recordable only when every capability matches its expected verdict. */
export function matchesConformanceMatrix(
  report: Pick<ConformanceReport, "passed" | "failed">,
  expected: ExpectedConformanceMatrix,
): boolean {
  const same = (left: readonly CapabilityName[], right: readonly CapabilityName[]): boolean =>
    left.length === right.length &&
    [...left].sort().every((capability, index) => capability === [...right].sort()[index]);
  return same(report.passed, expected.passed) && same(report.failed, expected.failed);
}

/**
 * Read a harness's recorded tested range from the committed artifact. Absent
 * entry (e.g. a harness that has never had a real run) → `null`, so a caller
 * fails honest rather than inventing a range.
 */
export function readTestedRange(id: HarnessId): TestedRange | null {
  const ranges = testedRanges as RecordedRanges;
  return ranges[id] ?? null;
}

/**
 * Extend the recorded ceiling for `id` to `version` if it is above the current
 * `maxTested` (and seed `min` when the harness has no entry yet). Called only by
 * the gated real conformance run, which reads the artifact from disk so a
 * previously-recorded ceiling in the same process is respected. Returns the range
 * as written.
 */
export async function recordTestedRange(id: HarnessId, version: string): Promise<TestedRange> {
  const raw = await readFile(TESTED_RANGE_ARTIFACT_PATH, "utf8");
  const ranges = JSON.parse(raw) as RecordedRanges;
  const current = ranges[id];
  const next: TestedRange = current
    ? {
        min: compareVersions(version, current.min) < 0 ? version : current.min,
        maxTested: compareVersions(version, current.maxTested) > 0 ? version : current.maxTested,
      }
    : { min: version, maxTested: version };
  const updated: RecordedRanges = { ...ranges, [id]: next };
  await writeFile(TESTED_RANGE_ARTIFACT_PATH, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return next;
}
