// @vitest-environment happy-dom
import type { RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { fireEvent, mount, waitFor } from "./test/dom";

const review: Review = {
  id: "delta-review",
  repositoryRoot: "/code/rennet",
  activePatchsetId: "patch-two",
  dispositions: [],
  status: "current",
  deltaAccount: {
    asks: [],
    beyondAsks: [],
    beyondAskHunks: [
      {
        path: "src/x.ts",
        span: { startLine: 40, endLine: 42 },
        bucket: "asked-file",
        excerpt: "+line 40",
      },
    ],
  },
  patchsets: [
    {
      id: "patch-two",
      createdAt: "2026-08-16T00:00:00.000Z",
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
          path: "src/x.ts",
          status: "modified",
          additions: 3,
          deletions: 0,
          binary: false,
          patch: "@@ -39,1 +39,4 @@\n context\n+line 40\n+line 41\n+line 42",
        },
      ],
      rawDiff: "@@ -39,1 +39,4 @@\n context\n+line 40\n+line 41\n+line 42",
      byteLength: 58,
      truncated: false,
    },
  ],
};

const bridge: RennetBridge = {
  invoke: (async (name: string) => {
    if (name === "app.bootstrap") return { review, repositoryPresent: true };
    if (name === "settings.get") return { scheme: "system", appearanceMalformed: false };
    if (name === "review.deltaDigest") return { status: "unavailable", reason: "test" };
    if (name === "flagged.review") return { status: "ok", findings: [] };
    return { review };
  }) as RennetBridge["invoke"],
};

describe("RennetApp — delta-account hunk navigation", () => {
  it("clicking a hunk row focuses its path and exact span in the Files diff", async () => {
    const { container } = mount(<RennetApp bridge={bridge} />);
    // Full-app mount + review navigation is this suite's heaviest path; the
    // focus attribute is DECLARATIVE (render-derived), so these waits can only
    // be late, never wrong — testing-library's 1s default grazed real CI runs
    // (auto-release 32272116190 failed on exactly this assertion under load).
    await waitFor(
      () => expect(container.querySelector('[data-testid="delta-account-hunk"]')).not.toBeNull(),
      { timeout: 5000 },
    );

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="delta-account-hunk"]',
      ) as HTMLButtonElement,
    );

    await waitFor(
      () => {
        expect(container.querySelector(".diff-toolbar strong")?.textContent).toBe("src/x.ts");
        const focused = container.querySelectorAll('.diff-line[data-delta-focus="true"]');
        expect([...focused].map((line) => line.getAttribute("data-file-line"))).toEqual([
          "40",
          "41",
          "42",
        ]);
        expect(document.activeElement).toBe(focused[0]);
      },
      { timeout: 5000 },
    );
  });
});
