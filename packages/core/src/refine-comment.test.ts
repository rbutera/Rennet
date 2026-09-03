import { describe, expect, it } from "vitest";
import {
  buildRefinePrompt,
  REFINE_INLINE_NOTE_MAX,
  type RefineCommentInput,
  type RefinePort,
  type RefinePortResult,
  refineComment,
} from "./refine-comment";

const RAW: RefineCommentInput = {
  raw: "this breaks per-key clients?? add note",
  type: "request-change",
};

/** A port that always returns the same canned result — the model wiring under test. */
function portReturning(result: RefinePortResult): RefinePort {
  return async () => result;
}

describe("refineComment — mapping the port outcome", () => {
  it("maps a genuine refined verdict to a `refined` result carrying the model", async () => {
    const port = portReturning({
      status: "emitted",
      verdict: "refined",
      refinedBody: "Re-keying from API key to org changes what a 429 means for existing clients.",
    });
    const result = await refineComment(RAW, port, "gpt-5.6-terra");
    expect(result).toEqual({
      status: "refined",
      refined: "Re-keying from API key to org changes what a 429 means for existing clients.",
      model: "gpt-5.6-terra",
    });
  });

  it("maps a no-change verdict to `no-change` — the raw is already clear", async () => {
    const port = portReturning({ status: "emitted", verdict: "no-change" });
    const result = await refineComment(RAW, port, "gpt-5.6-terra");
    expect(result).toEqual({ status: "no-change", model: "gpt-5.6-terra" });
  });

  it("PROVENANCE: reports the model the PORT actually ran, not the resolved plan", async () => {
    // A seat that runs its own default must report THAT, not the council's planned
    // pick. If refineComment used the passed `model` over `turn.model`, this reddens.
    const port = portReturning({
      status: "emitted",
      verdict: "refined",
      refinedBody: "The clean comment.",
      model: "claude-sonnet-4-5-actual",
    });
    const result = await refineComment(RAW, port, "sonnet-5");
    expect(result).toEqual({
      status: "refined",
      refined: "The clean comment.",
      model: "claude-sonnet-4-5-actual",
    });
  });

  it("HONESTY FLOOR: a refined verdict whose body equals the raw (trimmed) is no-change, not refined", async () => {
    // The design-doc validator rule: a refinedBody byte-identical to the draft is
    // NOT a refinement. Without this branch the raw would post dressed as 'refined'.
    const port = portReturning({
      status: "emitted",
      verdict: "refined",
      refinedBody: `  ${RAW.raw}  `,
    });
    const result = await refineComment(RAW, port, "haiku");
    expect(result).toEqual({ status: "no-change", model: "haiku" });
  });

  it("HONESTY FLOOR: a refined verdict with an empty body is a failure, never a silent empty refine", async () => {
    const port = portReturning({ status: "emitted", verdict: "refined", refinedBody: "   " });
    const result = await refineComment(RAW, port, "haiku");
    expect(result.status).toBe("failed");
  });

  it("passes an unavailable port outcome through as an honest `unavailable`", async () => {
    const port = portReturning({ status: "unavailable", reason: "Codex is not installed" });
    const result = await refineComment(RAW, port, "gpt-5.6-terra");
    expect(result).toEqual({ status: "unavailable", reason: "Codex is not installed" });
  });

  it("passes a failed port outcome through as an honest `failed` — never the raw as refined", async () => {
    const port = portReturning({ status: "failed", reason: "the turn did not complete" });
    const result = await refineComment(RAW, port, "gpt-5.6-terra");
    expect(result).toEqual({ status: "failed", reason: "the turn did not complete" });
  });
});

describe("buildRefinePrompt — the input the model reasons over", () => {
  it("carries the raw note verbatim, the type intent, and the JSON contract", () => {
    const prompt = buildRefinePrompt(RAW);
    expect(prompt).toContain(RAW.raw);
    expect(prompt).toContain("a requested change");
    expect(prompt).toContain('"verdict":"refined"');
    expect(prompt).toContain('"verdict":"no-change"');
    // The one load-bearing instruction: first-person, no AI attribution.
    expect(prompt).toContain("first person");
    expect(prompt).toContain("NEVER add any AI");
  });

  it("includes the Q5 lens and path context when the host carries them", () => {
    const prompt = buildRefinePrompt({ ...RAW, lens: "decisions", path: "src/keys.ts" });
    expect(prompt).toContain("decisions");
    expect(prompt).toContain("src/keys.ts");
  });

  it("grounds the model by NAMING the pointer file, never by carrying the code", () => {
    const prompt = buildRefinePrompt({ ...RAW, pointersPath: ".rennet/context/s1/p.json" });
    expect(prompt).toContain(".rennet/context/s1/p.json");
    // The instruction to read it must sit AFTER the path, so the path is what it refers
    // to — a membership check alone would pass on a prompt that mentions them apart.
    expect(prompt.indexOf("Read it and then read that code")).toBeGreaterThan(
      prompt.indexOf(".rennet/context/s1/p.json"),
    );
  });

  it("inlines a short note but writes a long one to a file it names", () => {
    const short = buildRefinePrompt(RAW);
    expect(short).toContain(RAW.raw);
    expect(short).toContain("The reviewer's raw note:");

    // Over the anchored-ask ceiling the caller writes the note out; the prompt then
    // names it and the note's own text must NOT appear.
    const long = "x".repeat(REFINE_INLINE_NOTE_MAX + 1);
    const prompt = buildRefinePrompt({
      ...RAW,
      raw: long,
      notePath: ".rennet/context/s1/refine-note.md",
    });
    expect(prompt).toContain(".rennet/context/s1/refine-note.md");
    expect(prompt).not.toContain(long);
    expect(prompt).not.toContain("The reviewer's raw note:");
  });
});
