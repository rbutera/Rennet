/**
 * The Design assembler run over this repository's OWN archived OpenSpec changes (#877).
 *
 * A fixture proves the assembler can render a change someone wrote to be renderable. It
 * cannot answer the question the issue was filed about, which is how often the fast path
 * takes on real artifacts written by people who were not thinking about board lint. The
 * only instrument for that is the corpus, so the sweep that measured the defect is a test
 * rather than a paragraph: 118 changes in, a stated number out, and every change that does
 * NOT assemble named with the rule that stopped it.
 *
 * Uncacheable by construction — it reads the live checkout, both for the artifacts and for
 * the citation inventory — so it is a `dogfood-test`, not a `test`.
 *
 * TWO THINGS THIS TEST CANNOT SEE, both worth knowing before trusting the number:
 *
 * 1. It resolves the citations of HISTORICAL changes against TODAY's tree. An archived
 *    change citing a file that has since been deleted or shortened fails `citation-resolves`
 *    here and would not have failed at its own review commit. Those are marked in the
 *    expected list; they are an artefact of the corpus being historical, not a property of
 *    the assembler. The `citation-well-formed` and `no-code-bytes` entries are NOT
 *    artefacts — those rules read only the artifact text and would fail identically at any
 *    commit.
 * 2. It asserts that a board came back, not that the board is good. `assembled` counts
 *    boards, and an assembler that emitted a document and nothing else would still count.
 *    The second test is the answer to that: it reads the rendered text of one specific
 *    change back and matches it against the artifact on disk.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OpenSpecChangeSource } from "../delta/openspec-change";
import { assembleDesignBoard } from "./design-assembler";
import { openSpecChangeSourceToDesignSources } from "./design-obligations";
import type { LintContext } from "./lint";

/** The workspace root: this file sits at `<root>/packages/core/src/board/`. */
const ROOT = join(fileURLToPath(import.meta.url), "../../../../..");
const ARCHIVE = join(ROOT, "openspec/changes/archive");

/**
 * How many archived changes the assembler renders to a settled board.
 *
 * A LITERAL, deliberately. Deriving it from the assembler would make the assertion
 * tautological — an assembler that rendered nothing would satisfy a derived expectation —
 * and the whole value of this test is that the number is a fact someone measured.
 *
 * Before #877 it was 65, and #877's register took it to 91: the 26 it gained are the
 * changes whose only obstacle was a rule addressed to a writer's voice, run over prose the
 * assembler was quoting rather than writing (`VOICE_RULES` in `lint.ts`). Each of those was
 * a Design seat that ran, and billed, for a board the host already had: one measured drive
 * spent 882.9 s and 144 provider round trips on exactly one of them.
 *
 * #883 took it to 93, and those two are a different kind of gain — not a rule pointed at
 * the wrong party, but a rule reading prose wrong. `citation-well-formed` saw `127.0.0.1:0`
 * as the file `127.0.0.1` at line 0; it now asks for a plausible file extension before a
 * `<token>:<digits>` counts as a citation at all. Nothing was silenced to move the number:
 * every other entry below is unchanged, and the 14 bare-basename refusals still refuse.
 *
 * When a new OpenSpec change is archived this number moves, and moving it is the correct
 * response — it is a coverage figure, not a constant.
 */
const ASSEMBLED = 93;

/**
 * Every archived change the fast path does NOT render, and why. Sorted, so the failure
 * diff reads as a list rather than a count.
 *
 * `declined` is a clean `undefined` — the assembler looked and had nothing to render, the
 * seat takes it, and nothing was lost. Every other entry is the rule that refused, and each
 * is a Design seat that runs where it need not:
 *
 * - `citation-well-formed` — the author cited a bare basename (`app.tsx:551`). Kept in
 *   force for a transcription on purpose: a citation a reader cannot resolve is a broken
 *   board whoever wrote it. Every remaining entry under this rule is a real bare basename:
 *   the two that were NOT (`add-remote-surface`, `add-ws-transport`, refused for prose
 *   containing `127.0.0.1:0`) assemble since #883 taught the rule that a token has to end
 *   in a plausible file extension before it counts as a citation at all.
 * - `citation-resolves` — the cited file has moved or shrunk since the change was archived.
 *   See the header: an artefact of resolving old citations against today's tree.
 * - `no-code-bytes` — a fenced or indented code block in the artifact prose. Genuinely
 *   unrenderable: code on a board is a `code_ref`, not bytes, and the seat is right to
 *   take it.
 */
