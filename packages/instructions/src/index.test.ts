import type { ConventionCatalogue } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  assemblePrompt,
  BASE_CONTRACTS,
  DECOMPOSITION_PROPOSAL_CONTRACT,
  DECOMPOSITION_SKELETON_CONTRACT,
  FORBIDDEN_ORDERING_TERMS,
  LOGICAL_ORDERING_TERMS,
  ORDERING_CONTRACT,
  PROMPT_LAYER_ORDER,
  type PromptLayers,
  renderBaseInstruction,
  renderConventionLayer,
} from "./index";

describe("renderBaseInstruction", () => {
  it("renders all seven slots and is byte-deterministic", () => {
    const first = renderBaseInstruction(DECOMPOSITION_PROPOSAL_CONTRACT);
    const second = renderBaseInstruction(DECOMPOSITION_PROPOSAL_CONTRACT);
    expect(first).toBe(second);
    for (const slot of [
      DECOMPOSITION_PROPOSAL_CONTRACT.role,
      DECOMPOSITION_PROPOSAL_CONTRACT.emit,
      DECOMPOSITION_PROPOSAL_CONTRACT.input,
      DECOMPOSITION_PROPOSAL_CONTRACT.discipline,
      DECOMPOSITION_PROPOSAL_CONTRACT.failureValve,
      DECOMPOSITION_PROPOSAL_CONTRACT.ordering,
      DECOMPOSITION_PROPOSAL_CONTRACT.guidanceSlot,
    ]) {
      expect(first).toContain(slot);
    }
    // The seven headed sections are all present.
    for (const heading of [
      "## Role",
      "## Emit",
      "## Input",
      "## Discipline",
      "## Failure valve",
      "## Ordering",
      "## Guidance",
    ]) {
      expect(first).toContain(heading);
    }
  });

  it("names the docType and version in the header and emit slot", () => {
    const rendered = renderBaseInstruction(DECOMPOSITION_SKELETON_CONTRACT);
    expect(rendered).toContain("decomposition.skeleton@1");
    expect(rendered).toContain("decomposition.skeleton version 1");
  });
});

describe("the ordering slot enforces correction 8", () => {
  it("names logical/first-principles ordering and forbids salience/danger/blast radius", () => {
    for (const contract of [DECOMPOSITION_SKELETON_CONTRACT, DECOMPOSITION_PROPOSAL_CONTRACT]) {
      const ordering = contract.ordering.toLowerCase();
      for (const term of LOGICAL_ORDERING_TERMS) {
        expect(ordering).toContain(term);
      }
      // The slot carries an explicit "do not order by …" prohibition, and each
      // forbidden signal appears only inside that prohibition (after it in the
      // text), never as the directive that leads the slot.
      expect(ordering).toContain("do not order by");
      const prohibitionStart = ordering.indexOf("do not order by");
      const logicalDirective = ordering.indexOf("logical");
      for (const forbidden of FORBIDDEN_ORDERING_TERMS) {
        expect(ordering).toContain(forbidden);
        // The forbidden term sits inside the prohibition, downstream of the
        // logical directive — it is never what the slot tells the agent to do.
        expect(ordering.indexOf(forbidden)).toBeGreaterThan(prohibitionStart);
        expect(logicalDirective).toBeLessThan(prohibitionStart);
      }
    }
  });
});

describe("the ordering contract (issue #9)", () => {
  it("renders ordering@1 with all seven slots", () => {
    const rendered = renderBaseInstruction(ORDERING_CONTRACT);
    expect(rendered).toContain("ordering@1");
    expect(rendered).toContain("ordering version 1");
    for (const slot of [
      ORDERING_CONTRACT.role,
      ORDERING_CONTRACT.emit,
      ORDERING_CONTRACT.input,
      ORDERING_CONTRACT.discipline,
      ORDERING_CONTRACT.failureValve,
      ORDERING_CONTRACT.ordering,
      ORDERING_CONTRACT.guidanceSlot,
    ]) {
      expect(rendered).toContain(slot);
    }
  });

  it("names logical/first-principles ordering and forbids salience/danger/blast radius", () => {
    const ordering = ORDERING_CONTRACT.ordering.toLowerCase();
    for (const term of LOGICAL_ORDERING_TERMS) {
      expect(ordering).toContain(term);
    }
    expect(ordering).toContain("do not order by");
    const prohibitionStart = ordering.indexOf("do not order by");
    const logicalDirective = ordering.indexOf("logical");
    expect(logicalDirective).toBeLessThan(prohibitionStart);
    for (const forbidden of FORBIDDEN_ORDERING_TERMS) {
      expect(ordering).toContain(forbidden);
      expect(ordering.indexOf(forbidden)).toBeGreaterThan(prohibitionStart);
    }
  });

  it("its failure valve emits the baseline rather than dropping a chunk", () => {
    expect(ORDERING_CONTRACT.failureValve.toLowerCase()).toContain("baseline");
  });
});

