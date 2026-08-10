import type { FindingElement, FindingSeverity } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANCHOR_PROXIMITY,
  NO_CONCERN_ANSWER,
  reconcileFindings,
} from "./finding-reconcile";

const LABELS = { a: "Claude", b: "Codex" } as const;

function f(
  findingId: string,
  anchor: string,
  summary: string,
  severity: FindingSeverity,
): FindingElement {
  // Each seat's runner owns the concur 1/1 vote; reconcile REPLACES it.
  return {
    findingId,
    anchor,
    summary,
    severity,
    agreement: { kind: "concur", agree: 1, total: 1 },
  };
}

const ANCHOR = "rennet:hunk/h1#L10-L14@additions";

describe("reconcileFindings — dual-model agreement/disagreement (#41)", () => {
  it("folds a same-anchor, comparable-severity pair into ONE concur row (2 of 2)", () => {
    const seatA = [f("a1", ANCHOR, "off-by-one on the loop bound", "high")];
    const seatB = [f("b1", ANCHOR, "the loop can overrun by one", "high")];
    const out = reconcileFindings(seatA, seatB, LABELS);
    expect(out).toHaveLength(1);
    expect(out[0]?.agreement).toEqual({ kind: "concur", agree: 2, total: 2 });
    expect(out[0]?.severity).toBe("high");
  });

  it("keeps the CLEARER (longer) summary and the HIGHER severity on a concur row", () => {
    const seatA = [f("a1", ANCHOR, "short", "medium")];
    const seatB = [
      f("b1", ANCHOR, "a much longer and clearer explanation of the same bug", "high"),
    ];
    const out = reconcileFindings(seatA, seatB, LABELS);
    expect(out).toHaveLength(1);
    expect(out[0]?.summary).toBe("a much longer and clearer explanation of the same bug");
    expect(out[0]?.severity).toBe("high"); // higher of medium/high
    expect(out[0]?.findingId).toBe("b1"); // id follows the kept summary
  });

  it("matches within the proximity window and splits beyond it", () => {
    const near = reconcileFindings(
      [f("a1", "rennet:hunk/h1#L10@additions", "x", "medium")],
      [f("b1", "rennet:hunk/h1#L12@additions", "y", "medium")], // gap 2 ≤ 3
      LABELS,
    );
    expect(near).toHaveLength(1);
    expect(near[0]?.agreement.kind).toBe("concur");

    const far = reconcileFindings(
      [f("a1", "rennet:hunk/h1#L10@additions", "x", "medium")],
      [f("b1", "rennet:hunk/h1#L40@additions", "y", "medium")], // gap 30 > 3
      LABELS,
    );
    expect(far).toHaveLength(2);
    expect(far.every((row) => row.agreement.kind === "disagree")).toBe(true);
  });

  it("treats different offered ids and different sides as different locations (solos)", () => {
    const diffId = reconcileFindings(
      [f("a1", "rennet:hunk/h1#L10@additions", "x", "high")],
      [f("b1", "rennet:hunk/h2#L10@additions", "y", "high")],
      LABELS,
    );
    expect(diffId).toHaveLength(2);
    const diffSide = reconcileFindings(
      [f("a1", "rennet:hunk/h1#L10@additions", "x", "high")],
      [f("b1", "rennet:hunk/h1#L10@deletions", "y", "high")],
      LABELS,
    );
    expect(diffSide).toHaveLength(2);
  });

  it("renders a SOLO (only one seat flagged) as a labelled disagree, other side 'no concern'", () => {
    const soloA = reconcileFindings(
      [f("a1", ANCHOR, "seat A alone flags this", "high")],
      [],
      LABELS,
    );
    expect(soloA).toHaveLength(1);
    expect(soloA[0]?.agreement).toEqual({
      kind: "disagree",
      answers: [
        { model: "Claude", answer: "seat A alone flags this" },
        { model: "Codex", answer: NO_CONCERN_ANSWER },
      ],
    });

    const soloB = reconcileFindings(
      [],
      [f("b1", ANCHOR, "seat B alone flags this", "low")],
      LABELS,
    );
    expect(soloB[0]?.agreement).toEqual({
      kind: "disagree",
      answers: [
        { model: "Claude", answer: NO_CONCERN_ANSWER },
        { model: "Codex", answer: "seat B alone flags this" },
      ],
    });
  });

  it("renders a CONFLICT (same anchor, materially different verdict) as a disagree with BOTH answers", () => {
    // high vs low = rank distance 2 = materially different.
    const seatA = [f("a1", ANCHOR, "this is a critical null deref", "high")];
    const seatB = [f("b1", ANCHOR, "trivial style nit", "low")];
    const out = reconcileFindings(seatA, seatB, LABELS);
    expect(out).toHaveLength(1);
    expect(out[0]?.agreement).toEqual({
      kind: "disagree",
      answers: [
        { model: "Claude", answer: "this is a critical null deref" },
        { model: "Codex", answer: "trivial style nit" },
      ],
    });
    expect(out[0]?.severity).toBe("high"); // ordered by the higher severity
  });

  it("treats ADJACENT severities (high/medium) as comparable → concur, not conflict", () => {
    const out = reconcileFindings(
      [f("a1", ANCHOR, "x", "high")],
      [f("b1", ANCHOR, "y", "medium")],
      LABELS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.agreement.kind).toBe("concur");
  });

  it("matches a span-less anchor against a spanned one at the same unit", () => {
    const out = reconcileFindings(
      [f("a1", "rennet:hunk/h1", "whole-unit concern", "medium")],
      [f("b1", "rennet:hunk/h1#L5@additions", "line concern", "medium")],
      LABELS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.agreement.kind).toBe("concur");
  });

  it("uses the provided labels in every disagreement answer", () => {
    const out = reconcileFindings([f("a1", ANCHOR, "only A", "high")], [], { a: "Opus", b: "Sol" });
    const agreement = out[0]?.agreement;
    if (agreement?.kind !== "disagree") throw new Error("expected disagree");
    expect(agreement.answers.map((x) => x.model)).toEqual(["Opus", "Sol"]);
  });

  // ── The load-bearing invariant: NEVER a third, merged summary (#139/#41) ──────
  it("NEVER mints a merged summary — every row's words are verbatim from ONE seat", () => {
    const seatA = [
      f("a1", "rennet:hunk/h1#L10@additions", "AAA concern one", "high"),
      f("a2", "rennet:hunk/h2#L1@additions", "AAA concern two", "low"),
    ];
    const seatB = [
      f("b1", "rennet:hunk/h1#L11@additions", "BBB concern one", "high"), // concurs with a1
      f("b2", "rennet:hunk/h3#L1@additions", "BBB concern three", "medium"), // solo B
    ];
    const inputSummaries = new Set([...seatA, ...seatB].map((x) => x.summary));
    const out = reconcileFindings(seatA, seatB, LABELS);

    for (const row of out) {
      // A concur/solo/conflict row's HEADLINE summary is always one input verbatim.
      expect(inputSummaries.has(row.summary)).toBe(true);
      if (row.agreement.kind === "disagree") {
        for (const answer of row.agreement.answers) {
          const verbatim = inputSummaries.has(answer.answer) || answer.answer === NO_CONCERN_ANSWER;
          expect(verbatim).toBe(true);
        }
      }
    }
  });

  it("is a pure function of the finding SET — reordering seat A's findings gives the same rows", () => {
    const a1 = f("a1", "rennet:hunk/h1#L10@additions", "one", "high");
    const a2 = f("a2", "rennet:hunk/h2#L1@additions", "two", "medium");
    const seatB = [f("b1", "rennet:hunk/h9#L1@additions", "solo b", "low")];
    const key = (rows: FindingElement[]): string =>
      rows
        .map((r) => `${r.anchor}|${r.summary}|${r.severity}|${r.agreement.kind}`)
        .sort()
        .join("\n");
    const forward = reconcileFindings([a1, a2], seatB, LABELS);
    const reversed = reconcileFindings([a2, a1], seatB, LABELS);
    expect(key(reversed)).toBe(key(forward));
  });

  it("exposes a small, sane default proximity", () => {
    expect(DEFAULT_ANCHOR_PROXIMITY).toBe(3);
  });
});
