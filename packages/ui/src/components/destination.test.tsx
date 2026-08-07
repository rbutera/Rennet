import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { addToBatch, type DispositionBatch } from "../canvas/authoring";
import { destinationVariant, draftsFromWrites, stagedPayload } from "../canvas/destination";
import type { DispositionWrite } from "../canvas/logic";
import { DestinationFrame } from "./destination-frame";
import { PublishSheet } from "./publish-sheet";

const writes: DispositionWrite[] = [
  { path: "src/alpha.ts", type: "approve", body: "good" },
  { path: "src/beta.ts", type: "request-change", body: 'rename "x" to "y"' },
];

function stage(...ws: DispositionWrite[]): DispositionBatch {
  return addToBatch([], draftsFromWrites(ws));
}

/** Recover the exact bytes React emitted as text content (the five entities it escapes). */
function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function previewText(html: string): string {
  const match = html.match(/<pre[^>]*data-testid="publish-preview"[^>]*>([\s\S]*?)<\/pre>/);
  if (!match) throw new Error("publish preview node not found");
  return decodeEntities(match[1] ?? "");
}

describe("DestinationFrame — persistent, present at review-open even when empty", () => {
  it("renders present (not hidden) with an empty staged set", () => {
    const html = renderToStaticMarkup(<DestinationFrame batch={[]} mode="own-branch" />);
    expect(html).toContain('data-staged-count="0"');
    expect(html).toContain("STAGING TOWARD");
    // The empty forming paper is present and named, not absent.
    expect(html).toContain("The paper is blank");
    expect(html).toContain(destinationVariant("own-branch").title);
  });

  it("fills visibly as the staged set grows", () => {
    const html = renderToStaticMarkup(
      <DestinationFrame batch={stage(...writes)} mode="own-branch" />,
    );
    expect(html).toContain('data-staged-count="2"');
    expect(html).toContain("src/alpha.ts");
    expect(html).toContain("src/beta.ts");
    expect(html).not.toContain("The paper is blank");
  });

  it("mode switches the variant over the SAME staged data", () => {
    const batch = stage(...writes);
    const own = renderToStaticMarkup(<DestinationFrame batch={batch} mode="own-branch" />);
    const other = renderToStaticMarkup(<DestinationFrame batch={batch} mode="other-pr" />);
    // Distinct framing…
    expect(own).toContain(destinationVariant("own-branch").title);
    expect(other).toContain(destinationVariant("other-pr").title);
    expect(own).not.toContain(destinationVariant("other-pr").title);
    // …over identical staged data.
    expect(own).toContain("src/alpha.ts");
    expect(other).toContain("src/alpha.ts");
    expect(own).toContain('data-staged-count="2"');
    expect(other).toContain('data-staged-count="2"');
  });
});

describe("PublishSheet — the paper: preview bytes == staged payload bytes", () => {
  it("previews exactly the staged payload bytes (recovered, not eyeballed)", () => {
    const batch = stage(...writes);
    const html = renderToStaticMarkup(
      <PublishSheet batch={batch} variant={destinationVariant("other-pr")} />,
    );
    expect(previewText(html)).toBe(stagedPayload(batch));
  });

  it("lists every staged item as what will leave the machine", () => {
    const batch = stage(...writes);
    const html = renderToStaticMarkup(
      <PublishSheet batch={batch} variant={destinationVariant("own-branch")} />,
    );
    expect(html).toContain('data-path="src/alpha.ts"');
    expect(html).toContain('data-path="src/beta.ts"');
    expect(html).toContain("Exactly what will leave the machine: 2 dispositions");
  });

  it("hold-to-confirm carries the hold budget and never defaults to approve", () => {
    const batch = stage(...writes);
    const html = renderToStaticMarkup(
      <PublishSheet batch={batch} variant={destinationVariant("other-pr")} holdToSignMs={800} />,
    );
    // The sign control is a hold, not a one-click approve.
    expect(html).toContain('data-hold-ms="800"');
    expect(html).toContain("Hold to publish review");
    // v1 all-or-nothing note is present (subset => withdraw first).
    expect(html).toContain("All-or-nothing");
  });

  it("disables the sign control when nothing is staged", () => {
    const html = renderToStaticMarkup(
      <PublishSheet batch={[]} variant={destinationVariant("own-branch")} />,
    );
    expect(html).toMatch(/class="publish-sheet-sign[^"]*"[^>]*disabled/);
    expect(previewText(html)).toBe(stagedPayload([]));
  });
});
