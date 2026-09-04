import type { SuccessorAccount } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  buildDeltaDigestPrompt,
  type DeltaDigestPort,
  deltaDigestContextFile,
  draftDeltaDigest,
} from "./delta-digest";
import { inlineContextViolation } from "./harness-run-turn";

// The session's context directory, as the daemon's writer returns it. Deliberately NOT
// derivable from any review id in this file: a builder that re-derived the directory
// would render paths these assertions do not expect (review finding 1).
const CONTEXT_DIR = ".rennet/context/sess-9";

const account: SuccessorAccount = {
  asks: [
    {
      path: "src/rate/keys.ts",
      type: "request-change",
      summary: "rename the key",
      status: "addressed",
    },
    {
      path: "src/rate/bucket.ts",
      type: "request-change",
      summary: "bound the fail-open",
      status: "addressed",
    },
    {
      path: "src/rate/middleware.ts",
      type: "comment",
      summary: "drop the dead branch",
      status: "untouched",
    },
  ],
  beyondAsks: ["src/metrics/emit.ts"],
};

describe("buildDeltaDigestPrompt — the account is NAMED, never inlined (3.7)", () => {
  it("names digest-input.json and carries no path, status or summary of its own", () => {
    const prompt = buildDeltaDigestPrompt(CONTEXT_DIR);
    // The one path, relative to the turn's cwd, which is the session's bound root.
    expect(prompt).toContain(`${CONTEXT_DIR}/digest-input.json`);
    // Not one fact from the account travels with the instructions.
    expect(prompt).not.toContain("src/rate/keys.ts");
    expect(prompt).not.toContain("src/rate/middleware.ts");
    expect(prompt).not.toContain("src/metrics/emit.ts");
    expect(prompt).not.toContain("rename the key");
    // The grounding guarantee is now stated about that file, and is the same guarantee.
    expect(prompt).toContain("Use ONLY the facts in that file");
    expect(prompt.toLowerCase()).toContain("scope-creep");
    expect(inlineContextViolation(prompt)).toBeUndefined();
  });

  it("is CONSTANT in the account: a 40-ask delta sends the same prompt as a 3-ask one", () => {
    // The whole point of the conversion. The prompt used to grow with every ask and every
    // beyond-ask hunk, which is what the old enumeration cap existed to bound.
    const big: SuccessorAccount = {
      asks: Array.from({ length: 40 }, (_unused, index) => ({
        path: `src/f${index}.ts`,
        type: "request-change" as const,
        summary: `bound the ${index}th fail-open path`,
        status: "addressed" as const,
      })),
      beyondAsks: Array.from({ length: 20 }, (_unused, index) => `src/m${index}.ts`),
    };
    expect(buildDeltaDigestPrompt(CONTEXT_DIR)).toBe(buildDeltaDigestPrompt(CONTEXT_DIR));
    expect(deltaDigestContextFile(big).body.length).toBeGreaterThan(
      buildDeltaDigestPrompt(CONTEXT_DIR).length,
    );
  });
});

describe("deltaDigestContextFile — the account on disk (3.7)", () => {
  it("writes the whole account, uncapped, under the name the prompt gives", () => {
    const written = deltaDigestContextFile(account);
    expect(written.name).toBe("digest-input.json");
    expect(JSON.parse(written.body)).toEqual(account);
    expect(written.holds.length).toBeGreaterThan(10);
    expect(written.readWhen.length).toBeGreaterThan(5);
  });

  it("carries every beyond-ask hunk, where the prompt used to stop at ten", () => {
    const many: SuccessorAccount = {
      asks: [],
      beyondAsks: [],
      beyondAskHunks: Array.from({ length: 14 }, (_unused, index) => ({
        path: `src/f${index}.ts`,
        span: { startLine: index + 1 },
        bucket: "unasked-file" as const,
        excerpt: `+line ${index}`,
      })),
    };
    const parsed = JSON.parse(deltaDigestContextFile(many).body) as SuccessorAccount;
    expect(parsed.beyondAskHunks).toHaveLength(14);
    expect(deltaDigestContextFile(many).body).not.toContain("and 4 more");
  });

  it("omits the hunk field entirely for an account that carries none", () => {
    expect(JSON.parse(deltaDigestContextFile(account).body)).not.toHaveProperty("beyondAskHunks");
  });
});

describe("draftDeltaDigest — the honesty floor (#73/M25)", () => {
  it("returns drafted with the model's text when the turn emits", async () => {
    const port: DeltaDigestPort = async () => ({
      status: "emitted",
      text: "Addressed two, left one, and touched a file nobody asked about.",
      model: "haiku",
    });
    const result = await draftDeltaDigest(CONTEXT_DIR, port, "planned-model");
    expect(result).toEqual({
      status: "drafted",
      text: "Addressed two, left one, and touched a file nobody asked about.",
      model: "haiku",
    });
  });

  it("falls back to the resolved model when the port did not observe one", async () => {
    const port: DeltaDigestPort = async () => ({ status: "emitted", text: "A digest." });
    const result = await draftDeltaDigest(CONTEXT_DIR, port, "resolved-model");
    expect(result).toEqual({ status: "drafted", text: "A digest.", model: "resolved-model" });
  });

  it("MODEL-FREE FLOOR: an empty/whitespace turn is FAILED, never a blank digest", async () => {
    const port: DeltaDigestPort = async () => ({ status: "emitted", text: "   " });
    const result = await draftDeltaDigest(CONTEXT_DIR, port, "m");
    expect(result.status).toBe("failed");
  });

  it("MODEL-FREE FLOOR: an unavailable seat passes through as unavailable (no fabrication)", async () => {
    const port: DeltaDigestPort = async () => ({ status: "unavailable", reason: "no seat" });
    expect(await draftDeltaDigest(CONTEXT_DIR, port, "m")).toEqual({
      status: "unavailable",
      reason: "no seat",
    });
  });

  it("MODEL-FREE FLOOR: a failed turn passes through as failed (never a fabricated digest)", async () => {
    const port: DeltaDigestPort = vi.fn(async () => ({
      status: "failed" as const,
      reason: "the turn threw",
    }));
    const result = await draftDeltaDigest(CONTEXT_DIR, port, "m");
    expect(result).toEqual({ status: "failed", reason: "the turn threw" });
    expect(port).toHaveBeenCalledOnce();
  });
});
