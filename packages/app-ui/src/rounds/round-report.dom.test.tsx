// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { RENDERERS } from "../board/kinds/renderers";
import { mount } from "../test/dom";
import { reportBoardFixture } from "../test/fixtures/rounds/report-board";
import type { ReportRegistry } from "./report-registry";
import { RoundReportBoard } from "./round-report";

// Cluster 2's report board — a `LensBoard` (greeting + `round_outcome` items) rendered
// through the report registry, the widened twin of C5's element registry. These tests
// cover the reader-facing shape (greeting, one row per outcome, the right pill, the
// derived tally, code_ref reveal) AND the type-level totality positive control.

describe("RoundReportBoard — the round report as a board", () => {
  it("renders the greeting prose and one row per outcome, each with its status pill", () => {
    const { container } = mount(<RoundReportBoard board={reportBoardFixture} />);
    // The greeting prose fills the surface (reuses the `prose` renderer, unchanged).
    expect(container.textContent).toContain("Token refresh exits are now observable");
    expect(container.textContent).toContain(
      "Every terminal path now leaves a typed record without retaining credentials.",
    );
    // Four outcomes, one of each status, each wearing its status pill.
    const outcomes = container.querySelectorAll('[data-kind="round_outcome"]');
    expect(outcomes).toHaveLength(4);
    for (const status of ["addressed", "partial", "untouched", "beyond"]) {
      const row = container.querySelector(`[data-status="${status}"]`);
      expect(row, `${status} outcome present`).not.toBeNull();
      // The pill text is the status itself.
      expect(row?.textContent).toContain(status);
    }
  });

  it("derives the status tally from the board's outcomes, never stored", () => {
    const { getByTestId } = mount(<RoundReportBoard board={reportBoardFixture} />);
    expect(getByTestId("report-tally").textContent).toBe(
      "1 addressed · 1 partial · 1 untouched · 1 beyond",
    );
  });

  it("reveals a code_ref only for the one outcome that carries one", () => {
    const { container } = mount(<RoundReportBoard board={reportBoardFixture} />);
    // Only the `addressed` outcome carries `ro-cr-observability` ⇒ exactly one reveal chip.
    const chips = container.querySelectorAll('button[title^="Show "]');
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toContain("github-auth.ts:53-63");
    // And it belongs to the addressed row, not another.
    const addressed = container.querySelector('[data-status="addressed"]');
    expect(addressed?.querySelector('button[title^="Show "]')).not.toBeNull();
  });
});

// Positive control (task 2.4 / 9.2a) — the report registry is TOTAL. `ReportRegistry` is
// `Record<ReportKind, …>`, so a map omitting a kind is not assignable. C5's lens
// `RENDERERS` lacks `round_outcome`, so assigning it to `ReportRegistry` MUST fail. If it
// ever compiled (the invariant broken — round_outcome no longer required), this
// `@ts-expect-error` would become an unused directive and BREAK typecheck. Flip it once
// (drop the directive) to watch it go red; that is the control genuinely failing.
// @ts-expect-error — the lens RENDERERS lacks `round_outcome`, so it is not a ReportRegistry.
const _totalityControl: ReportRegistry = { ...RENDERERS };
void _totalityControl;
