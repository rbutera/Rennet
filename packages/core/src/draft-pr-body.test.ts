import { describe, expect, it } from "vitest";
import {
  buildPrBodyPrompt,
  draftPrBody,
  type PrBodyDraftInput,
  type PrBodyDraftPort,
  type PrBodyDraftPortResult,
  prBodyContextFiles,
} from "./draft-pr-body";
import { inlineContextViolation } from "./harness-run-turn";

// The session's context directory, as the daemon's writer returns it. Deliberately NOT
// derivable from any review id in this file: a builder that re-derived the directory
// would render paths these assertions do not expect (review finding 1).
const CONTEXT_DIR = ".rennet/context/sess-9";

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

describe("buildPrBodyPrompt — the material is NAMED, never inlined (3.7)", () => {
  it("names the file for every section the input carries, and no material", () => {
    const prompt = buildPrBodyPrompt(INPUT, CONTEXT_DIR);
    // The frame stays inline: two refs are the task, not context.
    expect(prompt).toContain("feat/rate-limit-fallback");
    expect(prompt).toContain("main");
    // The material is named by relative path, resolved against the turn's cwd.
    expect(prompt).toContain(`${CONTEXT_DIR}/pr-body/narration.json`);
    expect(prompt).toContain(`${CONTEXT_DIR}/pr-body/dispositions.json`);
    expect(prompt).toContain(`${CONTEXT_DIR}/pr-body/requirements.json`);
    expect(prompt).toContain(`${CONTEXT_DIR}/pr-body/decisions.json`);
    // And none of it travels.
    expect(prompt).not.toContain("The limiter MUST bound the fail-open path");
    expect(prompt).not.toContain("process-local bucket over a shared store");
    expect(prompt).not.toContain("Document the migration note in the PR body");
    expect(prompt).not.toContain("process-local fallback bucket");
    expect(inlineContextViolation(prompt)).toBeUndefined();
  });

  it("names ONLY the files the input carries (never invites invention)", () => {
    const prompt = buildPrBodyPrompt({ base: "main", head: "feat/thin", dispositions: [] }, "r1");
    expect(prompt).not.toContain("narration.json");
    expect(prompt).not.toContain("requirements.json");
    expect(prompt).not.toContain("decisions.json");
    expect(prompt).not.toContain("dispositions.json");
    expect(prompt).toContain("recorded no dispositions, requirements or decisions");
    // The branch shape is always framed — a thin submission is still honest.
    expect(prompt).toContain("feat/thin");
  });
});

