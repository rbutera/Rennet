import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expandPromptPartials,
  INVESTIGATE_PARTIAL_FILE,
  LENS_KINDS,
  LENS_PROMPT_FILES,
  PROMPT_PARTIAL_MARKER,
  PROMPT_PARTIALS,
  REVIEW_DRAFT_VOICE_FILE,
  ROUND_REPORT_FILE,
  WRITE_WITH_TOOLS_MARKER,
  WRITE_WITH_TOOLS_PARTIAL_FILE,
} from "./index.js";

const srcDir = dirname(fileURLToPath(import.meta.url));

describe("lens prompt manifest", () => {
  it("carries a non-empty prompt file for every lens", () => {
    for (const kind of LENS_KINDS) {
      const text = readFileSync(join(srcDir, LENS_PROMPT_FILES[kind]), "utf8");
      expect(text.length, `${kind} prompt`).toBeGreaterThan(500);
      expect(text).toMatch(/^# /);
      expect(text).toContain("Ground rules");
      expect(text).toContain("`document.title`");
      expect(text).toContain("`document.introMarkdown`");
      // The board is OPENED with a call now, not authored into a returned document.
      expect(text).toContain("`set_document`");
      // `measure` is host-owned and on no tool input (D2), so an instruction to set it
      // would name a field the seat cannot reach — a live prompt citing a dead field.
      expect(text, `${kind} prompt`).not.toContain("document.measure");
      // Citations are a path and a line range, resolved on the daemon: no board carries
      // a skip list and no lens accounts for hunks it did not cite. This assertion is
      // the whole producer-side guard against the vocabulary creeping back in a prompt.
      expect(text, `${kind} prompt`).not.toMatch(/skipped[-\s]?hunks/i);
      expect(text, `${kind} prompt`).not.toMatch(/hunk ids?\b/i);
    }
  });

  it("every lens prompt carries each shared marker exactly once, not the section body", () => {
    const checked: string[] = [];
    for (const kind of LENS_KINDS) {
      const text = readFileSync(join(srcDir, LENS_PROMPT_FILES[kind]), "utf8");
      for (const marker of Object.keys(PROMPT_PARTIALS)) {
        checked.push(`${kind}/${marker}`);
        expect(text.split(marker), `${kind} prompt / ${marker}`).toHaveLength(2);
      }
      expect(text).not.toContain("## Investigate before you draft");
      expect(text).not.toContain("## How you write this board");
    }
    // ── The COUNT, as LITERALS ──────────────────────────────────────────────────────
    // Without it a `LENS_KINDS` or a `PROMPT_PARTIALS` that came back empty would leave
    // this sweep asserting nothing and still green, which is the defect this change has
    // now shipped four times (an empty registry, a reconstructed tool surface, a raw
    // schema, a one-target meta-key sweep). Deriving the expectation from the same two
    // tables would inherit their emptiness, so these are the measured figures
    // (2026-09-05): five lenses, two shared markers, ten pairs.
    expect(LENS_KINDS, "lens prompts swept").toHaveLength(5);
    expect(Object.keys(PROMPT_PARTIALS), "shared markers swept").toHaveLength(2);
    expect(checked, "lens/marker pairs actually asserted").toHaveLength(10);
  });

  /**
   * `angle-prompt-contract` — the emit slot of a tool-writing seat names the verbs by the
   * job each does and never restates their input schemas, because those travel separately
   * as the turn's tool list. Two sources of truth for one shape drift.
   */
  it("the emit slot names the verbs and carries no field list or schema", () => {
    const partial = readFileSync(join(srcDir, WRITE_WITH_TOOLS_PARTIAL_FILE), "utf8");
    const normalized = partial.replace(/\s+/g, " ");
    expect(partial).toMatch(/^## How you write this board\n/);
    for (const verb of [
      "`set_document`",
      "`add_section`",
      "`cite`",
      "`add_prose`",
      "`update_*`",
      "`remove_element`",
      "`finish`",
    ]) {
      expect(partial, `the emit slot never names ${verb}`).toContain(verb);
    }
    // D6, told to the seat: a refusal and a finish verdict are answered in THIS turn.
    expect(normalized).toContain("A refusal costs you nothing");
    // No schema, no type declaration, no field list — the tool list carries all three.
    expect(partial).not.toContain("```json");
    expect(partial).not.toMatch(/"type"\s*:/);
    expect(partial).not.toMatch(/\bschema\b/i);
    // …and no lens prompt still tells its seat to return a document against one.
    for (const kind of LENS_KINDS) {
      const text = readFileSync(join(srcDir, LENS_PROMPT_FILES[kind]), "utf8");
      expect(text, `${kind} prompt`).not.toContain("in the schema supplied with");
      expect(text, `${kind} prompt`).not.toContain("Your output is a draft board");
    }
  });

  it("expandPromptPartials splices every shared partial and passes a marker-free text through", () => {
    const partial = readFileSync(join(srcDir, INVESTIGATE_PARTIAL_FILE), "utf8");
    expect(partial).toMatch(/^## Investigate before you draft\n/);
    expect(partial.replace(/\s+/g, " ")).toContain("only what you actually read earns a citation");
    // The seat reads the change itself and cites coordinates, not an offered inventory.
    expect(partial.replace(/\s+/g, " ")).toContain(
      "Cite by repository path and a 1-based inclusive line range",
    );
    expect(partial).not.toMatch(/inventory/i);
    const tools = readFileSync(join(srcDir, WRITE_WITH_TOOLS_PARTIAL_FILE), "utf8");
    const partials = { [PROMPT_PARTIAL_MARKER]: partial, [WRITE_WITH_TOOLS_MARKER]: tools };
    const out = expandPromptPartials(
      `# T\n\n${PROMPT_PARTIAL_MARKER}\n\n${WRITE_WITH_TOOLS_MARKER}\n\n## Next`,
      partials,
    );
    expect(out).toContain("## Investigate before you draft");
    expect(out).toContain("earns a\ncitation.");
    expect(out).toContain("## How you write this board");
    expect(out).not.toContain(PROMPT_PARTIAL_MARKER);
    expect(out).not.toContain(WRITE_WITH_TOOLS_MARKER);
    // A stub prompt (test doubles) passes through untouched; the shipped files are
    // guarded by the marker test above, which is the control for this seam.
    expect(expandPromptPartials("# T\n\n## Next", partials)).toBe("# T\n\n## Next");
  });

  it("tells the Design seat to find the spec itself, prove the tie, or return no-spec", () => {
    const text = readFileSync(join(srcDir, LENS_PROMPT_FILES.design), "utf8");
    const normalized = text.replace(/\s+/g, " ");

    // Where to look, and what makes a document THIS branch's spec.
    expect(normalized).toContain("openspec/changes/**");
    expect(normalized).toContain("`.kiro/**`");
    expect(normalized).toContain("`.bmad/**`");
    expect(normalized).toContain("docs/adr/**");
    expect(normalized).toContain("docs/superpowers/plans/**");
    expect(normalized).toContain(
      "commit messages of the reviewed range and the pull request body are the strongest clue",
    );
    // The tie is cited, so a wrong-spec board is falsifiable rather than merely wrong.
    expect(normalized).toContain(
      "The board must carry, as a cited source, the commit message, pull request text, or task line that connects this specification to this branch",
    );
    // The absence is the seat's own CALL now, and it is the ONLY absence it may claim:
    // `settle_absent` has no field to name another with, so the reason is fixed at the
    // surface rather than asked for in prose.
    expect(normalized).toContain("call `settle_absent`");
    expect(normalized).not.toContain('{ "absence": "no-spec" }');
    expect(normalized).toContain("not an empty board, not a placeholder");
    // D6 — no host bundle exists any more, so no instruction may assume one.
    expect(normalized).not.toContain("designArtifacts");
    expect(normalized).not.toMatch(/candidate/i);
    expect(normalized).not.toMatch(/no-material/);
    expect(normalized).not.toMatch(/sourceBytes|truncated/);
    // Board shape the seat still owns.
    expect(normalized).toContain("A scenario is a child only through `requirement.scenarios`");
    expect(normalized).toContain("one source-linked capability root");
    expect(normalized).toContain("exact nested operation sections");
    expect(normalized).toContain("Never promote the operations into separate capability roots");
    // The requirement's code citations belong to the seat now: nothing strips `trace`.
    expect(normalized).toContain("Cite the code that implements a requirement through `trace`");
  });

  it("keeps the lens lane vocabulary honest about what Design now owns", () => {
    // Design emits no coverage mapping, so no prompt may tell a sibling seat to omit
    // "requirement coverage" as Design's lane — that would drop the material entirely.
    for (const kind of LENS_KINDS) {
      const text = readFileSync(join(srcDir, LENS_PROMPT_FILES[kind]), "utf8");
      expect(text.replace(/\s+/g, " "), `${kind} prompt`).not.toContain("requirement coverage");
    }
  });

  it("keeps the round report to a narrow semantic classification", () => {
    const text = readFileSync(join(srcDir, ROUND_REPORT_FILE), "utf8");
    const normalized = text.replace(/\s+/g, " ");
    expect(text.length).toBeGreaterThan(500);
    expect(text).toMatch(/^# /);
    expect(text).toContain("Ground rules");
    expect(text).toMatch(/[Nn]ever launder/);
    expect(text).toContain("`outcomes`");
    expect(text).toContain("`beyond`");
    // The manifest contract (#727 + #726): cite ids, never coordinates, and place
    // every id exactly once. The old prompt taught diff line arithmetic; the host
    // derives every anchor now, so instructions to compute one would be a lie.
    expect(text).toContain("`evidenceIds`");
    expect(normalized).toContain(
      "Every manifest id must appear in exactly one place — one ask outcome or one `beyond` entry",
    );
    expect(normalized).toContain("Never write a line number, a range, a path, or a side");
    expect(text).not.toContain("Never add the unified diff's `a/` or `b/` prefix");
    expect(text).not.toContain("+start,count");
    expect(text).toContain("Do not emit a document");
    expect(text).not.toContain("Set `document.measure`");
  });

  it.each([
    ["decisions", "decision"],
    ["flagged", "finding"],
  ] as const)("requires a served root section for every non-empty %s result", (lens, kind) => {
    const text = readFileSync(join(srcDir, LENS_PROMPT_FILES[lens]), "utf8").replace(/\s+/g, " ");

    expect(text).toContain("top-level `section`");
    expect(text).toContain(`\`${kind}\``);
    expect(text).toContain("`section.data.children`");
  });

  it("tells the Noise seat its board is the complement of the other four", () => {
    // Rai's ruling, 2026-09-04: anything not covered by one of the other boards is noise.
    // The seat's membership question is positional, not a judgement about reading effort,
    // and this sentence is the producer half of that definition. Reverse it into "a hunk
    // whose content a reviewer can take on trust" and the lane goes back to judging
    // skip-safety independently, which is what the ruling retired.
    const normalized = readFileSync(join(srcDir, LENS_PROMPT_FILES.noise), "utf8").replace(
      /\s+/g,
      " ",
    );
    expect(normalized).toContain("Anything not covered by one of the other boards is noise");
    expect(normalized).toContain("Noise is not a property a hunk has; it is a position");
    expect(normalized).toContain("Membership is a position, not a verdict");
  });

  it("leaves the Noise seat no judgement to make beyond the grouping", () => {
    // The second half of the same ruling (2026-09-04): no escape valve, no prominence mark,
    // no seat-set verdict of any kind. `verdict` and `judge` are constants and the grouping
    // is the only thing the seat can get wrong, so every instruction that invited a skip-
    // safety call is asserted ABSENT. These are absence assertions and they are named as
    // such: they catch the old sentences coming back verbatim, and they cannot catch a new
    // sentence that invites the same judgement in different words. That is what review is
    // for; the executable half is that the words Rai retired are gone.
    const normalized = readFileSync(join(srcDir, LENS_PROMPT_FILES.noise), "utf8").replace(
      /\s+/g,
      " ",
    );
    expect(normalized).toContain("the grouping is the only thing here you decide");
    expect(normalized).toContain("Do not weigh whether a region is safe to skip");
    // The verdict/judge sentence is GONE, not reworded (D16f): both are host-stamped
    // constants on no tool input, so a prompt telling the seat what to set them to would
    // describe a field it cannot reach. What replaced it says where the members came from.
    expect(normalized).not.toContain("Every member's `verdict` is `noise`");
    expect(normalized).not.toContain("its `judge` is `llm`");
    expect(normalized).toContain("Your board already holds every member");
    expect(normalized).not.toContain("`signal`");
    expect(normalized).not.toContain("when in doubt");
    expect(normalized).not.toContain("safely take on trust");
  });

  it("never asks the Noise seat about an empty remainder, because it is settled before it runs", () => {
    // D16e — `no-noise` stopped being the seat's declaration. The host knows the derived
    // membership is empty BEFORE any turn and settles the lane with no seat at all, so a
    // Noise seat that is running always has members. An instruction about the empty case
    // would describe a turn that cannot happen, and the verb it named is gone from the
    // surface. Both halves are asserted: no empty-board instruction, and no settle-absent.
    const normalized = readFileSync(join(srcDir, LENS_PROMPT_FILES.noise), "utf8").replace(
      /\s+/g,
      " ",
    );
    expect(normalized).not.toContain("When the remainder is empty");
    expect(normalized).not.toContain("emitting a board with NO elements");
    expect(normalized).not.toContain("nothing here is safely skippable");
    // The seat is told plainly why it has no settle-absent verb, rather than left to
    // discover the verb missing.
    expect(normalized).toContain("There is no settle-absent verb");
    expect(normalized).toContain("settled before you are asked");
  });

  it("carries the review-draft voice rules", () => {
    const text = readFileSync(join(srcDir, REVIEW_DRAFT_VOICE_FILE), "utf8");
    expect(text.length).toBeGreaterThan(500);
    expect(text).not.toContain("post-process"); // #737: the file it cited is gone
    expect(text.replace(/\s+/g, " ")).toContain("under their own name");
  });

  it("fails when a manifest entry points at a missing file", () => {
    // Positive control: the check above can actually fail.
    expect(() => readFileSync(join(srcDir, "prompts/no-such-lens.md"), "utf8")).toThrow();
  });
});
