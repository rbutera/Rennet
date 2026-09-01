// @vitest-environment happy-dom
//
// The Settings benchmarks panel (#731 9.5–9.6, 9.9). Three properties are load-bearing
// here and each is asserted at the seam that decides it:
//
//  1. The run's mode is DERIVED from its stage records. The fixture serves runs whose
//     harnesses disagree with any imaginable setting, and the panel still sorts them
//     correctly — which it could not do if it were reading a label.
//  2. The panel stays cheap on a long history, and the assertion is on the two DOM counts
//     that decide it rather than on a wall-clock threshold (a timing assertion on CI is a
//     coin toss). RENDERED RUN ROWS must be fewer than the runs served — that is the page,
//     and `content-visibility` never satisfied it because every row stayed mounted — and
//     mounted stage rows must stay at zero until a run is opened, which is `Collapse`
//     unmounting closed children.
//  3. The recording toggle writes and the panel adopts the resolved state.
import type { BenchmarkRun } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { cleanup, mount, waitFor } from "../test/dom";
import { settingsBridge } from "../test/fixtures/settings";
import { PAGE_SIZE } from "./benchmarks";

function generation(
  id: string,
  harnesses: readonly ("claude-code" | "codex")[],
  startedAtMs = 1_700_000_000_000,
): BenchmarkRun {
  return {
    version: 1,
    id,
    kind: "generation",
    subject: { label: id, sessionId: id, generationId: `${id}-g` },
    startedAtMs,
    durationMs: 42_000,
    outcome: "complete",
    stages: [
      { stage: "report", startedAtMs, durationMs: 4_000 },
      ...harnesses.map((harness, index) => ({
        stage: "lens-draft" as const,
        lens: "flagged" as const,
        startedAtMs: startedAtMs + index,
        durationMs: 30_000,
        harness,
        model: harness === "codex" ? "gpt-5" : "opus",
      })),
      { stage: "coverage" as const, startedAtMs: startedAtMs + 35_000, durationMs: 900 },
    ],
  };
}

function stageRows(): number {
  return document.querySelectorAll("[data-slot='benchmark-stage']").length;
}

describe("BenchmarksPage — modes are derived, not read", () => {
  it("sorts a per-seat dual lane under dual-model and single-seat lanes under their own", async () => {
    const { findByText } = mount(
      <RennetRouterApp
        bridge={settingsBridge({
          benchmarks: [
            generation("dual", ["claude-code", "codex"]),
            generation("claude", ["claude-code"]),
            generation("codex", ["codex"]),
          ],
        })}
        history={memoryHistory("/settings/benchmarks")}
      />,
    );
    await findByText("Recorded runs");
    for (const mode of ["dual-model", "claude-only", "codex-only"]) {
      expect(document.querySelector(`[data-benchmark-mode="${mode}"]`)).not.toBeNull();
    }
    // The dual section holds exactly the run whose TWO seat records named both harnesses.
    const dual = document.querySelector("[data-benchmark-mode='dual-model']");
    expect(dual?.textContent).toContain("dual");
    expect(dual?.querySelectorAll("[data-slot='benchmark-run']")).toHaveLength(1);
    cleanup();
  });

  it("shows a lane's per-seat records and its derived dual-review span only when opened", async () => {
    const { user, findByText, getByText } = mount(
      <RennetRouterApp
        bridge={settingsBridge({ benchmarks: [generation("dual", ["claude-code", "codex"])] })}
        history={memoryHistory("/settings/benchmarks")}
      />,
    );
    await findByText("Recorded runs");
    expect(stageRows()).toBe(0);
    await user.click(getByText("dual"));
    await waitFor(() => expect(stageRows()).toBeGreaterThan(0));
    const run = document.querySelector("[data-slot='benchmark-run']");
    // Both seats are named, so the dual review is a statement about records, not a guess.
    expect(run?.textContent).toContain("claude-code");
    expect(run?.textContent).toContain("codex");
    expect(run?.textContent).toContain("dual review");
    cleanup();
  });
});

describe("BenchmarksPage — a long history stays cheap", () => {
  it("renders FEWER rows than it was served, and states both losses", async () => {
    const many = Array.from({ length: 400 }, (_, index) =>
      generation(`run-${index}`, index % 2 === 0 ? ["claude-code"] : ["claude-code", "codex"]),
    );
    const { user, findByText, getByText } = mount(
      <RennetRouterApp
        bridge={settingsBridge({ benchmarks: many })}
        history={memoryHistory("/settings/benchmarks")}
      />,
    );
    await findByText("Recorded runs");
    // THE assertion. 400 recorded, 200 served past the wire cap, one page rendered — the
    // rendered count is below the served count, which is what "the list is windowed"
    // means and what `content-visibility` never did: it left all 200 rows mounted and
    // reconciled, and only skipped painting them.
    const rendered = document.querySelectorAll("[data-slot='benchmark-run']").length;
    expect(rendered).toBe(PAGE_SIZE);
    expect(rendered).toBeLessThan(200);
    // Neither loss is silent: the page states what it is showing out of what exists, and
    // that the wire cap hid the rest.
    await findByText(`Showing ${PAGE_SIZE} of 400 recorded runs`);
    await findByText("The archive holds 400; the newest 200 were served to this panel.");

    // The page ADVANCES rather than merely being small — a panel hard-capped at 25 rows
    // would pass every assertion above while making 375 runs unreachable.
    await user.click(getByText(`Show ${PAGE_SIZE} more`));
    await waitFor(() =>
      expect(document.querySelectorAll("[data-slot='benchmark-run']")).toHaveLength(PAGE_SIZE * 2),
    );

    // …and no stage row is mounted for any collapsed run.
    expect(stageRows()).toBe(0);
    // The positive control: opening ONE run must mount stage rows — otherwise "zero rows"
    // would also pass for a panel that never renders a breakdown at all. Opening one run
    // costs one run's worth of rows, not the history's.
    await user.click(getByText("run-0"));
    await waitFor(() => expect(stageRows()).toBeGreaterThan(0));
    expect(stageRows()).toBeLessThan(12);
    cleanup();
  });

  it("names the archive lines it could not read rather than serving a shorter history", async () => {
    const { findByText } = mount(
      <RennetRouterApp
        bridge={settingsBridge({
          benchmarks: [generation("kept", ["claude-code"])],
          benchmarkSkipped: ["line 4: record version 9 is not one this build reads (1)"],
        })}
        history={memoryHistory("/settings/benchmarks")}
      />,
    );
    await findByText("Recorded runs");
    await findByText("1 archive line could not be read");
    await findByText("line 4: record version 9 is not one this build reads (1)");
    cleanup();
  });
});

describe("BenchmarksPage — the recording toggle", () => {
  it("is on by default and persists an off write the panel then reads back", async () => {
    const { user, findByText } = mount(
      <RennetRouterApp
        bridge={settingsBridge({ benchmarks: [] })}
        history={memoryHistory("/settings/benchmarks")}
      />,
    );
    await findByText("Record benchmarks");
    const toggle = document.querySelector("[aria-label='Record benchmarks']");
    if (!(toggle instanceof HTMLElement)) throw new Error("no recording toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await user.click(toggle);
    await waitFor(() =>
      expect(
        document.querySelector("[aria-label='Record benchmarks']")?.getAttribute("aria-checked"),
      ).toBe("false"),
    );
    // The empty state changes its sentence with the setting — the panel is reading the
    // resolved state back, not remembering its own click.
    await findByText("Recording is off, so nothing new is being written.");
    cleanup();
  });
});
