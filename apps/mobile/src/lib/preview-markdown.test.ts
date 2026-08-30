import { describe, expect, it } from "vitest";
import { previewMarkdownBlocks } from "./preview-markdown";

describe("previewMarkdownBlocks", () => {
  it("parses the real forge-post section shape and hides the GitHub idempotency marker", () => {
    expect(
      previewMarkdownBlocks(
        "The retry boundary is ready.\n\n## Review notes\n- **Comment** — Keep the retry visible.\n\n<!-- rennet:review:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->",
        { hideFinalReviewMarker: true },
      ),
    ).toEqual([
      {
        kind: "paragraph",
        inlines: [{ kind: "text", text: "The retry boundary is ready." }],
      },
      { kind: "heading", inlines: [{ kind: "text", text: "Review notes" }] },
      {
        kind: "paragraph",
        inlines: [
          { kind: "text", text: "- " },
          { kind: "strong", text: "Comment" },
          { kind: "text", text: " — Keep the retry visible." },
        ],
      },
    ]);
  });

  it("keeps unmatched Markdown as visible text instead of dropping it", () => {
    expect(previewMarkdownBlocks("A **still-open marker")).toEqual([
      {
        kind: "paragraph",
        inlines: [{ kind: "text", text: "A **still-open marker" }],
      },
    ]);
  });

  it("keeps an authored marker quote and never strips one from a PR preview", () => {
    const quoted =
      "<!-- rennet:review:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff -->";
    const actual =
      "<!-- rennet:review:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
    const review = previewMarkdownBlocks(`Quotes ${quoted}.\n\n${actual}`, {
      hideFinalReviewMarker: true,
    });
    const pr = previewMarkdownBlocks(quoted);

    expect(review[0]?.inlines).toEqual([{ kind: "text", text: `Quotes ${quoted}.` }]);
    expect(pr[0]?.inlines).toEqual([{ kind: "text", text: quoted }]);
  });
});
