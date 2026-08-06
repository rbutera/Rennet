import type { Review } from "@rennet/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewWorkspace } from "./app";

const review: Review = {
  id: "review",
  repositoryRoot: "/code/rennet",
  activePatchsetId: "patch-one",
  dispositions: [
    { anchor: { path: "src/read.ts", contentDigest: "digest" }, type: "comment", body: "" },
  ],
  status: "current",
  patchsets: [
    {
      id: "patch-one",
      createdAt: "2026-08-05T00:00:00.000Z",
      repository: {
        id: "repository",
        root: "/code/rennet",
        commonDir: "/code/rennet/.git",
        baseRef: "main",
        baseOid: "1111111111111111",
        headOid: "2222222222222222",
      },
      files: [
        {
          path: "src/read.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          binary: false,
          patch: "+const reviewed = true;",
        },
      ],
      rawDiff: "+const reviewed = true;",
      byteLength: 24,
      truncated: false,
    },
  ],
};

describe("ReviewWorkspace", () => {
  it("shows repository provenance, progress, and the immutable diff", () => {
    const html = renderToStaticMarkup(
      <ReviewWorkspace
        review={review}
        onSelectPath={() => undefined}
        onSetRead={() => undefined}
        onRegenerate={() => undefined}
      />,
    );
    expect(html).toContain("rennet");
    expect(html).toContain("1 read");
    expect(html).toContain("+const reviewed = true;");
  });

  it("keeps the old patch visible behind an invalidation warning", () => {
    const html = renderToStaticMarkup(
      <ReviewWorkspace
        review={{ ...review, status: "invalid", pendingPatchsetId: "patch-two" }}
        onSelectPath={() => undefined}
        onSetRead={() => undefined}
        onRegenerate={() => undefined}
      />,
    );
    expect(html).toContain("Your code changed");
    expect(html).toContain("+const reviewed = true;");
  });
});