describe("prBodyContextFiles — the material on disk (3.7)", () => {
  it("writes narration, dispositions with their intent, requirements and decisions", () => {
    const byName = new Map(prBodyContextFiles(INPUT).map((file) => [file.name, file.body]));
    expect(JSON.parse(byName.get("pr-body/narration.json") ?? "null")).toEqual(INPUT.narration);
    expect(JSON.parse(byName.get("pr-body/dispositions.json") ?? "null")).toEqual([
      {
        intent: "requested change",
        path: "keys.ts",
        resolution:
          "Document the migration note in the PR body — re-keying changes what a 429 means.",
      },
      {
        intent: "approved",
        path: "rate-limit.ts",
        resolution: "The fallback bucket is defensible.",
      },
    ]);
    expect(JSON.parse(byName.get("pr-body/requirements.json") ?? "null")).toEqual([
      "The limiter MUST bound the fail-open path",
    ]);
    expect(JSON.parse(byName.get("pr-body/decisions.json") ?? "null")).toEqual([
      "Chose a process-local bucket over a shared store (decision 2)",
    ]);
  });

  it("drops the blank disposition, requirement and decision rows", () => {
    const bodies = prBodyContextFiles(INPUT)
      .map((file) => file.body)
      .join("");
    // The whitespace-only comment resolution and the blank requirement row never become
    // empty entries the model would have to fill.
    expect(bodies).not.toContain("empty.ts");
    expect(bodies).not.toContain('""');
  });

  it("writes no file for a section the input does not carry", () => {
    expect(prBodyContextFiles({ base: "main", head: "feat/thin", dispositions: [] })).toEqual([]);
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
    const result = await draftPrBody(INPUT, CONTEXT_DIR, port, "resolved-model");
    expect(result).toEqual({
      status: "drafted",
      title: "Bound the rate limiter's fail-open path",
      body: "Adds a process-local fallback bucket. Documents the migration note (decision 2).",
      model: "gpt-5.6-luna",
    });
  });

  it("falls back to the resolved model when the port does not observe the runtime model", async () => {
    const port = portReturning({ status: "emitted", title: "A title", body: "A body." });
    const result = await draftPrBody(INPUT, CONTEXT_DIR, port, "resolved-model");
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
    const result = await draftPrBody(INPUT, CONTEXT_DIR, port, "resolved-model");
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
    const result = await draftPrBody(INPUT, CONTEXT_DIR, port, "resolved-model");
    expect(result.status).toBe("failed");
  });

  it("maps an emitted result with an empty body to `failed`", async () => {
    const port = portReturning({ status: "emitted", title: "A real title", body: "", model: "m" });
    const result = await draftPrBody(INPUT, CONTEXT_DIR, port, "resolved-model");
    expect(result.status).toBe("failed");
  });

  it("maps an emitted result missing both fields to `failed`", async () => {
    const port = portReturning({ status: "emitted", model: "m" });
    const result = await draftPrBody(INPUT, CONTEXT_DIR, port, "resolved-model");
    expect(result.status).toBe("failed");
  });

  it("passes an unavailable turn straight through", async () => {
    const port = portReturning({ status: "unavailable", reason: "no seat" });
    const result = await draftPrBody(INPUT, CONTEXT_DIR, port, "resolved-model");
    expect(result).toEqual({ status: "unavailable", reason: "no seat" });
  });

  it("passes a failed turn straight through", async () => {
    const port = portReturning({ status: "failed", reason: "the turn threw" });
    const result = await draftPrBody(INPUT, CONTEXT_DIR, port, "resolved-model");
    expect(result).toEqual({ status: "failed", reason: "the turn threw" });
  });
});

describe("draftPrBody — the port receives the prompt that NAMES the material (3.7)", () => {
  it("a port that echoes the pointers proves the material is reachable, not sent", async () => {
    // The acceptance contract (#74) is unchanged — a draft cites real content from the
    // review, not boilerplate — but the material now reaches the turn by being READ.
    // So what the prompt must carry is the PATH; the requirement text itself is in
    // `pr-body/requirements.json`, which this asserts separately.
    let seen = "";
    const echoingPort: PrBodyDraftPort = async (prompt) => {
      seen = prompt;
      const namesRequirements = prompt.includes("pr-body/requirements.json");
      const namesDecisions = prompt.includes("pr-body/decisions.json");
      return {
        status: "emitted",
        title: "Bound the fail-open path",
        body:
          namesRequirements && namesDecisions
            ? "Grounded body citing the requirement and decision 2."
            : "",
        model: "m",
      };
    };
    const result = await draftPrBody(INPUT, CONTEXT_DIR, echoingPort, "resolved-model");
    expect(result.status).toBe("drafted");
    expect(seen).toContain(`${CONTEXT_DIR}/pr-body/requirements.json`);
    expect(seen).toContain(`${CONTEXT_DIR}/pr-body/decisions.json`);
    // The material is on the other end of those paths, byte for byte.
    const files = new Map(prBodyContextFiles(INPUT).map((file) => [file.name, file.body]));
    expect(files.get("pr-body/requirements.json")).toContain(
      "The limiter MUST bound the fail-open path",
    );
    expect(files.get("pr-body/decisions.json")).toContain(
      "process-local bucket over a shared store",
    );
  });
});
