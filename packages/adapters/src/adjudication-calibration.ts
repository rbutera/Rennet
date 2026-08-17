/**
 * The recorded cross-harness adjudication calibration table (issue #41).
 *
 * `adjudication-calibration.json` is the committed artifact #41's acceptance criterion
 * asks for: per claim class, how often RAW overlap vs EXPLICIT adjudication matched the
 * seeded ground truth. It follows the `harness-tested-range.json` pattern exactly — it
 * is COMMITTED and only ever WRITTEN by the gated real calibration run
 * (`recordCommittedAdjudicationCalibration`), so its numbers are MEASURED, never hand-edited.
 * Until a genuine run lands it holds the honest EMPTY shape (`recordedAt: null`, no
 * classes) — an absent measurement announces itself rather than inventing numbers.
 *
 * ⚠️ It is an INFORMATIONAL quality signal ONLY. No code path consumes it to gate
 * rendering, publishing, or seat selection (Rule Zero) — a docs page cites it, nothing
 * branches on it.
 */

import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import committed from "./adjudication-calibration.json";

/** One class's recorded calibration: raw counts, never percentages dressed as significance. */
export interface ClassCalibrationRecord {
  readonly claimClass: string;
  readonly items: number;
  readonly overlapCorrect: number;
  readonly adjudicationCorrect: number;
}

export interface AdjudicationCalibration {
  /** ISO timestamp of the real run that recorded this, or null for the honest empty shape. */
  readonly recordedAt: string | null;
  /** The installed binary versions the run measured against (empty until a real run). */
  readonly binaries: Readonly<Record<string, string>>;
  readonly classes: readonly ClassCalibrationRecord[];
}

/**
 * The committed artifact path — the one file a real run records into. Lazy for the
 * same reason as `testedRangeArtifactPath`: the bundled asset URL is a `data:` URI
 * and an eager `fileURLToPath` on it crashes the packaged main at import time.
 */
export function adjudicationCalibrationArtifactPath(): string {
  return fileURLToPath(new URL("./adjudication-calibration.json", import.meta.url));
}

/** Read the committed calibration table. Statically imported so it inlines under the bundler. */
export function readAdjudicationCalibration(): AdjudicationCalibration {
  return committed as AdjudicationCalibration;
}

/** True when the table is the honest empty shape — no real run has landed yet. */
export function isEmptyAdjudicationCalibration(cal: AdjudicationCalibration): boolean {
  return cal.recordedAt === null && cal.classes.length === 0;
}

interface CalibrationRecordInput {
  readonly binaries: Readonly<Record<string, string>>;
  readonly classes: readonly ClassCalibrationRecord[];
  readonly now?: Date;
}

/** Write a calibration table only to an explicitly named scratch path. */
export async function recordAdjudicationCalibration(
  input: CalibrationRecordInput & { readonly path: string },
): Promise<AdjudicationCalibration> {
  if (input.path === adjudicationCalibrationArtifactPath()) {
    throw new Error("The scratch calibration writer cannot write the committed artifact");
  }
  return record(input, input.path);
}

/** The env-gated real recorder is the only path to the committed artifact. */
export async function recordCommittedAdjudicationCalibration(
  input: CalibrationRecordInput,
): Promise<AdjudicationCalibration> {
  if (process.env.RENNET_LIVE_ADJUDICATION !== "1") {
    throw new Error("Committed adjudication calibration writes require the gated real recorder");
  }
  return record(input, adjudicationCalibrationArtifactPath());
}

async function record(
  input: CalibrationRecordInput,
  path: string,
): Promise<AdjudicationCalibration> {
  const table: AdjudicationCalibration = {
    recordedAt: (input.now ?? new Date()).toISOString(),
    binaries: { ...input.binaries },
    classes: input.classes.map((c) => ({ ...c })),
  };
  await writeAtomically(path, `${JSON.stringify(table, null, 2)}\n`);
  return table;
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
