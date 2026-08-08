import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { addToBatch, type DispositionBatch } from "../canvas/authoring";
import {
  type CollationDraft,
  collationItems,
  collationPayload,
  draftFromBatch,
} from "../canvas/collation";
import { destinationVariant, draftsFromWrites } from "../canvas/destination";
import type { DispositionWrite } from "../canvas/logic";
import { DestinationFrame } from "./destination-frame";
import { PublishSheet } from "./publish-sheet";

const writes: DispositionWrite[] = [
  { path: "src/alpha.ts", type: "approve", body: "good" },
  { path: "src/beta.ts", type: "request-change", body: 'rename "x" to "y"' },
];

function stagedDraft(...ws: DispositionWrite[]): CollationDraft {
  const batch: DispositionBatch = addToBatch([], draftsFromWrites(ws));
  return draftFromBatch(batch);
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

describe("DestinationFrame — persistent, present at review-open even when empty (opens the DRAFT)", () => {
  it("renders present (not hidden) with an empty draft", () => {
    const html = renderToStaticMarkup(<DestinationFrame draft={[]} mode="own-branch" />);
    expect(html).toContain('data-staged-count="0"');
    expect(html).toContain("STAGING TOWARD");
    // R40: the frame is not the paper — the empty forming DRAFT is named, not "The
    // paper is blank". A revert to the old copy reddens here.
    expect(html).toContain("The draft is empty");
    expect(html).not.toContain("The paper is blank");
    expect(html).toContain(destinationVariant("own-branch").title);
  });

  it("fills visibly as the draft grows", () => {
    const html = renderToStaticMarkup(
      <DestinationFrame draft={stagedDraft(...writes)} mode="own-branch" />,
    );
    expect(html).toContain('data-staged-count="2"');
    expect(html).toContain("src/alpha.ts");
    expect(html).toContain("src/beta.ts");
    expect(html).not.toContain("The draft is empty");
  });

  it("opens the DRAFT (issue #101), not the publish sheet", () => {
    // The frame's action is now "Open the draft" — frame → draft → paper (R40).
    const html = renderToStaticMarkup(
      <DestinationFrame draft={stagedDraft(...writes)} mode="own-branch" />,
    );
    expect(html).toContain("Open the draft");
    expect(html).toContain("destination-open-draft");
  });

  it("mode switches the variant over the SAME collated data", () => {
    const draft = stagedDraft(...writes);
    const own = renderToStaticMarkup(<DestinationFrame draft={draft} mode="own-branch" />);
    const other = renderToStaticMarkup(<DestinationFrame draft={draft} mode="other-pr" />);
    // Distinct framing…
    expect(own).toContain(destinationVariant("own-branch").title);
    expect(other).toContain(destinationVariant("other-pr").title);
    expect(own).not.toContain(destinationVariant("other-pr").title);
    // …over identical collated data.
    expect(own).toContain("src/alpha.ts");
    expect(other).toContain("src/alpha.ts");
    expect(own).toContain('data-staged-count="2"');
    expect(other).toContain('data-staged-count="2"');
  });
});

describe("PublishSheet — the paper: preview bytes == the payload it is handed", () => {
  it("previews exactly the payload prop (recovered, not eyeballed)", () => {
    const draft = stagedDraft(...writes);
    const html = renderToStaticMarkup(
      <PublishSheet
        items={collationItems(draft)}
        payload={collationPayload(draft)}
        variant={destinationVariant("other-pr")}
      />,
    );
    // The paper previews and signs the EXACT bytes it is handed — never a re-derive.
    expect(previewText(html)).toBe(collationPayload(draft));
  });

  it("lists every collated item as what will leave the machine", () => {
    const draft = stagedDraft(...writes);
    const html = renderToStaticMarkup(
      <PublishSheet
        items={collationItems(draft)}
        payload={collationPayload(draft)}
        variant={destinationVariant("own-branch")}
      />,
    );
    expect(html).toContain('data-path="src/alpha.ts"');
    expect(html).toContain('data-path="src/beta.ts"');
    expect(html).toContain("Exactly what will leave the machine: 2 dispositions");
  });

  it("has NO withdraw affordance — editing lives on the draft (R40 narrowing)", () => {
    const draft = stagedDraft(...writes);
    const html = renderToStaticMarkup(
      <PublishSheet
        items={collationItems(draft)}
        payload={collationPayload(draft)}
        variant={destinationVariant("other-pr")}
      />,
    );
    // The paper's only actions are sign + back. A withdraw button on the paper is
    // exactly the conflation R40 removes; re-adding one reddens this.
    expect(html).not.toContain("publish-sheet-item-withdraw");
    expect(html).toContain("Back to the draft");
  });

  it("renders the hold affordance and the all-or-nothing note (rendering coverage only)", () => {
    // RENDERING COVERAGE, NOT THE SAFETY GATE. The SAFETY properties are proven by
    // red-provable mounted-DOM observations of `onSign` in `publish-safety.dom.test.tsx`.
    const draft = stagedDraft(...writes);
    const html = renderToStaticMarkup(
      <PublishSheet
        items={collationItems(draft)}
        payload={collationPayload(draft)}
        variant={destinationVariant("other-pr")}
        holdToSignMs={800}
      />,
    );
    expect(html).toContain("Hold to publish review");
    expect(html).toContain("All-or-nothing");
  });

  it("disables the sign control when nothing is collated", () => {
    const html = renderToStaticMarkup(
      <PublishSheet
        items={collationItems([])}
        payload={collationPayload([])}
        variant={destinationVariant("own-branch")}
      />,
    );
    expect(html).toMatch(/class="publish-sheet-sign[^"]*"[^>]*disabled/);
    expect(previewText(html)).toBe(collationPayload([]));
  });
});
