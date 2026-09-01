import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchmarkRun } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  BENCHMARK_ARCHIVE_FILE,
  createBenchmarkRecording,
  createBenchmarkStore,
} from "./benchmark-store";

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "rennet-benchmarks-"));
}

function run(id: string): BenchmarkRun {
  return {
    version: 1,
    id,
    kind: "repo-map",
    producer: "daemon",
    subject: { label: "rennet", repoKey: "rennet", revision: "deadbeef" },
    startedAtMs: 1000,
    durationMs: 50,
    outcome: "complete",
    stages: [{ stage: "total", startedAtMs: 1000, durationMs: 50 }],
  };
}

describe("the benchmark archive", () => {
  it("appends and reads back newest first, capped at the limit", () => {
    const dir = dataDir();
    const store = createBenchmarkStore(join(dir, BENCHMARK_ARCHIVE_FILE));
    store.record(run("a"));
    store.record(run("b"));
    store.record(run("c"));
    expect(store.list(2).map((entry) => entry.id)).toEqual(["c", "b"]);
    expect(store.list(10).map((entry) => entry.id)).toEqual(["c", "b", "a"]);
  });

  it("drops a torn final line rather than refusing the whole history", () => {
    // The shape a crash mid-append leaves. Losing one run beats a panel that cannot open.
    const dir = dataDir();
    const path = join(dir, BENCHMARK_ARCHIVE_FILE);
    const store = createBenchmarkStore(path);
    store.record(run("a"));
    writeFileSync(path, `${readFileSync(path, "utf8")}{"version":1,"id":"tor`, "utf8");
    expect(store.list(10).map((entry) => entry.id)).toEqual(["a"]);
  });

  it("reads an absent archive as no runs", () => {
    expect(createBenchmarkStore(join(dataDir(), "nothing.jsonl")).list(10)).toEqual([]);
  });

  it("says how many runs the archive HOLDS when the limit hid some (#731 N10)", () => {
    const store = createBenchmarkStore(join(dataDir(), BENCHMARK_ARCHIVE_FILE));
    for (const id of ["a", "b", "c", "d"]) store.record(run(id));
    const read = store.read(2);
    expect(read.runs.map((entry) => entry.id)).toEqual(["d", "c"]);
    // A cap is a loss, and a list that just came back shorter announces nothing.
    expect(read.total).toBe(4);
    expect(read.skipped).toEqual([]);
  });
});

describe("one generation, two attempts (#731 N4)", () => {
  /** What a restart redraft archives: the SAME generation, a later attempt. */
  function generationRun(generationId: string, attempt: number, durationMs: number): BenchmarkRun {
    return {
      version: 1,
      id: `${generationId}:${attempt}`,
      kind: "generation",
      producer: "daemon",
      attempt,
      subject: { label: "s1", sessionId: "s1", generationId },
      startedAtMs: 1000,
      durationMs,
      outcome: "complete",
      stages: [],
    };
  }

  it("keeps a fresh draft and its redraft as two honest, distinguishable records", () => {
    const store = createBenchmarkStore(join(dataDir(), BENCHMARK_ARCHIVE_FILE));
    store.record(generationRun("g1", 0, 40_000));
    store.record(generationRun("g1", 1, 25_000));
    const read = store.read(10);
    // Two records, and each says which attempt it is. The timestamped id they used to
    // carry made these two indistinguishable rows both claiming to be generation g1.
    expect(read.total).toBe(2);
    expect(read.runs.map((entry) => entry.attempt)).toEqual([1, 0]);
    expect(read.runs.map((entry) => entry.durationMs)).toEqual([25_000, 40_000]);
  });

  it("replaces an attempt re-archived under the same identity, newest append winning", () => {
    const store = createBenchmarkStore(join(dataDir(), BENCHMARK_ARCHIVE_FILE));
    store.record(generationRun("g1", 1, 25_000));
    store.record(generationRun("g1", 1, 31_000));
    const read = store.read(10);
    expect(read.total).toBe(1);
    expect(read.runs[0]?.durationMs).toBe(31_000);
  });
});

describe("the archive's version dispatch (#731 N11)", () => {
  it("REPORTS an unreadable interior line instead of quietly serving a shorter history", () => {
    const path = join(dataDir(), BENCHMARK_ARCHIVE_FILE);
    const store = createBenchmarkStore(path);
    store.record(run("a"));
    // An interior line of garbage, then a good one after it — so the damage is genuinely
    // interior rather than the torn tail a crash leaves.
    writeFileSync(path, `${readFileSync(path, "utf8")}{ not json\n`, "utf8");
    store.record(run("b"));

    const read = store.read(10);
    expect(read.runs.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(read.total).toBe(2);
    expect(read.skipped).toHaveLength(1);
    expect(read.skipped[0]).toContain("line 2");
  });

  it("reports a record version this build does not read, naming the versions it does", () => {
    const path = join(dataDir(), BENCHMARK_ARCHIVE_FILE);
    const store = createBenchmarkStore(path);
    store.record(run("a"));
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}${JSON.stringify({ ...run("future"), version: 9 })}\n`,
      "utf8",
    );
    const read = store.read(10);
    expect(read.runs.map((entry) => entry.id)).toEqual(["a"]);
    expect(read.skipped[0]).toContain("version 9");
    expect(read.skipped[0]).toContain("1");
  });

  it("still says NOTHING about a torn final line — the one loss that is expected", () => {
    const path = join(dataDir(), BENCHMARK_ARCHIVE_FILE);
    const store = createBenchmarkStore(path);
    store.record(run("a"));
    writeFileSync(path, `${readFileSync(path, "utf8")}{"version":1,"id":"tor`, "utf8");
    const read = store.read(10);
    expect(read.runs.map((entry) => entry.id)).toEqual(["a"]);
    // The positive control on the silence: the same damage one line EARLIER is reported.
    expect(read.skipped).toEqual([]);
  });
});

describe("the recording toggle (#731 9.5/9.9)", () => {
  it("records by default on an untouched install — no settings file at all", () => {
    const dir = dataDir();
    createBenchmarkRecording(dir).record(run("a"));
    expect(createBenchmarkStore(join(dir, BENCHMARK_ARCHIVE_FILE)).list(10)).toHaveLength(1);
  });

  it("writes NOTHING while recording is off, and resumes when it is turned back on", () => {
    const dir = dataDir();
    const settingsPath = join(dir, "client-settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ version: 1, benchmarks: { record: false } }),
      "utf8",
    );
    const recording = createBenchmarkRecording(dir);
    recording.record(run("a"));
    // Not "an empty archive" — no archive file was created at all.
    expect(existsSync(join(dir, BENCHMARK_ARCHIVE_FILE))).toBe(false);

    // The positive control on the assertion above: with the SAME recorder and the same
    // call, flipping only the setting must produce a record. Without this, "no file"
    // would also pass for a recorder that never worked.
    writeFileSync(
      settingsPath,
      JSON.stringify({ version: 1, benchmarks: { record: true } }),
      "utf8",
    );
    recording.record(run("b"));
    expect(createBenchmarkStore(join(dir, BENCHMARK_ARCHIVE_FILE)).list(10)).toHaveLength(1);
  });

  it("records when the settings file is unreadable — a corrupt file is not a decision", () => {
    const dir = dataDir();
    writeFileSync(join(dir, "client-settings.json"), "{not json", "utf8");
    createBenchmarkRecording(dir).record(run("a"));
    expect(createBenchmarkStore(join(dir, BENCHMARK_ARCHIVE_FILE)).list(10)).toHaveLength(1);
  });
});
