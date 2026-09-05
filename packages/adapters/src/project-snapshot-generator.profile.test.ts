// The snapshot-generator PROFILING HARNESS. Not a gate — it asserts almost nothing.
// It exists so the next person to ask "why does opening a big repo take so long?"
// can get the same numbers I did instead of re-deriving them.
//
// Run it:
//   pnpm nx run rennet-adapters:snapshot-profile
//   RENNET_SNAPSHOT_PROFILE=1 RENNET_SNAPSHOT_CPUPROF=1 \
//     pnpm exec vitest run packages/adapters/src/project-snapshot-generator.profile.test.ts
//
// Knobs (all env, all optional):
//   RENNET_SNAPSHOT_PROFILE=1   the switch — the suite is skipped without it, so it
//                               costs nothing in `rennet-adapters:test`.
//   RENNET_SNAPSHOT_PROFILE_RUNS   how many full generations to time (default 3).
//   RENNET_SNAPSHOT_PROFILE_REPO   which checkout to map (default: this one).
//   RENNET_SNAPSHOT_CPUPROF=1   also write a `.cpuprofile` for the LAST run, via the
//                               in-process inspector — so it works under any vitest
//                               pool, with no `--cpu-prof` execArgv plumbing.
//
// It reads the live checkout, so like the dogfood suite its verdict depends on state
// no Nx input can hash. That is why its target is `cache: false` and why the switch
// is a declared `testEnv` input in packages/adapters/project.json.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GitExec } from "./git-range-diff";
import { execaGit } from "./git-range-diff";
import { ProjectSnapshotGenerator, type SnapshotBuildStage } from "./project-snapshot-generator";
import { ProjectSnapshotStore } from "./project-snapshot-store";

const ENABLED = process.env.RENNET_SNAPSHOT_PROFILE === "1";

const STAGES: readonly SnapshotBuildStage[] = [
  "resolve",
  "tree",
  "workspace",
  "conventions",
  "symbols",
  "build",
  "verify",
  "store",
];

