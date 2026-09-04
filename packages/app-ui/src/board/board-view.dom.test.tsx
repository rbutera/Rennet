// @vitest-environment happy-dom
import type { LensKind } from "@rennet/protocol";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { useRennetStore } from "../store";
import { mount, waitFor } from "../test/dom";
import { fixtureBoardRead } from "../test/fixtures/boards";
import { MemoryBridge } from "../test/memory-bridge";
import { useLensBoards } from "./board-data";
import { LensBoardView } from "./board-view";
import { LensSwitcher } from "./lens-switcher";

// Cluster 6 — the board document, lens switcher, and generation drill-down over the
// fixture generations. gen0 = frozen propose-time Design only; gen1 = all five lenses;
// gen2 = sequence + flagged, carrying deltas (flagged: g2-open reworked, g2-beyond new).

const GENERATIONS = ["gen0", "gen1", "gen2"] as const;

function BoardHarness({
  generation,
  generations,
  initialLens = "flagged",
}: {
  readonly generation: string;
  readonly generations: readonly string[];
  readonly initialLens?: LensKind;
}) {
  const [selectedGeneration, setSelectedGeneration] = useState(generation);
  const [lens, setLens] = useState<LensKind>(initialLens);
  const lenses = useLensBoards("rev-1", selectedGeneration);
  const available = lenses.map((entry) => entry.lens);
  const selectedLens = available.includes(lens) ? lens : (available[0] ?? lens);
  return (
    <>
      <LensSwitcher lenses={lenses} selected={selectedLens} onSelect={setLens} />
      <LensBoardView
        reviewId="rev-1"
        generation={generation}
        selectedGeneration={selectedGeneration}
        lens={lens}
        generations={generations}
        onGenerationSelect={setSelectedGeneration}
      />
    </>
  );
}

async function renderView(
  generation: string,
  generations: readonly string[] = GENERATIONS,
  initialLens: LensKind = "flagged",
) {
  // Boards arrive over `board.read`; the bridge stubs nothing else, so board citations
  // read the honest error the board document renders around (Reconciliation 2).
  const result = mount(
    <BridgeProvider bridge={new MemoryBridge({ "board.read": fixtureBoardRead })}>
      <BoardHarness generation={generation} generations={generations} initialLens={initialLens} />
    </BridgeProvider>,
  );
  await settled(result.container);
  return result;
}

/** Wait out the in-flight board reads, so an assertion sees an ANSWER (a board, an
 *  honest empty, or an error) rather than the pending state. */
async function settled(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector("[data-kind=board-pending]")).toBeNull());
}

const lensOf = (c: HTMLElement) => c.querySelector("article[data-lens]")?.getAttribute("data-lens");

beforeEach(() => useRennetStore.setState({ viewedDelta: { viewedDeltaSections: {} } }));

