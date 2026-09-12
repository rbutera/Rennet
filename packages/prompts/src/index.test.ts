import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BoardTool, boardToolsByName } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  expandPromptPartials,
  FLAGGED_REVIEW_FILE,
  INVESTIGATE_PARTIAL_FILE,
  LENS_KINDS,
  LENS_PROMPT_FILES,
  PROMPT_PARTIAL_MARKER,
  PROMPT_PARTIALS,
  REVIEW_DRAFT_VOICE_FILE,
  ROUND_REPORT_FILE,
  SESSION_BRIEFING_FILE,
  SESSION_BRIEFING_FIXED_MAX_BYTES,
  WRITE_WITH_TOOLS_MARKER,
  WRITE_WITH_TOOLS_PARTIAL_FILE,
} from "./index.js";

const srcDir = dirname(fileURLToPath(import.meta.url));

// Four lenses are drafted by one investigating seat and share the three board-drafting
// partials. Flagged is not one of them (move two, #452): its `LENS_PROMPT_FILES` entry is the
// COMPILER prompt, which investigates nothing and emits the whole board in one `write_board`
// batch, so it carries none of those partials. The drafting-lens sweeps run over these four;
// Flagged's review and compile prompts are pinned by their own dedicated tests below.
const DRAFTING_LENS_KINDS = LENS_KINDS.filter((kind) => kind !== "flagged");
const partials = Object.fromEntries(
  Object.entries(PROMPT_PARTIALS).map(([marker, file]) => [
    marker,
    readFileSync(join(srcDir, file), "utf8"),
  ]),
);

/**
 * The prohibition shapes Decision 3 rules out of the session briefing: a "never", a
 * "do not commit", a "do not push", a "must not". Returned as the matched sentences so a
 * failure names what crept in, and so the assertion has something to be controlled with.
 */
const PROHIBITION_PATTERNS = [
  /\bnever\b/i,
  /\bdo not commit\b/i,
  /\bdo not push\b/i,
  /\bmust not\b/i,
];

function prohibitions(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n/)
    .filter((sentence) => PROHIBITION_PATTERNS.some((pattern) => pattern.test(sentence)));
}