const NOT_ASSEMBLED: readonly string[] = [
  "2026-08-12-isolated-fixes — citation-resolves",
  "2026-08-12-own-branch-submission — no-code-bytes",
  "2026-08-12-renderer-polish — citation-resolves",
  "2026-08-15-deixis-pointing — citation-resolves",
  "2026-08-16-add-windows-support — citation-well-formed",
  "2026-08-17-add-command-registry-v1 — citation-resolves",
  "2026-08-17-polish-sweep — citation-well-formed",
  "2026-08-17-product-debt-sweep — citation-well-formed",
  "2026-08-19-mobile-app-m2 — citation-well-formed",
  "2026-08-20-rennet-docsite — no-code-bytes",
  "2026-09-01-b02-canvas-deletion-cutover — citation-well-formed",
  "2026-09-01-b04-boards-runtime — citation-well-formed",
  "2026-09-01-b06-context-map-swarm — citation-well-formed",
  "2026-09-01-b08-lens-pipeline — citation-well-formed",
  "2026-09-01-c08-exits — citation-well-formed",
  "2026-09-01-c09-rounds — no-code-bytes",
  "2026-09-01-c10-settings-help — citation-well-formed",
  "2026-09-01-c13-onboarding — citation-resolves",
  "2026-09-01-c14-conformance-sweep — declined",
  "2026-09-01-c14-release-blockers — citation-well-formed",
  "2026-09-01-c15-board-regen — citation-well-formed",
  "2026-09-01-c18-wiring-commands — declined",
  "2026-09-01-c19-direct-post — declined",
  "2026-09-01-desktop-styling-convergence — citation-well-formed",
  "2026-09-01-f1-chat-orchestrator — no-code-bytes",
];

const AUTHOR = { kind: "lens-agent", id: "design-seat" } as const;

/** One archived change's artifacts, read the way the adapter reads them off a checkout. */
function readChange(dir: string): OpenSpecChangeSource {
  const at = join(ARCHIVE, dir);
  const read = (rel: string): string | undefined =>
    existsSync(join(at, rel)) ? readFileSync(join(at, rel), "utf8") : undefined;
  const specsDir = join(at, "specs");
  const specDeltas: { capability: string; md: string }[] = [];
  if (existsSync(specsDir)) {
    for (const capability of readdirSync(specsDir).sort()) {
      const md = read(join("specs", capability, "spec.md"));
      if (md !== undefined) specDeltas.push({ capability, md });
    }
  }
  const proposalMd = read("proposal.md");
  const designMd = read("design.md");
  const tasksMd = read("tasks.md");
  return {
    name: dir,
    ...(proposalMd === undefined ? {} : { proposalMd }),
    ...(designMd === undefined ? {} : { designMd }),
    ...(tasksMd === undefined ? {} : { tasksMd }),
    specDeltas,
  };
}

/**
 * A REAL citation inventory: every tracked file at this commit, path → line count.
 *
 * The sweep in #877 ran with an empty one, which made every `path:line` in every artifact
 * unresolvable and put twelve changes in the citation buckets that may not have belonged
 * there. An empty inventory is not a neutral default for `citation-resolves`; it is a
 * context in which the rule always fires, so the measurement it produces is about the
 * fixture rather than about the corpus.
 */
function treeInventory(): Map<string, number> {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 1 << 28 })
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
  const files = new Map<string, number>();
  for (const path of listed) {
    try {
      files.set(path, readFileSync(join(ROOT, path), "utf8").split("\n").length);
    } catch {
      // Binary or unreadable: no line count, so a citation into it does not resolve —
      // which is what the daemon's own inventory says about such a file too.
    }
  }
  return files;
}