describe("an instruction never restates the JSON schema", () => {
  it("has no JSON Schema object in any slot", () => {
    for (const contract of Object.values(BASE_CONTRACTS)) {
      const rendered = renderBaseInstruction(contract).toLowerCase();
      // A restated schema would carry these structural tokens; the emit slot only
      // names the docType in prose.
      expect(rendered).not.toContain('"type": "object"');
      expect(rendered).not.toContain('"properties"');
      expect(rendered).not.toContain("additionalproperties");
    }
  });
});

describe("renderConventionLayer (#180)", () => {
  const catalogue: ConventionCatalogue = {
    rules: [
      {
        id: "arch-boundary",
        convention: "file I/O lives only in the adapters package",
        rationale: "the core package must stay pure",
        severity: "high",
        antiPattern: "importing node:fs from packages/core",
      },
      {
        convention: "tests assert the contract, never the implementation",
        rationale: "an implementation-derived assertion only confirms the code",
        severity: "medium",
      },
    ],
  };

  it("renders each convention with its rationale and severity, deterministically", () => {
    const first = renderConventionLayer(catalogue);
    const second = renderConventionLayer(catalogue);
    expect(first).toBe(second);
    expect(first).toContain("1. [high] file I/O lives only in the adapters package");
    expect(first).toContain("why: the core package must stay pure");
    expect(first).toContain("2. [medium] tests assert the contract, never the implementation");
  });

  it("renders the anti-pattern only when the author stated one", () => {
    const rendered = renderConventionLayer(catalogue);
    expect(rendered).toContain("anti-pattern: importing node:fs from packages/core");
    // The second rule has no anti-pattern, so no stray anti-pattern line follows it.
    const secondRuleIdx = rendered.indexOf("2. [medium]");
    expect(rendered.slice(secondRuleIdx)).not.toContain("anti-pattern:");
  });

  it("never renders the author-facing id and carries the report-the-reason rule", () => {
    const rendered = renderConventionLayer(catalogue);
    expect(rendered).not.toContain("arch-boundary");
    expect(rendered).toContain("NEVER a rule id or number");
  });
});

describe("assemblePrompt", () => {
  const layers: PromptLayers = {
    base: renderBaseInstruction(DECOMPOSITION_SKELETON_CONTRACT),
    general: "GENERAL guidance layer",
    angle: "ANGLE guidance layer",
    payload: "PAYLOAD: the offered manifest and the diff",
  };

  it("places the conventions layer after hypothesis and before general in the fixed order", () => {
    const hypIdx = PROMPT_LAYER_ORDER.indexOf("hypothesis");
    const convIdx = PROMPT_LAYER_ORDER.indexOf("conventions");
    const generalIdx = PROMPT_LAYER_ORDER.indexOf("general");
    expect(hypIdx).toBeGreaterThanOrEqual(0);
    expect(convIdx).toBe(hypIdx + 1);
    expect(convIdx).toBeLessThan(generalIdx);
  });

  it("includes a present conventions layer in order and labelled", () => {
    const result = assemblePrompt({
      base: renderBaseInstruction(DECOMPOSITION_SKELETON_CONTRACT),
      conventions: "CONVENTIONS checklist layer",
      payload: "PAYLOAD",
    });
    const order = result.layers.filter((c) => c.included).map((c) => c.layer);
    expect(order).toEqual(["base", "conventions", "payload"]);
    expect(result.text).toContain("<<<rennet:layer conventions>>>");
  });

  it("composes present layers in the fixed order, labelled, deterministically", () => {
    const first = assemblePrompt(layers);
    const second = assemblePrompt(layers);
    expect(first.text).toBe(second.text);
    // Fixed order: base, then general, angle (task/files/context absent), payload.
    const order = first.layers.filter((c) => c.included).map((c) => c.layer);
    expect(order).toEqual(["base", "general", "angle", "payload"]);
    for (const layer of order) {
      expect(first.text).toContain(`<<<rennet:layer ${layer}>>>`);
    }
    expect(first.droppedLayers).toEqual([]);
  });

  it("keeps the base in full and drops later layers under a tight budget", () => {
    const baseBytes = new TextEncoder().encode(`<<<rennet:layer base>>>\n${layers.base}`).length;
    // Budget only fits the base plus a little: general/angle/payload must drop.
    const result = assemblePrompt(layers, { maxBytes: baseBytes + 5 });
    expect(result.text).toContain(layers.base);
    expect(result.droppedLayers.length).toBeGreaterThan(0);
    // The base is never among the dropped layers.
    expect(result.droppedLayers).not.toContain("base");
    // Dropped layers are a suffix of the fixed order (later layers drop first).
    const droppedIndices = result.droppedLayers.map((l) => PROMPT_LAYER_ORDER.indexOf(l));
    const minDropped = Math.min(...droppedIndices);
    const includedAfterMin = result.layers
      .filter((c) => c.included)
      .map((c) => PROMPT_LAYER_ORDER.indexOf(c.layer))
      .filter((i) => i > minDropped);
    expect(includedAfterMin).toEqual([]);
  });
});