describe("LensBoardView — board document, switchers, drill-down", () => {
  it("renders durable inapplicable-spec absence without borrowing another lens board", async () => {
    const { container, findByText } = mount(
      <BridgeProvider
        bridge={
          new MemoryBridge({
            "board.read": (input) =>
              input.lens === "design"
                ? { board: null, absence: "no-material" }
                : fixtureBoardRead(input),
          })
        }
      >
        <LensBoardView reviewId="rev-1" generation="gen1" lens="design" />
      </BridgeProvider>,
    );

    expect(await findByText("No Design specification applies to this change.")).toBeTruthy();
    expect(
      await findByText(
        "There is no applicable specification to project into a Design board for this generation.",
      ),
    ).toBeTruthy();
    expect(container.querySelector("[data-kind=board-absent]")).toBeTruthy();
    expect(container.querySelector("article[data-lens]")).toBeNull();
  });

  it("keeps a typed clean result selectable and renders its honest empty state", async () => {
    const { container, findByText } = mount(
      <BridgeProvider
        bridge={
          new MemoryBridge({
            "board.read": (input) =>
              input.lens === "flagged"
                ? { board: null, absence: "no-findings" }
                : fixtureBoardRead(input),
          })
        }
      >
        <BoardHarness generation="gen1" generations={["gen1"]} initialLens="flagged" />
      </BridgeProvider>,
    );

    expect(await findByText("No review findings were found.")).toBeTruthy();
    expect(
      await findByText("No concrete review findings remain for this generation."),
    ).toBeTruthy();
    expect(container.querySelector("[data-lens=flagged]")?.getAttribute("data-absent")).toBe(
      "no-findings",
    );
  });

  it("renders document metadata, structured measure, and a semantic anchored outline", async () => {
    const { container } = await renderView("gen1", GENERATIONS, "design");
    const document = container.querySelector<HTMLElement>("[data-kind=lens-board-view]");
    const article = document?.querySelector("article");
    expect(document?.className).toContain("max-w-[960px]");
    expect(article?.querySelector("h1")?.textContent).toBe("Design");
    expect(article?.querySelector("header p")?.textContent?.length).toBeGreaterThan(0);

    const sections = [...(article?.querySelectorAll("[data-kind=board-section]") ?? [])];
    expect(sections.length).toBeGreaterThan(0);
    expect(article?.querySelectorAll("h2 > button").length).toBe(sections.length);
    expect(sections.every((section) => section.id.length > 0)).toBe(true);
    expect(sections.every((section) => section.className.includes("scroll-mt-6"))).toBe(true);
  });

  it("selects the normal reading measure for a prose board", async () => {
    const { container } = await renderView("gen1", GENERATIONS, "sequence");
    const document = container.querySelector<HTMLElement>("[data-kind=lens-board-view]");
    expect(document?.className).toContain("max-w-[760px]");
    expect(document?.className).not.toContain("max-w-[960px]");
  });

  it("uses h3 card titles and h4 in-card detail headings", async () => {
    const { container, user } = await renderView("gen1", GENERATIONS, "flagged");
    // Both folds are closed on arrival now, and a closed `Collapse` mounts no children, so
    // the headings are asserted along the reader's actual path: open the section, then open
    // the finding. Skip either click and the query finds nothing, which is the whole point.
    const section = container.querySelector<HTMLButtonElement>(
      "[data-kind=board-section] button[aria-expanded]",
    );
    if (!section) throw new Error("no section toggle");
    await user.click(section);
    const title = container.querySelector<HTMLButtonElement>('[data-kind="finding"] h3 > button');
    expect(title).toBeTruthy();
    if (!title) throw new Error("no finding title button");
    await user.click(title);
    expect(container.querySelector('[data-kind="finding"] h4')?.textContent).toContain("Fix");
  });

  it("renders a segment only for lenses present this generation (absent-not-disabled)", async () => {
    const { container } = await renderView("gen2");
    const tabs = container.querySelector("[data-kind=lens-switcher]");
    // gen2 carries sequence + flagged; the other three lenses have no board — no segment.
    expect(tabs?.querySelector("[data-lens=sequence]")).toBeTruthy();
    expect(tabs?.querySelector("[data-lens=flagged]")).toBeTruthy();
    expect(tabs?.querySelector("[data-lens=design]")).toBeNull();
    expect(tabs?.querySelector("[data-lens=decisions]")).toBeNull();
    expect(tabs?.querySelector("[data-lens=noise]")).toBeNull();
  });

  it("keeps a failed lens selectable so its exact generation failure is reachable", async () => {
    const reason = "Sequence output failed schema validation.";
    const { container, user } = mount(
      <BridgeProvider
        bridge={
          new MemoryBridge({
            "board.read": (input) =>
              input.lens === "sequence"
                ? { board: null, failure: reason }
                : fixtureBoardRead(input),
          })
        }
      >
        <BoardHarness generation="gen1" generations={["gen1"]} initialLens="design" />
      </BridgeProvider>,
    );
    await settled(container);

    const failedTab = container.querySelector<HTMLButtonElement>("[data-lens=sequence]");
    expect(failedTab?.getAttribute("data-failed")).toBe("true");
    expect(failedTab?.getAttribute("aria-label")).toBe("Sequence, failed to generate");
    if (!failedTab) throw new Error("failed Sequence lens is not selectable");
    await user.click(failedTab);

    expect(container.querySelector("[data-kind=board-failed]")?.textContent).toContain(reason);
  });

  it.each([
    {
      classification: "retryable" as const,
      saysAnotherAttempt: true,
      title: "tells the reviewer a retryable lens failure can still produce this board",
    },
    {
      classification: "terminal" as const,
      saysAnotherAttempt: false,
      title: "promises no further attempt on a terminal lens failure",
    },
  ])("$title", async ({ classification, saysAnotherAttempt }) => {
    // The two legs are each other's control: the same failure sentence, the same surface,
    // and only the typed account differs — so the extra line is bound to the
    // classification and not to "a lens failed".
    const reason = "Noise output failed schema validation.";
    const { container, user } = mount(
      <BridgeProvider
        bridge={
          new MemoryBridge({
            "board.read": (input) =>
              input.lens === "noise"
                ? {
                    board: null,
                    failure: reason,
                    failureAccount: { attempt: 1, classification },
                  }
                : fixtureBoardRead(input),
          })
        }
      >
        <BoardHarness generation="gen1" generations={["gen1"]} initialLens="design" />
      </BridgeProvider>,
    );
    await settled(container);

    const failedTab = container.querySelector<HTMLButtonElement>("[data-lens=noise]");
    if (!failedTab) throw new Error("failed Noise lens is not selectable");
    await user.click(failedTab);

    const failed = container.querySelector("[data-kind=board-failed]");
    expect(failed?.getAttribute("data-classification")).toBe(classification);
    expect(failed?.textContent).toContain(reason);
    const promise = "Another drafting attempt can still produce this board";
    expect(failed?.textContent?.includes(promise)).toBe(saysAnotherAttempt);
  });

  it("folds every section on every lens, Flagged included, and opens one on click", async () => {
    const { container, user } = await renderView("gen1");
    // Rai, 2026-09-04, retiring R44: the reader arrives at summaries on EVERY lens and
    // opens what they want. Flagged used to be the exception and is no longer one.
    expect(lensOf(container)).toBe("flagged");
    const flagged = [...container.querySelectorAll("[data-kind=board-section]")];
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.every((s) => s.getAttribute("data-open") === "false")).toBe(true);

    // …and folded is a DEFAULT, not a lock: the first section opens on its own toggle.
    // Without this the assertion above is satisfied by a section that can never open.
    const toggle = flagged[0]?.querySelector<HTMLButtonElement>("button[aria-expanded]");
    if (!toggle) throw new Error("no section toggle");
    await user.click(toggle);
    expect(flagged[0]?.getAttribute("data-open")).toBe("true");

    const designTab = container.querySelector<HTMLButtonElement>("[data-lens=design]");
    if (!designTab) throw new Error("no design tab");
    await user.click(designTab);
    expect(lensOf(container)).toBe("design");
    const designSections = [...container.querySelectorAll("[data-kind=board-section]")];
    expect(designSections.length).toBeGreaterThan(0);
    expect(designSections.every((s) => s.getAttribute("data-open") === "false")).toBe(true);
  });

  it("rolls the section deltas up to a lens pip that clears as the sections are viewed", async () => {
    const { container, getByText, user } = await renderView("gen2");
    const flaggedTab = container.querySelector("[data-lens=flagged]");
    const pip = () => flaggedTab?.querySelector("[data-testid=lens-delta-pip]");
    // Two unviewed delta sections (g2-open reworked, g2-beyond new) → the rollup reads 2.
    expect(pip()?.getAttribute("data-delta-count")).toBe("2");

    // Interacting with a delta section marks it viewed (store-driven) and drops the count.
    await user.click(getByText("Still Open"));
    expect(pip()?.getAttribute("data-delta-count")).toBe("1");
    await user.click(getByText("Beyond the Asks"));
    // Both viewed ⇒ the pip is gone entirely.
    expect(pip()).toBeNull();
  });

  it("drills back to a frozen generation's board, marked frozen, through the same seam", async () => {
    const { container, user } = await renderView("gen2", GENERATIONS);
    const gens = container.querySelector("[data-kind=generation-switcher]");
    expect(gens).toBeTruthy();
    // gen2 is live; gen0/gen1 are frozen predecessors (read-only drill targets).
    expect(gens?.querySelector("[data-generation=gen2]")?.getAttribute("data-frozen")).toBeNull();
    const gen0Tab = gens?.querySelector<HTMLButtonElement>("[data-generation=gen0]");
    expect(gen0Tab?.getAttribute("data-frozen")).toBe("true");

    if (!gen0Tab) throw new Error("no gen0 tab");
    await user.click(gen0Tab);
    await settled(container);
    // gen0 carries only the frozen Design board — the board swaps to it, resolved by id.
    expect(lensOf(container)).toBe("design");
    expect(container.querySelector("[data-lens=flagged]")).toBeNull();
  });

  it("hides the generation switcher when there is only one generation", async () => {
    const { container } = await renderView("gen1", ["gen1"]);
    expect(container.querySelector("[data-kind=generation-switcher]")).toBeNull();
  });

  it("fold state does NOT cross board identity when drilling generations (finding 5)", async () => {
    // gen0 and gen1 both carry a Design board whose sections reuse refs (change/design/
    // tasks). Expand a section on gen1's Design, drill to gen0's Design: without a
    // board-identity key the same-ref section keeps gen1's expanded fold state. Keyed by
    // boardId the subtree remounts, so gen0 opens folded (foldAll) as it should.
    const { container, getByText, user } = await renderView("gen1", GENERATIONS);
    const designTab = container.querySelector<HTMLButtonElement>("[data-lens=design]");
    if (!designTab) throw new Error("no design tab");
    await user.click(designTab);
    expect(lensOf(container)).toBe("design");
    const changeSection = () =>
      container.querySelector('[data-kind=board-section][data-section-id="change"]');
    expect(changeSection()?.getAttribute("data-open")).toBe("false"); // foldAll

    await user.click(getByText("The Change")); // expand it on gen1
    expect(changeSection()?.getAttribute("data-open")).toBe("true");

    // Drill to gen0's Design board (same `change` ref, different boardId).
    const gen0Tab = container.querySelector<HTMLButtonElement>(
      "[data-kind=generation-switcher] [data-generation=gen0]",
    );
    if (!gen0Tab) throw new Error("no gen0 tab");
    await user.click(gen0Tab);
    await settled(container);
    expect(lensOf(container)).toBe("design");
    // Remounted, so the reused-ref section is folded again — not gen1's expanded state.
    expect(changeSection()?.getAttribute("data-open")).toBe("false");
  });
});
