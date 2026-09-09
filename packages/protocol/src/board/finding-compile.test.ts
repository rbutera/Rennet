import { describe, expect, it } from "vitest";
import {
  COMPILE_AGREEMENTS,
  type CompileAgreement,
  expandFindingCompile,
  FINDING_ORIGINS,
  flaggedOriginAuthor,
} from "./finding-compile";

// Decision 10: the compiler authors flat `origin` + `agreement`, and the host expands them
// into the nested `author` / `concurrence` / `accord` the flat-input rule forbids authoring.
// The map is deliberately not the schema's accord vocabulary — these assertions pin the
// non-identity rows (`diverge → conflict`, `solo → split`) that would otherwise read as bugs.
describe("expandFindingCompile", () => {
  it("concur is both models agreeing, accord concur", () => {
    const e = expandFindingCompile("claude", "concur");
    expect(e.author).toEqual({ kind: "lens-agent", id: "lens:flagged:claudeAgent" });
    expect(e.accord).toBe("concur");
    expect(e.concurrence).toEqual([
      { model: "Claude", agree: 1, total: 1 },
      { model: "Codex", agree: 1, total: 1 },
    ]);
  });

  it("diverge is both models at a different verdict, accord conflict", () => {
    const e = expandFindingCompile("codex", "diverge");
    expect(e.author).toEqual({ kind: "lens-agent", id: "lens:flagged:codex" });
    expect(e.accord).toBe("conflict");
    // Both tallies, origin first: the disagreement is between two voices that both raised it.
    expect(e.concurrence).toEqual([
      { model: "Codex", agree: 1, total: 1 },
      { model: "Claude", agree: 1, total: 1 },
    ]);
  });

  it("solo is one model only, accord split, one tally", () => {
    const e = expandFindingCompile("codex", "solo");
    expect(e.author).toEqual({ kind: "lens-agent", id: "lens:flagged:codex" });
    expect(e.accord).toBe("split");
    expect(e.concurrence).toEqual([{ model: "Codex", agree: 1, total: 1 }]);
  });

  it("every origin maps to a distinct lens-agent author", () => {
    const ids = FINDING_ORIGINS.map((o) => flaggedOriginAuthor(o).id);
    expect(new Set(ids).size).toBe(FINDING_ORIGINS.length);
    for (const id of ids) expect(id.startsWith("lens:flagged:")).toBe(true);
  });

  it("every agreement yields a tally with at least the origin and a known accord", () => {
    for (const agreement of COMPILE_AGREEMENTS as readonly CompileAgreement[]) {
      const e = expandFindingCompile("claude", agreement);
      expect(e.concurrence.length).toBeGreaterThanOrEqual(1);
      expect(e.concurrence[0]?.model).toBe("Claude");
      expect(["concur", "split", "conflict"]).toContain(e.accord);
    }
  });
});
