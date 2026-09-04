import { buildHunkIndex, resolveCitation, sideLinesByFileLine } from "@rennet/core";
import type { AnchorSide, CodeRef, PatchFile, Patchset } from "@rennet/protocol";
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
 * Serve a span out of the REVIEWED TREE, for the one case the capture cannot answer: a
 * truncated diff whose tail region lint deliberately leaves open-ended.
 *
 * The bytes come from a git object, not the working tree — `reviewedTreeOid ?? headOid` for
 * head, `baseOid` for base — so this is still the immutable reviewed content the citation
 * was made against, just read from the other half of the same capture. `undefined` when no
 * reader is wired, the repository is gone, or the file is shorter than the citation; the
 * caller then says so rather than serving blank code.
 */
async function readFromTree(
  rt: DispatchRuntime,
  patchset: Patchset,
  file: PatchFile,
  ref: CodeRef,
): Promise<{ lines: string[]; contextBefore: string[]; contextAfter: string[] } | undefined> {
  const read = rt.deps.readBlobAtOid;
  if (read === undefined) return undefined;
  const repository = patchset.repository;
  const oid =
    ref.side === "base" ? repository.baseOid : (repository.reviewedTreeOid ?? repository.headOid);
  const path = ref.side === "base" ? (file.previousPath ?? file.path) : file.path;
  let text: string | null;
  try {
    text = await read({ root: repository.root, oid, path });
  } catch {
    return undefined;
  }
  if (text === null) return undefined;
  const all = text.split("\n");
  if (all.length < ref.endLine) return undefined;
  // 1-based inclusive lines, with the same three lines of orientation either side.
  return {
    lines: all.slice(ref.startLine - 1, ref.endLine),
    contextBefore: all.slice(Math.max(0, ref.startLine - 1 - CONTEXT_LINES), ref.startLine - 1),
    contextAfter: all.slice(ref.endLine, ref.endLine + CONTEXT_LINES),
  };
}

/**
 * `patchset.readSpan` — the ONE server-side reader behind every code citation.
 *
 * B3 registered this row contract-only and left a throwing handler for "B4/B10 to bind";
 * B4 recorded that it stays unbound (its reconciliation 6) and B10 never came back for it,
 * so every citation in the shipped app — every `code_ref`, finding, decision, order step,
 * annotation and round outcome that cites code — resolved to a thrown command. This binds it.
 *
 * The span is served from the CAPTURED patchset's own patch text — never the working tree.
 * That is the #489 client-asset rule (a citation must read the immutable capture, not
 * whatever the checkout says today), and it is also why a review whose repository is gone
 * still resolves its citations: the content was captured, so `repositoryPresent: false`
 * costs a reader nothing here.
 *
 * The cost of reading the patch is that a patchset contains only its hunks. A span the
 * diff never showed is genuinely not in the store, and this says exactly that rather than
 * returning empty lines that would render as blank code. Every rejection below names the
 * specific absence, because the message is what the reviewer reads (`CitationBlock` renders
 * it verbatim) — "not readable" tells them nothing they can act on.
 *
 * The ONE exception is a TRUNCATED capture, and it is not a rejection: lint deliberately
 * accepts a citation past the cut (the tail region is open-ended, so the daemon never calls
 * a seat's citation wrong over lines it chose not to keep), and a citation the board
 * accepts must never come back as an error on the card. Those lines are read from the
 * IMMUTABLE OBJECT the patchset recorded (`git show <reviewedTreeOid|baseOid>:<path>`),
 * which is the same reviewed content the capture cut short — not the checkout as it stands.
 * With no repository to read, the answer is an honest caption, still not a refusal.
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
          // the seat's citation wrong). Lint ACCEPTS this citation, so the card must not
          // throw for it — that would show the reviewer a refusal over a valid citation.
          // The reviewed content is still addressable: read it out of the immutable tree
          // the patchset recorded (`git show <oid>:<path>`), which is the same bytes the
          // capture cut short, not whatever the checkout says today (#489 holds).
          const fromTree = await readFromTree(rt, patchset, file, ref);
          if (fromTree !== undefined) return parseCommandOutput(name, fromTree);
          return parseCommandOutput(name, {
            lines: [],
            contextBefore: [],
            contextAfter: [],
            caption: `Rennet truncated this file's diff before ${ref.path} ${spanLabel} (${ref.side}), and the reviewed tree is not readable from here — the citation is sound, the captured bytes stop short of it.`,
          });
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
