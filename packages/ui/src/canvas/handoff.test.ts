import type { ComposedHandoffBundle } from "@rennet/types";
import { describe, expect, it } from "vitest";
import type { CollationDraft } from "./collation";
import {
  currentComposition,
  type HeldComposition,
  handoffDispositions,
  handoffStagedSignature,
  runComposition,
} from "./handoff";

function item(overrides: Partial<CollationDraft[number]> & { id: string }): CollationDraft[number] {
  return { path: "src/a.ts", type: "request-change", raw: "add a guard", ...overrides };
}

const DRAFT: CollationDraft = [
  item({ id: "1", path: "src/a.ts", type: "request-change", raw: "add a guard" }),
  item({ id: "2", path: "src/b.ts", type: "comment", raw: "log it" }),
  item({ id: "3", path: "src/c.ts", type: "approve", raw: "looks good" }),
  item({ id: "4", path: "src/d.ts", type: "question", raw: "why?" }),
];

const FAKE_BUNDLE: ComposedHandoffBundle = {
  reviewId: "r1",
  patchsetId: "ps-1",
  tasks: [],
  prompt: "composed",
  digest: "abc",
  composed: true,
  traceMap: {},
};

describe("handoffDispositions", () => {
  it("keeps ONLY the addressed types (request-change, comment)", () => {
    const out = handoffDispositions(DRAFT);
    expect(out.map((d) => d.type).sort()).toEqual(["comment", "request-change"]);
    // approve + question are dropped (a coding agent cannot address them by editing).
    expect(out.some((d) => d.type === "approve")).toBe(false);
    expect(out.some((d) => d.type === "question")).toBe(false);
  });

  it("uses the effective body (refined once present, else raw)", () => {
    const refined: CollationDraft = [item({ id: "1", raw: "raw", refined: "cleaned up" })];
    expect(handoffDispositions(refined)[0]?.body).toBe("cleaned up");
  });
});

describe("handoffStagedSignature", () => {
  it("is stable across a pure reorder (the server re-sorts, so order is not payload)", () => {
    const reordered: CollationDraft = [
      DRAFT[1] as CollationDraft[number],
      DRAFT[0] as CollationDraft[number],
      ...DRAFT.slice(2),
    ];
    expect(handoffStagedSignature(reordered, "ps-1")).toBe(handoffStagedSignature(DRAFT, "ps-1"));
  });

  it("changes when same-path/anchor/type notes are reordered, matching core's stable tie order", () => {
    const tied: CollationDraft = [
      item({ id: "1", raw: "first" }),
      item({ id: "2", raw: "second" }),
    ];
    const reordered: CollationDraft = [
      tied[1] as CollationDraft[number],
      tied[0] as CollationDraft[number],
    ];

    expect(handoffStagedSignature(reordered, "ps-1")).not.toBe(
      handoffStagedSignature(tied, "ps-1"),
    );
  });

  it("changes when a body is reworded", () => {
    const reworded: CollationDraft = [item({ id: "1", raw: "a DIFFERENT ask" }), ...DRAFT.slice(1)];
    expect(handoffStagedSignature(reworded, "ps-1")).not.toBe(
      handoffStagedSignature(DRAFT, "ps-1"),
    );
  });

  it("changes when the active patchset changes (a regeneration)", () => {
    expect(handoffStagedSignature(DRAFT, "ps-2")).not.toBe(handoffStagedSignature(DRAFT, "ps-1"));
  });

  it("changes when an addressed item is withdrawn", () => {
    const fewer: CollationDraft = DRAFT.slice(1);
    expect(handoffStagedSignature(fewer, "ps-1")).not.toBe(handoffStagedSignature(DRAFT, "ps-1"));
  });
});

describe("currentComposition / runComposition — never present or pass a stale composition", () => {
  const signature = handoffStagedSignature(DRAFT, "ps-1");
  const held: HeldComposition = { signature, bundle: FAKE_BUNDLE };

  it("returns the bundle when the signature matches", () => {
    expect(currentComposition(held, signature)).toBe(FAKE_BUNDLE);
    expect(runComposition(held, signature)).toBe(FAKE_BUNDLE);
  });

  it("returns undefined when the staged set changed (stale)", () => {
    const staleSignature = handoffStagedSignature(
      [item({ id: "1", raw: "changed" }), ...DRAFT.slice(1)],
      "ps-1",
    );
    expect(currentComposition(held, staleSignature)).toBeUndefined();
    // The run seam must NOT pass a stale composition (design D2, task 3.5).
    expect(runComposition(held, staleSignature)).toBeUndefined();
  });

  it("returns undefined when nothing is held", () => {
    expect(currentComposition(undefined, signature)).toBeUndefined();
    expect(runComposition(undefined, signature)).toBeUndefined();
  });
});
