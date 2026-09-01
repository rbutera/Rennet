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
    subject: { label: "rennet", repoKey: "rennet" },
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