describe("lens prompt manifest", () => {
  it("carries a non-empty prompt file for every drafting lens", () => {
    for (const kind of DRAFTING_LENS_KINDS) {
      const text = readFileSync(join(srcDir, LENS_PROMPT_FILES[kind]), "utf8");
      expect(text.length, `${kind} prompt`).toBeGreaterThan(500);
      expect(text).toMatch(/^# /);
      expect(expandPromptPartials(text, partials)).toContain("Ground rules");
      // The board is OPENED with a call now, not authored into a returned document, so
      // the prompt names the CALL and its flat arguments — not a `document` struct.
      expect(text).toContain("`set_document`");
      expect(text, `${kind} prompt`).toContain("`title`");
      expect(text, `${kind} prompt`).toContain("`intro_markdown`");
      // ── The net for a field the seat cannot reach ────────────────────────────────
      // `measure` is host-owned and on no tool input (D2), so an instruction to set it
      // names a field that does not exist. That was asserted as one string; the same
      // defect arrived by another door — `document.sources` and `document.stats` are
      // flattened to `source_paths` / `stat_labels` / `stat_values`, and `introMarkdown`
      // is renamed `intro_markdown`, so every one of those was a live prompt naming a
      // field the seat cannot reach. Two rules cover the whole family instead:
      //
      //  • no `document.<field>` at all — the seat calls a verb, it does not fill a struct;
      //  • no camelCase identifier — every real tool input name is lower_snake by
      //    construction, so a camelCase one is a pre-flattening name by definition.
      expect(text, `${kind} prompt names a document struct field`).not.toMatch(/`document\.\w/);
      expect(text, `${kind} prompt names a camelCase field`).not.toMatch(/`[a-z]+[A-Z]\w*`/);
      // …and the two it does name are real inputs on this lens's own `set_document`.
      const documentFields = new Set(
        (boardToolsByName(kind).get("set_document") as BoardTool).fields.map(({ name }) => name),
      );
      expect(documentFields, `${kind} set_document`).toContain("title");
      expect(documentFields, `${kind} set_document`).toContain("intro_markdown");
      expect(documentFields, "the struct name is not an input").not.toContain("introMarkdown");
      // Citations are a path and a line range, resolved on the daemon: no board carries
      // a skip list and no lens accounts for hunks it did not cite. This assertion is
      // the whole producer-side guard against the vocabulary creeping back in a prompt.
      expect(text, `${kind} prompt`).not.toMatch(/skipped[-\s]?hunks/i);
      expect(text, `${kind} prompt`).not.toMatch(/hunk ids?\b/i);
    }
  });

  it("every drafting-lens prompt carries each shared marker exactly once, not the section body", () => {
    const checked: string[] = [];
    for (const kind of DRAFTING_LENS_KINDS) {
      const text = readFileSync(join(srcDir, LENS_PROMPT_FILES[kind]), "utf8");
      for (const marker of Object.keys(PROMPT_PARTIALS)) {
        checked.push(`${kind}/${marker}`);
        expect(text.split(marker), `${kind} prompt / ${marker}`).toHaveLength(2);
      }
      expect(text).not.toContain("## Investigate before you draft");
      expect(text).not.toContain("## How you write this board");
    }
    // Flagged left the drafting contract (move two): 4 lenses × 3 markers.
    expect(LENS_KINDS, "lens kinds").toHaveLength(5);
    expect(DRAFTING_LENS_KINDS, "drafting lens prompts swept").toHaveLength(4);
    expect(Object.keys(PROMPT_PARTIALS), "shared markers swept").toHaveLength(3);
    expect(checked, "lens/marker pairs actually asserted").toHaveLength(12);
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
    expect(normalized).toContain("both are answered inside this turn");
    // ...but NOT that they are free. A refusal is a whole provider round trip, measured at
    // ~82k tokens and ~$0.12 on the #867 corpus, and the prompt used to say it "costs you
    // nothing". A prompt that misprices the seat's own actions is a lie in the product's
    // voice, so this asserts the falsehood is gone rather than merely that a truth is present.
    expect(normalized).not.toContain("A refusal costs you nothing");
    expect(normalized).toContain("a refusal is not free");
    // The seat batches independent calls, and this partial is where that is taught, so the
    // ordering contract must name both what may travel together and what may not. Naming
    // only the permission would invite refusals, which cost round trips.
    //
    // This assertion was originally justified by "every one of 2,245 tool calls carried
    // exactly one tool_use block". That was FALSE — an artifact of counting tool_use blocks
    // per `claude/assistant` FRAME, and the SDK emits one frame per content block, so that
    // count returns 1.000 whatever the model did. Re-measured by `message.id` over the same
    // corpus the mean is 1.33, with messages carrying up to 25 calls. The seats already
    // batched; the treatment raised board calls per message 1.83 → 4.74 on a two-arm drive.
    // The assertion stands on what the prompt must SAY, not on that dead number.
    expect(normalized).toContain("Send independent calls together");
    expect(normalized).toContain("In order, in separate messages");
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

  it("shares readable element structure and reviewer-owned highlighting across every lens", () => {
    const partials = Object.fromEntries(
      Object.entries(PROMPT_PARTIALS).map(([marker, file]) => [
        marker,
        readFileSync(join(srcDir, file), "utf8"),
      ]),
    );
    const rule = "agents do not specify presentation highlights or copy source into prose";
    for (const kind of DRAFTING_LENS_KINDS) {
      const source = readFileSync(join(srcDir, LENS_PROMPT_FILES[kind]), "utf8");
      const prompt = expandPromptPartials(source, partials).replace(/\s+/g, " ");
      expect(prompt.split(rule), kind).toHaveLength(2);
      expect(prompt, kind).toContain("Highlighting and annotations belong to the reviewer");
      expect(prompt, kind).toContain("Keep one coherent idea per element");
      expect(prompt, kind).toContain("A paragraph-length statement is never a navigation label");
      expect(prompt, kind).toContain(
        "Every section needs a useful folded preview, distinct from its title",
      );
      expect(prompt, kind).toContain(
        "The host shows those subheadings or truncates the opening paragraph to two lines",
      );
      expect(prompt, kind).toContain("it calculates counts from the children");
      expect(prompt, kind).not.toContain("path + line span + highlighted lines");
      expect(prompt, kind).not.toContain("one-line folded gist");
    }
    for (const lens of ["design", "decisions"] as const) {
      expect(
        boardToolsByName(lens)
          .get("add_decision")
          ?.fields.find((field) => field.name === "title"),
      ).toMatchObject({ required: false });
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

    // When the host already located the specification, the search is off: the seat
    // renders the files `design-sources.md` names and settles nothing absent.
    expect(normalized).toContain("If your context directory lists `design-sources.md`");
    expect(normalized).toContain("Those files are the specification");
    expect(normalized).toContain("do not settle absent");
    // Where to look otherwise, and what makes a document THIS branch's spec.
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

  it("requires a served root section for every non-empty decisions result", () => {
    // The incremental drafting seat names the parent by the id the host RETURNS. The Flagged
    // compiler roots its board the same way but batches, so it names ids with `local_id`
    // instead — that contract is pinned in the compile-prompt test below, not here.
    const text = readFileSync(join(srcDir, LENS_PROMPT_FILES.decisions), "utf8").replace(
      /\s+/g,
      " ",
    );

    expect(text).toContain("top-level section with `add_section`");
    expect(text).toContain("decision");
    expect(text).toContain("returned parent id");
    expect(text).not.toMatch(/return an empty|section\.data\.children/);
  });

  it("the Flagged REVIEW seat writes a findings file and holds no board tools", () => {
    // One of the two lane-less review seats (move two, #452). It investigates and writes the
    // concern prose, so it carries the investigate and reader-voice partials — but it authors
    // NO board, so it must not carry the board-writing partial or name a board verb.
    const text = readFileSync(join(srcDir, FLAGGED_REVIEW_FILE), "utf8");
    const normalized = text.replace(/\s+/g, " ");
    expect(text.length).toBeGreaterThan(500);
    expect(text).toMatch(/^# /);

    // It carries exactly the two partials a reviewer needs, and not the board-writing one.
    expect(text.split(PROMPT_PARTIAL_MARKER), "investigate marker").toHaveLength(2);
    expect(text.split("{{reader-voice}}"), "reader-voice marker").toHaveLength(2);
    expect(text, "review seat writes no board").not.toContain(WRITE_WITH_TOOLS_MARKER);

    // The output is a findings FILE written with the harness's own tools, not a board.
    expect(normalized).toContain("write what you find to a file");
    expect(normalized).toContain("You write no board and hold no board tools");
    expect(normalized).toContain("Write it with your own");
    // A reviewer names no board verb: the compiler authors the board, not this seat.
    expect(text, "review seat names no board verb").not.toMatch(
      /`(set_document|add_section|add_finding|write_board|finish)`/,
    );
    // The finding's shape is the reviewer's contract: the concern block the compiler copies
    // verbatim, with its severity, refs, and fix.
    expect(normalized).toContain("is the finding's `concern`");
    expect(normalized).toContain("the compiler copies it verbatim");
    expect(text).toContain("**Fix:**");
    expect(normalized).toContain("## No findings"); // the honest empty ending
  });

  it("the Flagged COMPILE seat authors the board from two reviews, verbatim, without re-reviewing", () => {
    // The compiler is `LENS_PROMPT_FILES.flagged`: the sole writer of the flagged board.
    const text = readFileSync(join(srcDir, LENS_PROMPT_FILES.flagged), "utf8");
    const normalized = text.replace(/\s+/g, " ");
    expect(text.length).toBeGreaterThan(500);
    expect(text).toMatch(/^# /);

    // It merges two finished reviews; it does not investigate or re-review. So it carries
    // NONE of the drafting-lens partials — naming the investigate one would be a lie.
    expect(text, "compiler does not investigate").not.toContain(PROMPT_PARTIAL_MARKER);
    expect(text, "compiler does not draft incrementally").not.toContain(WRITE_WITH_TOOLS_MARKER);
    expect(normalized).toContain("you do not re-review");
    expect(normalized).toContain("verbatim");
    expect(normalized).toContain("Merge, never rewrite");

    // It authors the flagged board: the same document surface, named as real inputs.
    expect(text).toContain("`set_document`");
    const flaggedTools = boardToolsByName("flagged");
    const documentFields = new Set(
      (flaggedTools.get("set_document") as BoardTool).fields.map(({ name }) => name),
    );
    expect(documentFields).toContain("title");
    expect(documentFields).toContain("intro_markdown");

    // One top-level section, findings attached in severity order. It batches, so it names
    // host-minted ids with `local_id` rather than the returned-id mechanism a drafter uses.
    expect(normalized).toContain("ONE top-level section with `add_section`");
    expect(normalized).toContain("`add_finding`");
    expect(normalized).toContain("`local_id`");

    // Decision 9: the compiler is the whole-board writer, so the target carries `write_board`.
    expect(flaggedTools.has("write_board"), "flagged target has write_board").toBe(true);
    expect(text).toContain("`write_board`");

    // Decision 10: it authors the two flat enums the host expands, in the compiler's own
    // vocabulary — the prompt teaches `diverge`/`solo`, never the schema's `split`/`conflict`.
    expect(text).toContain("`origin`");
    expect(text).toContain("`agreement`");
    expect(normalized).toContain("`claude` or `codex`");
    expect(normalized).toContain("`concur`, `diverge`, or `solo`");
    expect(text, "compiler must not teach accord's own words").not.toMatch(
      /`agreement`[^.]*`(split|conflict)`/,
    );
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

  /**
   * The session thread's briefing (`session-thread-briefing` 2.1). Two things are pinned
   * here that no other prompt file needs: its SIZE, because the briefing is a system-prompt
   * append — a prefix re-read on every round trip of every turn for the thread's life — and
   * the ABSENCE of any prohibition, because Decision 3 says the thread can do everything the
   * reviewer can and the briefing steers rather than forbids.
   */
  it("briefs the session thread with a map, a steer, and no prohibition", () => {
    const text = readFileSync(join(srcDir, SESSION_BRIEFING_FILE), "utf8");
    const normalized = text.replace(/\s+/g, " ");
    // The fixed half's budget. `SESSION_BRIEFING_MAX_BYTES` (4,096) covers fixed + dynamic,
    // so pinning the file here is what leaves the patchset, context and tool lines room.
    expect(new TextEncoder().encode(text).length, "fixed briefing bytes").toBeLessThanOrEqual(
      SESSION_BRIEFING_FIXED_MAX_BYTES,
    );
    expect(text).toMatch(/^# /);

    // Identity and division of labour: who it is, who already read the change, who judges.
    expect(normalized).toContain("conversation of one Rennet review session");
    expect(normalized).toContain("Design, Sequence, Decisions, Flagged, Noise");
    expect(normalized).toContain("drafted by seats that already read it");
    expect(normalized).toContain("coding rounds run on their own threads");
    expect(normalized).toContain("Rennet has no backend");
    // Capability, then the steer — in that order, because the steer is a steer.
    expect(normalized).toContain("Everything the reviewer can");
    expect(normalized.indexOf("Everything the reviewer can")).toBeLessThan(
      normalized.indexOf("stage an ask"),
    );
    expect(normalized).toContain("Staging is the path Rennet tracks");
    expect(normalized).toContain("Editing the checkout yourself is fine");
    // The tools it reaches the review through, and the anchored-question contract.
    for (const tool of [
      "`app_session_list`",
      "`app_review_load`",
      "`app_board_read`",
      "`app_patchset_readSpan`",
      "`app_patchset_readEvidence`",
      "`app_ask_stage`",
    ]) {
      expect(text, `the briefing names ${tool}`).toContain(tool);
    }
    expect(normalized).toContain("`Code reference: {…}`");
    expect(normalized).toContain("Retrieve it first");
    // No tool's input schema is restated: the schemas travel with the tool list.
    expect(text).not.toContain("```json");
    expect(text).not.toMatch(/"type"\s*:/);

    // The register partial, spliced by the same mechanism the lens prompts use.
    expect(text.split("{{reader-voice}}"), "reader-voice marker").toHaveLength(2);
    expect(text).not.toContain("## Explain the change and its mechanism");
    expect(expandPromptPartials(text, partials)).toContain("Ground rules");

    // Decision 3: the briefing forbids nothing. This reads the briefing's OWN text — the
    // reader-voice partial's "reader-facing prose never names lenses" is board-prose
    // guidance, not a limit on what the thread may do, and it is shared with five seats.
    expect(prohibitions(text), "the briefing forbids nothing").toEqual([]);
    // Positive control, one per pattern: each phrase is proven able to fire. Without this
    // the assertion above passes for a file that simply never matched anything.
    for (const sentence of [
      "Never edit the checkout.",
      "Do not commit anything.",
      "Do not push this branch.",
      "You must not open the pull request.",
    ]) {
      expect(prohibitions(`${text}\n${sentence}\n`), sentence).toHaveLength(1);
    }
  });

  it("fails when a manifest entry points at a missing file", () => {
    // Positive control: the check above can actually fail.
    expect(() => readFileSync(join(srcDir, "prompts/no-such-lens.md"), "utf8")).toThrow();
  });
});
