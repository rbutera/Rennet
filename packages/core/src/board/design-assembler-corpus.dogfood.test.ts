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
 * The count measures acceptance, not rendering fidelity. The second test reads the
 * rendered text of one specific change back against its original artifact.
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

/** Measured against the 118 archived changes: 18 more than before prose citations
 *  stopped being inferred from transcribed text. Keep the expected count literal. */
const ASSEMBLED = 111;

/** Fenced code still needs the seat; declined sources contain no renderable obligations. */
const NOT_ASSEMBLED: readonly string[] = [
  "2026-08-12-own-branch-submission — no-code-bytes",
  "2026-08-20-rennet-docsite — no-code-bytes",
  "2026-09-01-c09-rounds — no-code-bytes",
  "2026-09-01-c14-conformance-sweep — declined",
  "2026-09-01-c18-wiring-commands — declined",
  "2026-09-01-c19-direct-post — declined",
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

  it("renders 111 of the 118 archived changes, and names every one it cannot", () => {
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
