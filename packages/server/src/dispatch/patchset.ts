import { buildHunkIndex, resolveCitation, sideLinesByFileLine } from "@rennet/core";
import type { AnchorSide, PatchFile, Patchset } from "@rennet/protocol";
import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import { changedRegions } from "../runtime/round-collation";
import type { CommandHandler, DispatchRuntime } from "./runtime";

/** Lines of orientation offered either side of a cited span, when the capture has them. */
const CONTEXT_LINES = 3;

/**
 * The file a citation addresses. A citation carries the patchset's own path, which for a
 * RENAME is the new path — but a `base`-side citation into a renamed file legitimately
 * names the old one, so both are matched.
 */
function fileFor(patchset: Patchset, path: string): PatchFile | undefined {
  return patchset.files.find((file) => file.path === path || file.previousPath === path);
}

/**
 * The lines immediately before/after a span that the capture actually contains, walking
 * outward and stopping at the FIRST gap. Contiguity is load-bearing, not a nicety: the
 * client numbers the returned block from `ref.startLine - contextBefore.length`
 * (`spanToBlock`, app-ui), so a context line lifted across a gap in the diff would be
 * rendered under a line number it does not have.
 */
function contiguous(
  byLine: ReadonlyMap<number, string>,
  from: number,
  step: -1 | 1,
): readonly string[] {
  const out: string[] = [];
  for (let n = from, taken = 0; taken < CONTEXT_LINES; n += step, taken += 1) {
    const text = byLine.get(n);
    if (text === undefined) break;
    out.push(text);
  }
  return step === -1 ? out.reverse() : out;
}

/**
 * `patchset.readSpan` — the ONE server-side reader behind every code citation.
 *
 * B3 registered this row contract-only and left a throwing handler for "B4/B10 to bind";
 * B4 recorded that it stays unbound (its reconciliation 6) and B10 never came back for it,
 * so every citation in the shipped app — every `code_ref`, finding, decision, order step,
 * annotation and round outcome that cites code — resolved to a thrown command. This binds it.
 *
 * The span is served from the CAPTURED patchset's own patch text and nothing else: no
 * working tree, no `git show`, no repository on disk. That is the #489 client-asset rule
 * (a citation must read the immutable capture, not whatever the checkout says today), and
 * it is also why a review whose repository is gone still resolves its citations — the
 * content was captured, so `repositoryPresent: false` costs a reader nothing here.
 *
 * The cost of reading the patch is that a patchset contains only its hunks. A span the
 * diff never showed is genuinely not in the store, and this says exactly that rather than
 * returning empty lines that would render as blank code. Every rejection below names the
 * specific absence, because the message is what the reviewer reads (`CitationBlock` renders
 * it verbatim) — "not readable" tells them nothing they can act on.
 */
export function patchsetHandlers(rt: DispatchRuntime) {
  return {
    "patchset.readSpan": async (rawInput) => {
      const name = "patchset.readSpan" as const;
      const ref = parseCommandInput(name, rawInput);

      const patchset = rt.service.patchsetById(ref.patchsetId);
      if (!patchset) {
        throw new Error(
          `This citation points at patchset ${ref.patchsetId}, which is not in this Rennet's store.`,
        );
      }

      const file = fileFor(patchset, ref.path);
      if (!file) {
        throw new Error(`${ref.path} is not one of the files this patchset captured.`);
      }
      if (file.binary) {
        throw new Error(`${ref.path} is binary — the capture holds no text to cite.`);
      }

      // A file that was ADDED has no pre-image and one that was DELETED has no post-image,
      // so the whole side is missing rather than one span of it. Said plainly here, because
      // the per-line message below ("outside the diff this patchset captured") would be
      // true and useless — it reads as "cite a different line" when no line will ever work.
      if (ref.side === "base" && file.status === "added") {
        throw new Error(`${ref.path} was added in this patchset — it has no base side to cite.`);
      }
      if (ref.side === "head" && file.status === "deleted") {
        throw new Error(`${ref.path} was deleted in this patchset — it has no head side to cite.`);
      }

      // `base` reads the pre-image, `head` the post-image. Context lines belong to both,
      // so `additions` (rather than `context`) is the right post-image selector here.
      const side: AnchorSide = ref.side === "base" ? "deletions" : "additions";
      const byLine = sideLinesByFileLine(file, side);

      // The SAME predicate lint runs (`resolveCitation` over `changedRegions`): every cited
      // line inside a captured region on the named side. A citation lint accepts is one
      // this can open, and one it cannot open is one lint sent back — never a weaker test
      // here than there.
      const captured =
        resolveCitation(
          { path: ref.path, side: ref.side, start: ref.startLine, end: ref.endLine },
          changedRegions(buildHunkIndex({ files: [file] }), [file]),
        ) !== undefined;
      const spanLabel =
        ref.startLine === ref.endLine
          ? `line ${ref.startLine}`
          : `lines ${ref.startLine}–${ref.endLine}`;

      if (!captured) {
        // A rename's OLD name has no head side: the file exists at head as the new name, and
        // serving its lines under the old one would be the right content under the wrong
        // label. (The base side answers to either name, in lint and here.)
        if (ref.side === "head" && ref.path !== file.path) {
          throw new Error(
            `${ref.path} was renamed to ${file.path} in this patchset — its head side is ${file.path}.`,
          );
        }
        // The honest, and by far the most common, absence: the patchset carries only the
        // diff's hunks, so an unchanged region of the file was never captured.
        let missing = ref.startLine;
        while (missing < ref.endLine && byLine.has(missing)) missing += 1;
        throw new Error(
          `${ref.path} ${spanLabel} (${ref.side}) is outside the diff this patchset captured — line ${missing} was never part of it.`,
        );
      }

      const lines: string[] = [];
      for (let n = ref.startLine; n <= ref.endLine; n += 1) {
        const text = byLine.get(n);
        if (text === undefined) {
          // A region claims the line but the capture has no text for it: only a truncated
          // diff does that (its tail region is open-ended on purpose, so lint does not call
          // the seat's citation wrong).
          throw new Error(
            `${ref.path} ${spanLabel} (${ref.side}) reaches past the point where Rennet truncated this file's diff — line ${n} was not captured.`,
          );
        }
        lines.push(text);
      }

      return parseCommandOutput(name, {
        lines,
        contextBefore: [...contiguous(byLine, ref.startLine - 1, -1)],
        contextAfter: [...contiguous(byLine, ref.endLine + 1, 1)],
      });
    },
  } satisfies Record<string, CommandHandler>;
}
