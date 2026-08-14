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
    // The order positions follow the sent order, not the original identity.
    expect(reordered.documents[0]?.sourcePath).toBe("AGENTS.md");
    expect(reordered.documents[0]?.order).toBe(0);
  });

  it("over-budget assembly cuts at section boundaries and records every cut with byte counts", () => {
    // Budget fits the first doc whole, part of the second (one line), none of the third.
    const firstBytes = new TextEncoder().encode(CLAUDE_DOC.content).length;
    const budget = firstBytes + 8; // room for "line-b1" (7 bytes) but not the second line
    const result = assembleContext(DOCS, budget);

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
    // The drop is visible, not silent.
    expect(result.text).toContain("dropped");

    // totalBytes is the sum of assembled bytes and stays within budget.
    expect(result.totalBytes).toBe((d0?.bytes ?? 0) + (d1?.bytes ?? 0));
    expect(result.totalBytes).toBeLessThanOrEqual(budget);
  });

  it("records a content hash over the ORIGINAL bytes, stable under truncation", () => {
    const whole = assembleContext([CLAUDE_DOC], 10_000);
    const tiny = assembleContext([CLAUDE_DOC], 8); // forces truncation
    // The hash identifies the source content, not the assembled slice.
    expect(tiny.documents[0]?.contentHash).toBe(whole.documents[0]?.contentHash);
    expect(tiny.documents[0]?.originalBytes).toBe(whole.documents[0]?.originalBytes);
    expect(tiny.documents[0]?.state).toBe("truncated");
  });
});
