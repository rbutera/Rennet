import { describe, expect, it } from "vitest";
import {
  buildPrBodyPrompt,
  draftPrBody,
  type PrBodyDraftInput,
  type PrBodyDraftPort,
  type PrBodyDraftPortResult,
} from "./draft-pr-body";

// A representative reviewed changeset: branch shape + narration + dispositions +
// one requirement + one decision — the honest-account inputs M26 draws from.
const INPUT: PrBodyDraftInput = {
  base: "main",
  head: "feat/rate-limit-fallback",
  narration: {
    oneLine: "Adds a process-local fallback bucket to the rate limiter.",
    paragraph:
      "The fail-open path was unbounded; this bounds it with a local bucket and documents the migration.",
  },
  dispositions: [
    {
      type: "request-change",
      path: "keys.ts",
      resolution:
        "Document the migration note in the PR body — re-keying changes what a 429 means.",
    },
    { type: "approve", path: "rate-limit.ts", resolution: "The fallback bucket is defensible." },
    { type: "comment", path: "empty.ts", resolution: "   " },
  ],
  requirements: ["The limiter MUST bound the fail-open path", "  "],
  decisions: ["Chose a process-local bucket over a shared store (decision 2)"],
};

/** A port that always returns the same canned result — the model wiring under test. */
function portReturning(result: PrBodyDraftPortResult): PrBodyDraftPort {
  return async () => result;
}

describe("buildPrBodyPrompt — the material reaches the model", () => {
  it("includes the branch shape, narration, dispositions, requirements, and decisions", () => {
    const prompt = buildPrBodyPrompt(INPUT);
    expect(prompt).toContain("feat/rate-limit-fallback");
    expect(prompt).toContain("main");
    expect(prompt).toContain("process-local fallback bucket");
    // The acceptance floor (#74): the draft cites real requirements/decisions, so
    // the prompt MUST carry them — a generic-boilerplate draft would not have them.
    expect(prompt).toContain("The limiter MUST bound the fail-open path");
    expect(prompt).toContain("process-local bucket over a shared store (decision 2)");
    // The dispositions' resolutions ground the account.
    expect(prompt).toContain("Document the migration note in the PR body");
    expect(prompt).toContain("[requested change]");
    expect(prompt).toContain("[approved]");
  });

  it("omits enrichment sections the input does not carry (never invites invention)", () => {
    const prompt = buildPrBodyPrompt({
      base: "main",
      head: "feat/thin",
      dispositions: [],
    });
    expect(prompt).not.toContain("roll-up account");
    expect(prompt).not.toContain("requirements this change");
    expect(prompt).not.toContain("decisions the review surfaced");
    // The branch shape is always framed — a thin submission is still honest.
    expect(prompt).toContain("feat/thin");
  });

  it("drops blank dispositions/requirements/decisions from the prompt", () => {
    const prompt = buildPrBodyPrompt(INPUT);
    // The whitespace-only comment resolution, requirement, and the blank rows never
    // become empty bullets the model would have to fill.
    expect(prompt).not.toContain("empty.ts");
    expect(prompt).not.toMatch(/- \s*\n/);
  });
});

describe("draftPrBody — mapping the port outcome", () => {
  it("maps an emitted title+body to a `drafted` result carrying the reported model", async () => {
    const port = portReturning({
      status: "emitted",
      title: "Bound the rate limiter's fail-open path",
      body: "Adds a process-local fallback bucket. Documents the migration note (decision 2).",
      model: "gpt-5.6-luna",
    });
    const result = await draftPrBody(INPUT, port, "resolved-model");
    expect(result).toEqual({
      status: "drafted",
      title: "Bound the rate limiter's fail-open path",
      body: "Adds a process-local fallback bucket. Documents the migration note (decision 2).",
      model: "gpt-5.6-luna",
    });
  });

  it("falls back to the resolved model when the port does not observe the runtime model", async () => {
    const port = portReturning({ status: "emitted", title: "A title", body: "A body." });
    const result = await draftPrBody(INPUT, port, "resolved-model");
    expect(result).toEqual({
      status: "drafted",
      title: "A title",
      body: "A body.",
      model: "resolved-model",
    });
  });

  it("trims the title and body the model returned", async () => {
    const port = portReturning({
      status: "emitted",
      title: "  Trim me  ",
      body: "\n  Body with surround \n",
      model: "m",
    });
    const result = await draftPrBody(INPUT, port, "resolved-model");
    expect(result).toMatchObject({
      status: "drafted",
      title: "Trim me",
      body: "Body with surround",
    });
  });
});

describe("draftPrBody — the honesty floor", () => {
  it("maps an emitted result with an empty title to `failed` (never a blank preview)", async () => {
    const port = portReturning({
      status: "emitted",
      title: "   ",
      body: "A real body.",
      model: "m",
    });
    const result = await draftPrBody(INPUT, port, "resolved-model");
    expect(result.status).toBe("failed");
  });

  it("maps an emitted result with an empty body to `failed`", async () => {
    const port = portReturning({ status: "emitted", title: "A real title", body: "", model: "m" });
    const result = await draftPrBody(INPUT, port, "resolved-model");
    expect(result.status).toBe("failed");
  });

  it("maps an emitted result missing both fields to `failed`", async () => {
    const port = portReturning({ status: "emitted", model: "m" });
    const result = await draftPrBody(INPUT, port, "resolved-model");
    expect(result.status).toBe("failed");
  });

  it("passes an unavailable turn straight through", async () => {
    const port = portReturning({ status: "unavailable", reason: "no seat" });
    const result = await draftPrBody(INPUT, port, "resolved-model");
    expect(result).toEqual({ status: "unavailable", reason: "no seat" });
  });

  it("passes a failed turn straight through", async () => {
    const port = portReturning({ status: "failed", reason: "the turn threw" });
    const result = await draftPrBody(INPUT, port, "resolved-model");
    expect(result).toEqual({ status: "failed", reason: "the turn threw" });
  });
});

describe("draftPrBody — the port receives the assembled prompt (citing contract)", () => {
  it("a port that echoes the material proves requirements/decisions reach the draft", async () => {
    // The acceptance contract (#74): a draft cites real content from the review, not
    // generic boilerplate. A port that grounds its body on the prompt it was handed
    // proves the material is actually presented to the model — asserting the
    // CONTRACT (the material flows to the turn), not this producer's own wording.
    let seen = "";
    const echoingPort: PrBodyDraftPort = async (prompt) => {
      seen = prompt;
      const citesRequirement = prompt.includes("The limiter MUST bound the fail-open path");
      const citesDecision = prompt.includes("process-local bucket over a shared store");
      return {
        status: "emitted",
        title: "Bound the fail-open path",
        body:
          citesRequirement && citesDecision
            ? "Grounded body citing the requirement and decision 2."
            : "",
        model: "m",
      };
    };
    const result = await draftPrBody(INPUT, echoingPort, "resolved-model");
    expect(result.status).toBe("drafted");
    expect(seen).toContain("The limiter MUST bound the fail-open path");
    expect(seen).toContain("process-local bucket over a shared store");
  });
});
