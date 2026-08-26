import type { ComposedHandoffBundle, ComposedTask } from "@rennet/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HandoffPaper } from "./handoff-paper";

const ask = (id: string, path: string, instruction: string): ComposedTask["asks"][number] => ({
  id,
  path,
  type: "request-change",
  instruction,
  context: "",
});

/**
 * Tasks in a deliberately non-alphabetical order (z before a); `prompt` is rendered in
 * that SAME order — the run executes `prompt`, so it IS the executed order.
 */
function bundle(composed: boolean): ComposedHandoffBundle {
  const tasks: ComposedTask[] = [
    {
      title: composed ? "Later file first" : "",
      sourceDispositions: ["d1"],
      asks: [ask("d1", "src/z.ts", "ZEBRA-BODY")],
    },
    {
      title: composed ? "Then the earlier" : "",
      sourceDispositions: ["d0"],
      asks: [ask("d0", "src/a.ts", "APPLE-BODY")],
    },
  ];
  const prompt = ["### 1. src/z.ts", "ZEBRA-BODY", "### 2. src/a.ts", "APPLE-BODY"].join("\n");
  return {
    reviewId: "r1",
    patchsetId: "p1",
    tasks,
    prompt,
    digest: "abc",
    composed,
    traceMap: { d1: 0, d0: 1 },
  };
}

describe("HandoffPaper — the stage-6 composed-bundle preview", () => {
  it("renders tasks IN the composed order the run executes (z before a), not sorted", () => {
    const html = renderToStaticMarkup(<HandoffPaper bundle={bundle(true)} />);
    // The previewed order equals the prompt order: z's body appears before a's.
    // RED-proof: sort tasks by path in the view-model and this fires.
    expect(html.indexOf("ZEBRA-BODY")).toBeLessThan(html.indexOf("APPLE-BODY"));
    expect(html.indexOf("src/z.ts")).toBeLessThan(html.indexOf("src/a.ts"));
  });

  it("shows the model title as PREVIEW-ONLY, and the reviewer's verbatim bodies", () => {
    const html = renderToStaticMarkup(<HandoffPaper bundle={bundle(true)} />);
    expect(html).toContain("Later file first");
    expect(html).toContain("preview only");
    expect(html).toContain("ZEBRA-BODY");
    expect(html).toContain('data-composed="true"');
  });

  it("renders a mechanical-floor bundle HONESTLY as un-composed (no authored titles)", () => {
    const html = renderToStaticMarkup(<HandoffPaper bundle={bundle(false)} />);
    expect(html).toContain('data-composed="false"');
    expect(html.toLowerCase()).toContain("un-composed");
    // No preview-only title chrome when there is no authored title.
    expect(html).not.toContain("preview only");
  });
});
