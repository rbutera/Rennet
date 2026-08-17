import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADJUDICATION_CALIBRATION_ARTIFACT_PATH,
  type AdjudicationCalibration,
  isEmptyAdjudicationCalibration,
  readAdjudicationCalibration,
  recordAdjudicationCalibration,
} from "./adjudication-calibration";

// The committed calibration table (#41): it must PARSE, hold the honest EMPTY shape
// until a real run lands (no invented numbers), and be writable ONLY through the
// recorder. Nothing consumes it as a gate — it is an informational quality signal.

describe("adjudication calibration artifact (#41)", () => {
  it("the committed artifact parses and is the honest empty recorded shape", () => {
    const cal = readAdjudicationCalibration();
    expect(cal.recordedAt).toBeNull();
    expect(cal.classes).toEqual([]);
    expect(cal.binaries).toEqual({});
    expect(isEmptyAdjudicationCalibration(cal)).toBe(true);
  });

  it("points at a real committed file path", () => {
    expect(ADJUDICATION_CALIBRATION_ARTIFACT_PATH).toContain("adjudication-calibration.json");
  });
});

describe("recordAdjudicationCalibration (#41)", () => {
  const scratch = join(tmpdir(), `adj-cal-${process.pid}.json`);
  afterEach(async () => {
    await rm(scratch, { force: true });
  });

  it("records measured numbers with a timestamp and the measured binaries", async () => {
    const written = await recordAdjudicationCalibration({
      binaries: { "claude-code": "2.1.220", codex: "0.9.0" },
      classes: [
        { claimClass: "null-deref", items: 2, overlapCorrect: 1, adjudicationCorrect: 2 },
      ],
      now: new Date("2026-08-17T00:00:00.000Z"),
      path: scratch,
    });
    expect(written.recordedAt).toBe("2026-08-17T00:00:00.000Z");
    expect(written.binaries).toEqual({ "claude-code": "2.1.220", codex: "0.9.0" });
    expect(written.classes[0]?.adjudicationCorrect).toBe(2);

    // The file on disk round-trips.
    const onDisk = JSON.parse(await readFile(scratch, "utf8")) as AdjudicationCalibration;
    expect(onDisk).toEqual(written);
    expect(isEmptyAdjudicationCalibration(onDisk)).toBe(false);
  });
});
