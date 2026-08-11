import type { CodexExecRequest, CodexExecResult, CodexExecutor } from "@rennet/core";
import type { Patchset, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { createLiveRefinePort, extractFileDiff, REFINE_DIFF_CEILING } from "./refine-comment-live";

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE review.refine producer (issue #19). Driven with NO real codex: a fake
// executor stands in, so the council routing + honesty degradations are proven
// hermetically. `refine-comment.test.ts` in core proves the verdict→result law.
// ─────────────────────────────────────────────────────────────────────────────

const DIFF = [
  "diff --git a/src/keys.ts b/src/keys.ts",
  "index 000..111 100644",
  "--- a/src/keys.ts",
  "+++ b/src/keys.ts",
  "@@ -1,1 +1,2 @@",
  " export const a = 1;",
  "+export const b = 2;",
  "diff --git a/src/other.ts b/src/other.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

function review(id = "review-1"): Review {
  const patchset: Patchset = {
    id: "ps-1",
    createdAt: "2026-08-11T00:00:00.000Z",
    repository: {
      id: "repo",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "abc",
      baseOid: "abc",
      headOid: "def",
    },
    files: [],
    rawDiff: DIFF,
    byteLength: DIFF.length,
    truncated: false,
  };
  return {
    id,
    repositoryRoot: "/repo",
    patchsets: [patchset],
    activePatchsetId: patchset.id,
    dispositions: [],
    status: "current",
  };
}

/** A fake executor capturing the request and returning a canned output. */
function fakeExecutor(output: unknown, onCall?: (req: CodexExecRequest) => void): CodexExecutor {
  return async (req: CodexExecRequest): Promise<CodexExecResult> => {
    onCall?.(req);
    return { output };
  };
}

describe("extractFileDiff", () => {
  it("returns only the requested file's diff section", () => {
    const section = extractFileDiff(DIFF, "src/keys.ts", REFINE_DIFF_CEILING);
    expect(section).toContain("a/src/keys.ts");
    expect(section).toContain("+export const b = 2;");
    // Stops before the next file's section.
    expect(section).not.toContain("src/other.ts");
  });

  it("returns an empty string when the path is not in the diff", () => {
    expect(extractFileDiff(DIFF, "src/missing.ts", REFINE_DIFF_CEILING)).toBe("");
  });

  it("bounds the section to the byte ceiling", () => {
    const section = extractFileDiff(DIFF, "src/keys.ts", 20);
    expect(section.length).toBeLessThanOrEqual(20 + "\n… (diff truncated at 20 bytes)".length);
    expect(section).toContain("truncated");
  });
});

describe("createLiveRefinePort — council-routed real turn", () => {
  it("refines on the Codex seat and returns the council-resolved model", async () => {
    let seenPrompt = "";
    const port = createLiveRefinePort({
      claudeInstalled: async () => true,
      codexExecutor: async () =>
        fakeExecutor(
          {
            verdict: "refined",
            refinedBody: "Re-keying breaks per-key clients; please add a note.",
          },
          (req) => {
            seenPrompt = req.prompt;
          },
        ),
    });
    const result = await port({
      review: review(),
      type: "request-change",
      raw: "this breaks per-key clients?? add note",
      lens: "decisions",
      path: "src/keys.ts",
    });
    expect(result).toEqual({
      status: "refined",
      refined: "Re-keying breaks per-key clients; please add a note.",
      // Table 1 (both installed) assigns comment-refinement to Terra.
      model: "gpt-5.6-terra",
    });
    // The anchored file diff was inlined for grounding (the "investigated" input).
    expect(seenPrompt).toContain("+export const b = 2;");
    // …and the raw note rode verbatim.
    expect(seenPrompt).toContain("this breaks per-key clients?? add note");
  });

  it("maps a no-change verdict through honestly", async () => {
    const port = createLiveRefinePort({
      claudeInstalled: async () => true,
      codexExecutor: async () => fakeExecutor({ verdict: "no-change" }),
    });
    const result = await port({ review: review(), type: "comment", raw: "already clear" });
    expect(result).toEqual({ status: "no-change", model: "gpt-5.6-terra" });
  });

  it("is UNAVAILABLE (not a Claude run) when Codex is not installed", async () => {
    const port = createLiveRefinePort({
      claudeInstalled: async () => true,
      codexExecutor: async () => null,
    });
    const result = await port({ review: review(), type: "comment", raw: "clean me up" });
    expect(result.status).toBe("unavailable");
  });

  it("returns an honest `failed` when the turn throws — never the raw as refined", async () => {
    const port = createLiveRefinePort({
      claudeInstalled: async () => true,
      codexExecutor: async () => async () => {
        throw new Error("codex exited 1");
      },
    });
    const result = await port({ review: review(), type: "comment", raw: "clean me up" });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toContain("codex exited 1");
  });
});