/** The refusal's rule id: `… (rule-id):` from a boundary refusal, `— rule-id @` from `finish`. */
function refusedRule(message: string): string {
  return (
    /\(([a-z0-9-]+)\):/.exec(message)?.[1] ??
    /— ([a-z][a-z-]+) @/.exec(message)?.[1] ??
    `unparsed: ${message}`
  );
}

describe("assembleDesignBoard over openspec/changes/archive", () => {
  const files = treeInventory();
  const lint: Omit<LintContext, "lens"> = { regions: [], files, baseFiles: files };
  const assemble = (dir: string) =>
    assembleDesignBoard(openSpecChangeSourceToDesignSources(readChange(dir)), lint, AUTHOR);

  it("renders 93 of the 118 archived changes, and names every one it cannot", () => {
    const dirs = readdirSync(ARCHIVE).sort();
    let assembled = 0;
    const notAssembled: string[] = [];
    for (const dir of dirs) {
      try {
        if (assemble(dir) === undefined) notAssembled.push(`${dir} — declined`);
        else assembled += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notAssembled.push(`${dir} — ${refusedRule(message)}`);
      }
    }
    // The named list first: when this test goes red it is nearly always because one change
    // moved, and the list says which and why. The counts below are then arithmetic.
    expect(notAssembled).toEqual([...NOT_ASSEMBLED]);
    expect(assembled).toBe(ASSEMBLED);
    expect(dirs.length).toBe(ASSEMBLED + NOT_ASSEMBLED.length);
    // 118 changes' artifacts parsed and rendered against a whole-tree citation inventory:
    // ~1.7 s on a warm laptop and 9.6 s on a cold CI runner, which is over vitest's 5 s
    // default. The timeout is generous rather than tuned — a corpus sweep that reddens
    // because the runner was busy is a test nobody trusts.
  }, 60_000);

  it("renders the change a live drive bought an 882.9 s Design seat for, quoting it verbatim", () => {
    // `2026-09-05-session-bound-workspace` is the change from #877's report: the daemon log
    // shows `board.lens-draft.design emitted attempt=0 seat=design in 882939 ms tools=144`
    // for a generation whose board this function could have produced for nothing. It was
    // refused at `add_decision` on `process-vocabulary`, because D6's statement is the words
    // "Design lens" — the author's own subject.
    //
    // This is the assertion the corpus count cannot make. It reads the rendered prose back
    // and matches it against the bytes on disk, so an assembler that returned an empty board
    // — which would still be counted as "assembled" above — fails here.
    const dir = "2026-09-05-session-bound-workspace";
    const board = assemble(dir);
    expect(board).toBeDefined();
    if (board === undefined) throw new Error("unreachable");

    expect(board.document?.title).toBe(dir);

    // The `## Why` ships verbatim: a sentence that exists nowhere but in that file.
    const proposal = readFileSync(join(ARCHIVE, dir, "proposal.md"), "utf8");
    const whySentence = "of which 103,000 were the bodies of 34 openspec proposals";
    expect(proposal).toContain(whySentence);
    expect(board.document?.introMarkdown ?? "").toContain(whySentence);

    // D6 — the decision the voice rule refused, on the board, in the author's own words.
    const statements = board.elements
      .filter((element) => element.kind === "decision")
      .map((element) => (element.data as { statement?: string }).statement ?? "");
    expect(statements).toContain("D6. Design lens.");
    // …and it is not the only one: the whole `## Decisions` run is rendered — D1 through D7,
    // in the artifact's order — not one token that happens to satisfy the assertion above.
    expect(statements).toEqual([
      "D1. The binding is the session's, decided once, from the review target.",
      "D2. Rounds run as turns on the session's thread family in the bound root; the branch moves.",
      "D3. Context files: one writer, one purge, one index.",
      "D4. What goes in the directory, per turn kind.",
      "D5. Citations are `codeRef`.",
      "D6. Design lens.",
      "D7. Order of landing.",
    ]);
  });
});