/** A git runner that records every invocation's subcommand and wall time. */
function instrumentGit(inner: GitExec): {
  git: GitExec;
  calls: { command: string; ms: number }[];
} {
  const calls: { command: string; ms: number }[] = [];
  const git: GitExec = async (root, args, options) => {
    const started = performance.now();
    try {
      return await inner(root, args, options);
    } finally {
      calls.push({ command: args[0] ?? "?", ms: performance.now() - started });
    }
  };
  return { git, calls };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((l, r) => l - r);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function ms(value: number): string {
  return `${value.toFixed(0).padStart(7)} ms`;
}

interface RunTiming {
  readonly total: number;
  readonly stages: ReadonlyMap<SnapshotBuildStage, number>;
  readonly gitCalls: number;
  readonly gitMs: number;
  readonly gitByCommand: ReadonlyMap<string, { count: number; ms: number }>;
  readonly files: number;
  readonly parsed: number;
}

describe.skipIf(!ENABLED)("ProjectSnapshotGenerator — profile over the REAL rennet repo", () => {
  it("times a clean full snapshot, per stage", async () => {
    const repoRoot =
      process.env.RENNET_SNAPSHOT_PROFILE_REPO ?? join(import.meta.dirname, "../../..");
    const runs = Number(process.env.RENNET_SNAPSHOT_PROFILE_RUNS ?? "3");
    const scratch: string[] = [];
    const timings: RunTiming[] = [];

    for (let run = 0; run < runs; run += 1) {
      const storeDir = mkdtempSync(join(tmpdir(), "rennet-snapgen-profile-"));
      scratch.push(storeDir);
      const store = new ProjectSnapshotStore(storeDir);
      const { git, calls } = instrumentGit(execaGit);

      // Stage boundaries: a stage runs from its FIRST progress event to the first
      // event of the next stage. The last stage runs to completion. Anything the
      // generator does before the first `resolve` event is charged to `resolve`.
      const marks: { stage: SnapshotBuildStage; at: number }[] = [];
      const profiler =
        process.env.RENNET_SNAPSHOT_CPUPROF === "1" && run === runs - 1 ? new Session() : null;
      if (profiler) {
        profiler.connect();
        await profiler.post("Profiler.enable");
        await profiler.post("Profiler.start");
      }

      const started = performance.now();
      const result = await new ProjectSnapshotGenerator({ git, store }).generate(repoRoot, {
        explicitBaseRef: "HEAD",
        previousSymbols: [],
        previousReferences: [],
        previousImports: [],
        onProgress: ({ stage }) => {
          if (marks.at(-1)?.stage !== stage) marks.push({ stage, at: performance.now() });
        },
      });
      const total = performance.now() - started;

      if (profiler) {
        const { profile } = await profiler.post("Profiler.stop");
        const out = join(tmpdir(), `rennet-snapgen-${Date.now()}.cpuprofile`);
        writeFileSync(out, JSON.stringify(profile));
        profiler.disconnect();
        console.log(`\ncpu profile written to ${out}`);
      }

      const stages = new Map<SnapshotBuildStage, number>();
      for (const [index, mark] of marks.entries()) {
        const end = marks[index + 1]?.at ?? started + total;
        stages.set(mark.stage, (stages.get(mark.stage) ?? 0) + (end - mark.at));
      }
      const gitByCommand = new Map<string, { count: number; ms: number }>();
      for (const call of calls) {
        const entry = gitByCommand.get(call.command) ?? { count: 0, ms: 0 };
        entry.count += 1;
        entry.ms += call.ms;
        gitByCommand.set(call.command, entry);
      }
      timings.push({
        total,
        stages,
        gitCalls: calls.length,
        gitMs: calls.reduce((sum, call) => sum + call.ms, 0),
        gitByCommand,
        files: result.fileCount,
        parsed: result.extractedSymbolShards,
      });
      console.log(`run ${run + 1}/${runs}: ${total.toFixed(0)} ms`);
    }

    const first = timings[0];
    if (!first) throw new Error("no runs");
    // The git breakdown comes from ONE run, and it is the run whose total git time is
    // the median — mixing a median total with another run's per-subcommand rows reads
    // as a decomposition of the median and is not one.
    const gitMedian = median(timings.map((timing) => timing.gitMs));
    const medianRun =
      timings.find((timing) => timing.gitMs === gitMedian) ??
      [...timings].sort(
        (l, r) => Math.abs(l.gitMs - gitMedian) - Math.abs(r.gitMs - gitMedian),
      )[0] ??
      first;
    const lines = [
      "",
      `repo: ${repoRoot}`,
      `files in tree: ${first.files}   blobs parsed: ${first.parsed}   runs: ${runs}`,
      "",
      "stage             median      min      max",
    ];
    for (const stage of STAGES) {
      const values = timings.map((timing) => timing.stages.get(stage) ?? 0);
      lines.push(
        `${stage.padEnd(12)} ${ms(median(values))} ${ms(Math.min(...values))} ${ms(Math.max(...values))}`,
      );
    }
    lines.push(
      "",
      `TOTAL        ${ms(median(timings.map((t) => t.total)))}`,
      `git (all)    ${ms(gitMedian)}  in ${medianRun.gitCalls} invocations (median run)`,
    );
    for (const [command, { count, ms: spent }] of [...medianRun.gitByCommand].sort(
      (l, r) => r[1].ms - l[1].ms,
    )) {
      lines.push(`  git ${command.padEnd(9)} ${ms(spent)}  ×${count}`);
    }
    const report = lines.join("\n");
    // Both, deliberately: vitest's console interception is easy to lose in a long
    // run, and a file survives the scrollback.
    const reportPath =
      process.env.RENNET_SNAPSHOT_PROFILE_OUT ?? join(tmpdir(), "rennet-snapgen-profile.txt");
    writeFileSync(reportPath, `${report}\n`);
    process.stdout.write(`${report}\nreport written to ${reportPath}\n`);

    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    // The harness is a measurement, not a gate: the only thing it asserts is that it
    // measured a real snapshot of a real repo, so a silent no-op cannot read as a win.
    expect(first.files).toBeGreaterThan(100);
    expect(first.parsed).toBeGreaterThan(100);
  }, 900000);
});
