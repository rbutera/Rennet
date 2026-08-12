import type { DeltaAccount } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { buildDeltaDigestPrompt, type DeltaDigestPort, draftDeltaDigest } from "./delta-digest";

const account: DeltaAccount = {
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

describe("buildDeltaDigestPrompt — grounded in ONLY the account (#73/M25)", () => {
  it("carries the account's paths, statuses, and beyond-asks — and nothing else about the code", () => {
    const prompt = buildDeltaDigestPrompt(account);
    // Every fact the model may use is a fact the account already states.
    expect(prompt).toContain("src/rate/keys.ts");
    expect(prompt).toContain("addressed");
    expect(prompt).toContain("src/rate/middleware.ts");
    expect(prompt).toContain("left untouched");
    // Beyond-asks is surfaced as scope-creep.
    expect(prompt).toContain("src/metrics/emit.ts");
    expect(prompt.toLowerCase()).toContain("scope-creep");
    // The grounding guarantee: the prompt instructs "use ONLY the facts", so the model
    // is structurally unable to add a change it was not given (it sees no diff).
    expect(prompt).toContain("Use ONLY the facts");
  });
});

describe("draftDeltaDigest — the honesty floor (#73/M25)", () => {
  it("returns drafted with the model's text when the turn emits", async () => {
    const port: DeltaDigestPort = async () => ({
      status: "emitted",
      text: "Addressed two, left one, and touched a file nobody asked about.",
      model: "haiku",
    });
    const result = await draftDeltaDigest(account, port, "planned-model");
    expect(result).toEqual({
      status: "drafted",
      text: "Addressed two, left one, and touched a file nobody asked about.",
      model: "haiku",
    });
  });

  it("falls back to the resolved model when the port did not observe one", async () => {
    const port: DeltaDigestPort = async () => ({ status: "emitted", text: "A digest." });
    const result = await draftDeltaDigest(account, port, "resolved-model");
    expect(result).toEqual({ status: "drafted", text: "A digest.", model: "resolved-model" });
  });

  it("MODEL-FREE FLOOR: an empty/whitespace turn is FAILED, never a blank digest", async () => {
    const port: DeltaDigestPort = async () => ({ status: "emitted", text: "   " });
    const result = await draftDeltaDigest(account, port, "m");
    expect(result.status).toBe("failed");
  });

  it("MODEL-FREE FLOOR: an unavailable seat passes through as unavailable (no fabrication)", async () => {
    const port: DeltaDigestPort = async () => ({ status: "unavailable", reason: "no seat" });
    expect(await draftDeltaDigest(account, port, "m")).toEqual({
      status: "unavailable",
      reason: "no seat",
    });
  });

  it("MODEL-FREE FLOOR: a failed turn passes through as failed (never a fabricated digest)", async () => {
    const port: DeltaDigestPort = vi.fn(async () => ({
      status: "failed" as const,
      reason: "the turn threw",
    }));
    const result = await draftDeltaDigest(account, port, "m");
    expect(result).toEqual({ status: "failed", reason: "the turn threw" });
    expect(port).toHaveBeenCalledOnce();
  });
});
