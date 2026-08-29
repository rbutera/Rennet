// @vitest-environment happy-dom
import { LENS_KINDS } from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { useRennetStore } from "../store";
import { mount, waitFor } from "../test/dom";
import { FIXTURE_BOARDS, fixtureBoardRead } from "../test/fixtures/boards";
import { MemoryBridge, refusesSpanRead, SPAN_OUTSIDE_CAPTURE } from "../test/memory-bridge";
import { resolveBoard } from "./board-data";
import { LensBoardView } from "./board-view";

// ─────────────────────────────────────────────────────────────────────────────
// Cluster 9 (packet verification) — the full-fixture-board-set E2E. Cluster 3's
// renderers test proves totality over the flat element POOL; the cluster-4/5/6
// tests each prove one behaviour in isolation. This is the single integrated proof
// the packet's Verification contract names: mount the WHOLE fixture set through the
// REAL `LensBoardView` surface (Section + Collapse + switchers + the registry, not
// the element pool), and assert every registered kind renders and the fold /
// rollup / delta-clear / quote-thread / absent-lens / generation-drill-down
// behaviours all compose in one document. It is a positive control: break the
// registry dispatch, the fold grammar, the delta slice, or the switchers and this
// fails. (The live-B8-board-renders-identically half is cluster 8, gated on B4+B8.)
// ─────────────────────────────────────────────────────────────────────────────

const GENERATIONS = ["gen0", "gen1", "gen2"] as const;

// The registry kinds that render as STANDALONE section children on the real surface.
// Two registry kinds compose INTO their parents rather than dispatching bare:
// `code_ref` (consumed by annotation/decision/finding/message via AnchorReveal/CodeTabs)
// and the inline `section` element (top-level sections are the `board-section` fold).
// Their renderer totality is compile-proven (registry.ts assertNever) and exercised
// standalone by kinds/renderers.dom.test; here code_ref's real-surface presence is
// asserted through its citation UI (the honest-error line) instead of a marker.
const CONTENT_KINDS = [
  "prose",
  "callout",
  "annotation",
  "finding",
  "decision",
  "requirement",
  "order_step",
  "message",
  "noise_verdict",
] as const;

