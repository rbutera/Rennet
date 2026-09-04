// @vitest-environment happy-dom
import type { RoundReportBoard as RoundReportBoardModel } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { RENDERERS } from "../board/kinds/renderers";
import { mount } from "../test/dom";
import { prose } from "../test/fixtures/boards/helpers";
import {
  productionShapedOutcome,
  reportBoardFixture,
  roundOutcome,
} from "../test/fixtures/rounds/report-board";
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

  it("holds the outcomes in ONE bordered card, and leaves the greeting section unboxed", () => {
    const { container } = mount(<RoundReportBoard board={reportBoardFixture} />);
    const cards = container.querySelectorAll('[data-kind="report-outcome-card"]');
    // Exactly one card: the Outcomes section. The greeting section is prose, so it stays a
    // plain stack — box it and this reddens, which is the point (the condition is the
    // section's real content, not its title).
    expect(cards).toHaveLength(1);
    const card = cards[0];
    if (!card) throw new Error("missing outcome card");
    expect(card.className).toContain("divide-y");
    expect(card.className).toContain("border-border");
    // All four outcomes live inside it, one padded row each.
    expect(card.querySelectorAll('[data-kind="round_outcome"]')).toHaveLength(4);
    for (const outcome of card.querySelectorAll('[data-kind="round_outcome"]')) {
      expect(outcome.parentElement?.className).toContain("px-4");
      expect(outcome.parentElement?.className).toContain("py-3");
    }
    // And the greeting's prose is NOT inside the card.
    const greeting = container.querySelector('[data-section-id="greeting"]');
    expect(greeting?.querySelector('[data-kind="report-outcome-card"]')).toBeNull();
  });

  // THE SHAPES THE SECTION-LOCAL CARD COULD NOT SEE. The card used to be built by
  // `ReportSection` when EVERY child was a `round_outcome`, so:
  //   - outcomes spread over two sections produced TWO cards ("one card" was never a claim
  //     about the round, only about a section that happened to hold all of them);
  //   - a section mixing a paragraph with outcomes produced NONE, and its outcomes fell out
  //     as loose rows with no frame at all.
  // Both are wire-valid `RoundReportBoard`s — nothing in the schema says outcomes live in
  // exactly one all-outcome section. The card is renderer-owned and board-wide now.
  it("holds outcomes spread across TWO sections in one card, not one card per section", () => {
    const extra = roundOutcome("ro-extra", {
      status: "addressed",
      ask: { ref: "ask-extra", text: "Close the second-section ask." },
      note: "Landed in a section of its own.",
    });
    const split: RoundReportBoardModel = {
      ...reportBoardFixture,
      elements: [
        ...reportBoardFixture.elements,
        extra,
        {
          id: "more-outcomes",
          kind: "section",
          data: {
            author: { kind: "orchestrator", id: "fixture-orchestrator" },
            title: "And also",
            children: ["ro-extra"],
          },
        },
      ],
      sections: [
        ...reportBoardFixture.sections,
        { ref: "more-outcomes", gist: "One more ask.", counts: { round_outcome: 1 } },
      ],
    };
    const { container } = mount(<RoundReportBoard board={split} />);
    const cards = container.querySelectorAll('[data-kind="report-outcome-card"]');
    expect(cards).toHaveLength(1);
    // All FIVE outcomes are inside it — the fifth is not stranded in its own section.
    expect(cards[0]?.querySelectorAll('[data-kind="round_outcome"]')).toHaveLength(5);
    expect(container.querySelectorAll('[data-kind="round_outcome"]')).toHaveLength(5);
  });

  it("cards the outcomes of a MIXED section and keeps its prose rendering in place", () => {
    const mixed: RoundReportBoardModel = {
      ...reportBoardFixture,
      elements: reportBoardFixture.elements.map((el) =>
        el.id === "outcomes" && el.kind === "section"
          ? { ...el, data: { ...el.data, children: ["mixed-prose", ...el.data.children] } }
          : el,
      ),
    };
    mixed.elements = [
      ...mixed.elements,
      prose("mixed-prose", "A paragraph that opens the outcomes section."),
    ];
    const { container } = mount(<RoundReportBoard board={mixed} />);
    const cards = container.querySelectorAll('[data-kind="report-outcome-card"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.querySelectorAll('[data-kind="round_outcome"]')).toHaveLength(4);
    // The prose still renders, in its section, OUTSIDE the card — non-outcome content is
    // left exactly where the producer put it.
    const outcomesSection = container.querySelector('[data-section-id="outcomes"]');
    expect(outcomesSection?.textContent).toContain("A paragraph that opens the outcomes section.");
    expect(cards[0]?.textContent).not.toContain("A paragraph that opens the outcomes section.");
  });

  // POSITIVE CONTROL — the shape that broke the packaged v0.7.1 card. `ask.ref` is a long
  // UNBROKEN serialized ask key and `ask.text` is the finding's WHOLE multi-section
  // instruction. The card renderer built on the short fixtures above never saw this, and on it
  // the header dumped the blob (raw `###`, `#### Inputs`) while the `shrink-0` ref span
  // overflowed the row and starved the title to one word per line. This reddens if either
  // regression returns: restore `shrink-0` on the ref, or render `ask.text` verbatim.
  it("stays readable on production-shaped data: concise title, no raw markdown, bounded ref", () => {
    const board: RoundReportBoardModel = {
      ...reportBoardFixture,
      elements: reportBoardFixture.elements.map((el) =>
        el.id === "ro-observability" ? productionShapedOutcome : el,
      ),
    };
    const { container } = mount(<RoundReportBoard board={board} />);
    const row = container.querySelector('[data-element-id="ro-production"]');
    if (!row) throw new Error("missing production outcome row");

    // The header is the instruction's FIRST line with the leading `###` stripped — a concise
    // title, not the whole finding.
    const title = row.querySelector("[data-outcome-title]");
    expect(title?.textContent).toBe("Ambient commits leak into the ask inventory");

    // No raw markdown leaks anywhere in the rendered row: not the `###` heading, not the
    // `#### Inputs` / `#### Fix` section markers — i.e. the blob is not dumped as the title.
    expect(row.textContent).not.toContain("###");
    expect(row.textContent).not.toContain("#### Inputs");

    // The title can shrink (`min-w-0`) so a long ref can never starve it into per-word wrapping.
    expect(title?.className).toContain("min-w-0");

    // The opaque ref is bounded and shrinkable — never `shrink-0` unbounded, the collapse cause.
    const ref = row.querySelector("[data-ask-ref]");
    expect(ref?.className).not.toContain("shrink-0");
    expect(ref?.className).toContain("truncate");
    expect(ref?.className).toContain("min-w-0");
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
