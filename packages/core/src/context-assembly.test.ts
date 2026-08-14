import { describe, expect, it } from "vitest";
import { assembleContext, type ContextDocumentInput } from "./context-assembly";

const CLAUDE_DOC: ContextDocumentInput = {
  source: "claude-md",
  sourcePath: "CLAUDE.md",
  content: "line-a1\nline-a2\nline-a3",
};
const AGENTS_DOC: ContextDocumentInput = {
  source: "agents-md",
  sourcePath: "AGENTS.md",
  content: "line-b1\nline-b2",
};
const MAP_DOC: ContextDocumentInput = {
  source: "project-map",
  sourcePath: "(map)",
  content: "scope @x/core\nscope @x/app",
};
const DOCS: ContextDocumentInput[] = [CLAUDE_DOC, AGENTS_DOC, MAP_DOC];

describe("assembleContext — deterministic, byte-budgeted assembly (issue #30)", () => {
  it("is deterministic: identical inputs → byte-identical text + digest (the golden)", () => {
    const first = assembleContext(DOCS, 10_000);
    const second = assembleContext(DOCS, 10_000);
    expect(first.text).toBe(second.text);
    expect(first.digest).toBe(second.digest);
    // Every document included whole under a generous budget.
    expect(first.documents.map((d) => d.state)).toEqual(["included", "included", "included"]);
    expect(first.documents.map((d) => d.order)).toEqual([0, 1, 2]);
    // Each source is labelled in the text (repo guidance flows without ceremony).
    expect(first.text).toContain("### claude-md — CLAUDE.md");
    expect(first.text).toContain("### agents-md — AGENTS.md");
  });

  it("an ordering change reddens the golden: reordered inputs → a different digest", () => {
    const forward = assembleContext(DOCS, 10_000);
    const reordered = assembleContext([AGENTS_DOC, CLAUDE_DOC, MAP_DOC], 10_000);
    expect(reordered.digest).not.toBe(forward.digest);
    // The order positions follow the composition order, not the original identity.
    expect(reordered.documents[0]?.sourcePath).toBe("AGENTS.md");
    expect(reordered.documents[0]?.order).toBe(0);
  });

  it("over-budget assembly cuts at section boundaries and records every cut with byte counts", () => {
    const longAgents = {
      ...AGENTS_DOC,
      content: Array.from({ length: 20 }, (_, i) => `line-b${String(i).padStart(2, "0")}`).join(
        "\n",
      ),
    };
    // Budget fits the first section whole and a marked one-line slice of the second.
    const firstSection = `### ${CLAUDE_DOC.source} — ${CLAUDE_DOC.sourcePath}\n${CLAUDE_DOC.content}`;
    const originalBytes = new TextEncoder().encode(longAgents.content).length;
    const kept = "line-b00";
    const keptBytes = new TextEncoder().encode(kept).length;
    const secondPrefix = `\n\n### ${longAgents.source} — ${longAgents.sourcePath}\n${kept}\n[truncated ${originalBytes - keptBytes} of ${originalBytes} bytes at section boundary]`;
    const budget = new TextEncoder().encode(firstSection + secondPrefix).length;
    const result = assembleContext([CLAUDE_DOC, longAgents, MAP_DOC], budget);

    const [d0, d1, d2] = result.documents;
    expect(d0?.state).toBe("included");
    expect(d0?.bytes).toBe(d0?.originalBytes);

    expect(d1?.state).toBe("truncated");
    expect(d1?.bytes).toBeGreaterThan(0);
    expect(d1?.bytes).toBeLessThan(d1?.originalBytes ?? 0);
    // The cut is visible in the assembled text.
    expect(result.text).toContain("truncated");
    expect(result.text).toContain("at section boundary");

    expect(d2?.state).toBe("dropped");
    expect(d2?.bytes).toBe(0);
    expect(d2?.originalBytes).toBeGreaterThan(0);
    // No framing remains for a drop marker, so it is recorded without overrunning
    // the budget (the dedicated tiny-budget case below proves a fitting marker).
    expect(result.text).not.toContain("(project-map)");

    // totalBytes is the real UTF-8 length, including headers/separators/markers.
    expect(result.totalBytes).toBe(new TextEncoder().encode(result.text).length);
    expect(result.totalBytes).toBeLessThanOrEqual(budget);
  });

  it("records a content hash over the ORIGINAL bytes, stable under truncation", () => {
    const longDoc = {
      ...CLAUDE_DOC,
      content: Array.from({ length: 20 }, (_, i) => `line-a${String(i).padStart(2, "0")}`).join(
        "\n",
      ),
    };
    const whole = assembleContext([longDoc], 10_000);
    const originalBytes = new TextEncoder().encode(longDoc.content).length;
    const kept = "line-a00";
    const keptBytes = new TextEncoder().encode(kept).length;
    const markedPrefix = `### claude-md — CLAUDE.md\n${kept}\n[truncated ${originalBytes - keptBytes} of ${originalBytes} bytes at section boundary]`;
    const tiny = assembleContext([longDoc], new TextEncoder().encode(markedPrefix).length);
    // The hash identifies the source content, not the assembled slice.
    expect(tiny.documents[0]?.contentHash).toBe(whole.documents[0]?.contentHash);
    expect(tiny.documents[0]?.originalBytes).toBe(whole.documents[0]?.originalBytes);
    expect(tiny.documents[0]?.state).toBe("truncated");
  });

  it("charges every framing byte to the budget and reports the final UTF-8 length", () => {
    const longDoc = { ...CLAUDE_DOC, content: "x".repeat(200) };
    const dropped = `### claude-md — CLAUDE.md\n[dropped 200 bytes — over byte budget]`;
    const tinyBudget = new TextEncoder().encode(dropped).length;
    const tiny = assembleContext([longDoc], tinyBudget);
    expect(tiny.text).toBe(dropped);
    expect(tiny.totalBytes).toBe(tinyBudget);
    expect(tiny.totalBytes).toBe(new TextEncoder().encode(tiny.text).length);
    expect(tiny.documents[0]?.state).toBe("dropped");

    const zero = assembleContext([longDoc], 0);
    expect(zero.text).toBe("");
    expect(zero.totalBytes).toBe(0);
  });
});