async function renderView(generation: string, generations: readonly string[] = GENERATIONS) {
  // Boards arrive over the real `board.read` command. The span read REFUSES the way the
  // daemon refuses a span outside the captured diff, so this asserts the document renders
  // around a citation's honest refusal — not around a harness artefact.
  const result = mount(
    <BridgeProvider
      bridge={
        new MemoryBridge({ "board.read": fixtureBoardRead, "patchset.readSpan": refusesSpanRead })
      }
    >
      <LensBoardView reviewId="rev-1" generation={generation} generations={generations} />
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

const kindsIn = (root: ParentNode): Set<string> => {
  const found = new Set<string>();
  for (const node of root.querySelectorAll("[data-kind]")) {
    const k = node.getAttribute("data-kind");
    if (k) found.add(k);
  }
  return found;
};

const lensOf = (c: HTMLElement) => c.querySelector("article[data-lens]")?.getAttribute("data-lens");

beforeEach(() => {
  useRennetStore.getState().reviewActions.resetReview();
  useRennetStore.setState({ viewedDelta: { viewedDeltaSections: {} } });
});

describe("board E2E — the full fixture set through the real LensBoardView", () => {
  it("renders every registered content kind across the fixture lenses (real surface, not the pool)", async () => {
    // gen1 carries all five lenses; visiting each mounts its board through the real
    // Section/registry pipeline. Section keeps children mounted while folded (Collapse
    // animates grid-rows), so folded sections still contribute their kinds.
    const { container, user } = await renderView("gen1");
    const seen = new Set<string>();
    // The default (Flagged) lens first, then click through the rest.
    for (const k of kindsIn(container)) seen.add(k);
    for (const lens of ["design", "decisions", "sequence", "noise"] as const) {
      const tab = container.querySelector<HTMLButtonElement>(`[data-lens=${lens}]`);
      if (!tab) throw new Error(`no ${lens} tab on gen1`);
      await user.click(tab);
      expect(lensOf(container)).toBe(lens);
      for (const k of kindsIn(container)) seen.add(k);
    }
    for (const kind of CONTENT_KINDS) expect([kind, seen.has(kind)]).toEqual([kind, true]);
    // The top-level fold grammar is present on the real surface too.
    expect(seen.has("board-section")).toBe(true);
  });

  it("code_ref content flows to the real surface through its citation UI (refusal relayed)", async () => {
    // code_ref never dispatches as a bare child; it composes into decision evidence
    // (CodeTabs) / annotation (AnchorReveal). With the span read refusing, the seam reads the
    // honest error line — proof the code_ref → AnchorReveal → CodeBlock path is live on
    // the real surface, not just in the isolated pool test.
    const { container, user } = await renderView("gen1");
    const decisions = container.querySelector<HTMLButtonElement>("[data-lens=decisions]");
    if (!decisions) throw new Error("no decisions tab");
    await user.click(decisions);
    await waitFor(() =>
      expect(
        container.querySelectorAll(
          "[data-kind=code_ref], [data-kind=annotation], [data-kind=decision]",
        ).length,
      ).toBeGreaterThan(0),
    );
    await waitFor(() => expect(container.textContent).toMatch(new RegExp(SPAN_OUTSIDE_CAPTURE)));
  });

  it("every fixture board round-trips THROUGH the seam (resolveBoard), identity and all", () => {
    // The client never invents board shape: each fixture is parsed BY the seam — not
    // merely inspected — and only a `valid` resolution whose identity matches the
    // requested (generation, lens) yields the board. A partial map (absent lens = no
    // board) resolves `missing`, the switcher's absent-not-disabled contract.
    let valid = 0;
    for (const gen of GENERATIONS) {
      for (const lens of LENS_KINDS) {
        const raw = fixtureBoardRead({ generation: gen, lens }).board;
        const r = resolveBoard(raw, { generation: gen, lens });
        if (raw === null) {
          expect(r.status).toBe("missing");
          continue;
        }
        expect(r.status).toBe("valid");
        if (r.status === "valid") {
          // The seam's parsed output IS the fixture's shape — lens/generation/sections.
          expect(r.board.lens).toBe(lens);
          expect(r.board.generation).toBe(gen);
          expect(r.board.sections.length).toBeGreaterThan(0);
          valid++;
        }
      }
    }
    expect(valid).toBe(8); // gen0:1 + gen1:5 + gen2:2
  });

  it("the seam REJECTS a wrong-lens or wrong-generation board (finding 1 positive controls)", () => {
    // Feed the seam a well-formed board under the wrong identity. Pre-fix these passed
    // (shape-only), rendering a stale/cross-wired board as if it were the one asked for.
    const designGen1 = FIXTURE_BOARDS.gen1?.design;
    const designGen0 = FIXTURE_BOARDS.gen0?.design;
    if (!designGen1 || !designGen0) throw new Error("fixture missing");

    // Right shape, wrong LENS: the design board answered for a sequence request.
    const wrongLens = resolveBoard(designGen1, { generation: "gen1", lens: "sequence" });
    expect(wrongLens.status).toBe("invalid");
    if (wrongLens.status === "invalid") expect(wrongLens.reason).toBe("identity");

    // Right shape, wrong GENERATION: gen0's design board answered for a gen1 request.
    const wrongGen = resolveBoard(designGen0, { generation: "gen1", lens: "design" });
    expect(wrongGen.status).toBe("invalid");
    if (wrongGen.status === "invalid") expect(wrongGen.reason).toBe("identity");
  });

  it("folds: a non-delta lens folds every section to its gist + counts; Flagged opens expanded", async () => {
    const { container, user } = await renderView("gen1");
    expect(lensOf(container)).toBe("flagged"); // R44 default
    expect(
      [...container.querySelectorAll("[data-kind=board-section]")].every(
        (s) => s.getAttribute("data-open") === "true",
      ),
    ).toBe(true);

    const design = container.querySelector<HTMLButtonElement>("[data-lens=design]");
    if (!design) throw new Error("no design tab");
    await user.click(design);
    const sections = [...container.querySelectorAll("[data-kind=board-section]")];
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((s) => s.getAttribute("data-open") === "false")).toBe(true);
    // Folded ⇒ the gist rollup chips are on screen (per-kind counts).
    expect(container.querySelector("[data-kind=board-section] .rounded.bg-secondary")).toBeTruthy();
  });

  it("delta marks: gen2 Flagged opens its delta sections expanded with a gold dot that clears on interaction", async () => {
    const { container, getByText, user } = await renderView("gen2");
    expect(lensOf(container)).toBe("flagged");
    const deltaSections = container.querySelectorAll("[data-kind=board-section][data-delta]");
    expect(deltaSections.length).toBeGreaterThan(0);
    expect([...deltaSections].every((s) => s.getAttribute("data-open") === "true")).toBe(true);
    expect(container.querySelectorAll('[data-testid="delta-dot"]').length).toBe(
      deltaSections.length,
    );

    // The lens pip rolls the section deltas up; interacting clears them store-driven.
    const pip = () => container.querySelector("[data-lens=flagged] [data-testid=lens-delta-pip]");
    expect(pip()?.getAttribute("data-delta-count")).toBe("2");
    await user.click(getByText("Still Open"));
    expect(pip()?.getAttribute("data-delta-count")).toBe("1");
    await user.click(getByText("Beyond the Asks"));
    expect(pip()).toBeNull();
    // Every dot is gone once viewed (store-driven, survives re-render).
    expect(container.querySelectorAll('[data-testid="delta-dot"]').length).toBe(0);
  });

  it("quote threads: an anchored thread renders as a durable highlight over real board prose", async () => {
    // Seed the thread on the real `review` slice BEFORE the lens mounts; the highlight
    // layer reads it wherever that prose renders — here through Section → ProseElement.
    // Scoped to the target element + generation (finding 2), the identity a real
    // selection stamps: the highlight lands on gen1's `change-why` and nowhere else.
    useRennetStore
      .getState()
      .reviewActions.addQuoteComment("Renewal was silent", "why silent?", "comment", {
        target: "change-why",
        generation: "gen1",
      });
    const { container, user } = await renderView("gen1");
    const design = container.querySelector<HTMLButtonElement>("[data-lens=design]");
    if (!design) throw new Error("no design tab");
    await user.click(design);
    const hl = await waitFor(() => {
      const node = container.querySelector<HTMLElement>("[data-kind=prose] [data-quote-highlight]");
      if (!node) throw new Error("no highlight");
      return node;
    });
    expect(hl.textContent).toBe("Renewal was silent");
    await user.click(hl);
    expect(container.textContent).toContain("why silent?");
  });

  it("absent-lens: a lens with no board this generation yields no segment (never disabled)", async () => {
    const { container } = await renderView("gen2");
    const tabs = container.querySelector("[data-kind=lens-switcher]");
    expect(tabs?.querySelector("[data-lens=sequence]")).toBeTruthy();
    expect(tabs?.querySelector("[data-lens=flagged]")).toBeTruthy();
    for (const absent of ["design", "decisions", "noise"] as const) {
      expect(tabs?.querySelector(`[data-lens=${absent}]`)).toBeNull();
    }
  });

  it("generation drill-down: drilling from live gen2 back to frozen gen0 swaps to its read-only board", async () => {
    const { container, user } = await renderView("gen2", GENERATIONS);
    const gens = container.querySelector("[data-kind=generation-switcher]");
    expect(gens?.querySelector("[data-generation=gen2]")?.getAttribute("data-frozen")).toBeNull();
    const gen0 = gens?.querySelector<HTMLButtonElement>("[data-generation=gen0]");
    expect(gen0?.getAttribute("data-frozen")).toBe("true");
    if (!gen0) throw new Error("no gen0 tab");
    await user.click(gen0);
    await settled(container);
    // gen0 = the frozen propose-time Design board only; the document swaps to it by id.
    expect(lensOf(container)).toBe("design");
    expect(container.querySelector("[data-lens=flagged]")).toBeNull();
  });
});
