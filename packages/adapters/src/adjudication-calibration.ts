/**
 * The recorded cross-harness adjudication calibration table (issue #41).
 *
 * `adjudication-calibration.json` is the committed artifact #41's acceptance criterion
 * asks for: per claim class, how often RAW overlap vs EXPLICIT adjudication matched the
 * seeded ground truth. It follows the `harness-tested-range.json` pattern exactly — it
 * is COMMITTED and only ever WRITTEN by the gated real calibration run
 * (`recordAdjudicationCalibration`), so its numbers are MEASURED, never hand-edited.
 * Until a genuine run lands it holds the honest EMPTY shape (`recordedAt: null`, no
 * classes) — an absent measurement announces itself rather than inventing numbers.
 *
 * ⚠️ It is an INFORMATIONAL quality signal ONLY. No code path consumes it to gate
 * rendering, publishing, or seat selection (Rule Zero) — a docs page cites it, nothing
 * branches on it.
 */

import { readFile, writeFile } from "node:fs/promises";
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

/** The committed artifact path — the one file a real run records into. */
export const ADJUDICATION_CALIBRATION_ARTIFACT_PATH = fileURLToPath(
  new URL("./adjudication-calibration.json", import.meta.url),
);

/** Read the committed calibration table. Statically imported so it inlines under the bundler. */
export function readAdjudicationCalibration(): AdjudicationCalibration {
  return committed as AdjudicationCalibration;
}

/** True when the table is the honest empty shape — no real run has landed yet. */
export function isEmptyAdjudicationCalibration(cal: AdjudicationCalibration): boolean {
  return cal.recordedAt === null && cal.classes.length === 0;
}

/**
 * Record a real calibration run into the committed artifact. Called ONLY by the gated
 * `.real` run — the numbers come from driving both installed harnesses over the corpus,
 * scoring overlap vs adjudication against the known truth. Overwrites the file with the
 * measured table; there is no hand-edit path. Returns what was written.
 */
export async function recordAdjudicationCalibration(input: {
  readonly binaries: Readonly<Record<string, string>>;
  readonly classes: readonly ClassCalibrationRecord[];
  /** Injected only in tests to keep the round-trip deterministic; defaults to now. */
  readonly now?: Date;
  /** Injected only in tests so a round-trip does not clobber the committed artifact. */
  readonly path?: string;
}): Promise<AdjudicationCalibration> {
  const table: AdjudicationCalibration = {
    recordedAt: (input.now ?? new Date()).toISOString(),
    binaries: { ...input.binaries },
    classes: input.classes.map((c) => ({ ...c })),
  };
  await writeFile(
    input.path ?? ADJUDICATION_CALIBRATION_ARTIFACT_PATH,
    `${JSON.stringify(table, null, 2)}\n`,
    "utf8",
  );
  return table;
}
