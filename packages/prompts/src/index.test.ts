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
  REVIEW_DRAFT_VOICE_FILE,
  ROUND_REPORT_FILE,
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
      const measure = kind === "design" ? "structured" : "reading";
      expect(text.replace(/\s+/g, " ")).toContain(`Set \`document.measure\` to \`${measure}\``);
      // Citations are a path and a line range, resolved on the daemon: no board carries
      // a skip list and no lens accounts for hunks it did not cite. This assertion is
      // the whole producer-side guard against the vocabulary creeping back in a prompt.
      expect(text, `${kind} prompt`).not.toMatch(/skipped[-\s]?hunks/i);
      expect(text, `${kind} prompt`).not.toMatch(/hunk ids?\b/i);
    }
  });

  it("every lens prompt carries the investigate marker exactly once, not the section body", () => {
    for (const kind of LENS_KINDS) {
      const text = readFileSync(join(srcDir, LENS_PROMPT_FILES[kind]), "utf8");
      expect(text.split(PROMPT_PARTIAL_MARKER), `${kind} prompt`).toHaveLength(2);
      expect(text).not.toContain("## Investigate before you draft");
    }
  });

  it("expandPromptPartials splices the shared partial and passes a marker-free text through", () => {
    const partial = readFileSync(join(srcDir, INVESTIGATE_PARTIAL_FILE), "utf8");
    expect(partial).toMatch(/^## Investigate before you draft\n/);
    expect(partial.replace(/\s+/g, " ")).toContain("only what you actually read earns a citation");
    // The seat reads the change itself and cites coordinates, not an offered inventory.
    expect(partial.replace(/\s+/g, " ")).toContain(
      "Cite by repository path and a 1-based inclusive line range",
    );
    expect(partial).not.toMatch(/inventory/i);
    const out = expandPromptPartials(`# T\n\n${PROMPT_PARTIAL_MARKER}\n\n## Next`, partial);
    expect(out).toContain("## Investigate before you draft");
    expect(out).toContain("earns a\ncitation.\n\n## Next");
    expect(out).not.toContain(PROMPT_PARTIAL_MARKER);
    // A stub prompt (test doubles) passes through untouched; the shipped files are
    // guarded by the marker test above, which is the control for this seam.
    expect(expandPromptPartials("# T\n\n## Next", partial)).toBe("# T\n\n## Next");
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
    // The absence is the seat's own return, and it is the ONLY absence it may claim.
    expect(normalized).toContain('{ "absence": "no-spec" }');
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

  it("tells the Noise seat that an empty board IS the settlement for an all-signal change", () => {
    // The `no-noise` absence is only ever settled from the seat's OWN empty-board claim
    // (`draftOneLens` reads the first emitted return), so this instruction is the whole
    // producer half of that contract. Delete it, or reverse it into "always emit a board",
    // and the seat manufactures signal verdicts instead — which is every other lens's
    // premise, not this one's output, and the reviewer never sees the honest absence.
    const normalized = readFileSync(join(srcDir, LENS_PROMPT_FILES.noise), "utf8").replace(
      /\s+/g,
      " ",
    );
    expect(normalized).toContain("## When nothing in the change is noise");
    expect(normalized).toContain("Say so by emitting a board with NO elements");
    expect(normalized).toContain('honest "nothing here is safely skippable"');
    expect(normalized).toContain("Do not manufacture a board of signal verdicts");
    // …and the other edge of the same rule: an empty board is not a way out of a change
    // that does have skippable churn.
    expect(normalized).toContain(
      "Emit an empty board only when NO hunk is skip-safe; one skip-safe hunk means a real board naming it",
    );
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
