// The change's ORIENTATION INDEX as a session context file (#867).
//
// Measured on 26 seat turns: 25 of them opened by re-deriving the shape of the change for
// themselves — `git diff --stat <range>` then `git log --oneline <range>` — which was 20%
// of all their Bash traffic and a provider round trip apiece. Every one of those facts was
// already computed on the host, in the packet the same generation was assembled from.
//
// So the host writes them down once, as a file, and the prompt names the path. This is the
// "never inline context" rule doing its job in the other direction: the seat does not pay
// for the index in tokens, and it does not pay for it in round trips either.
//
// What this file is NOT: the diff. It carries no hunk bodies and no file content — only
// the shape (which files, how much, which line spans), so the seat still reads what it
// decides it needs from the checkout with its own tools.

import type { PatchFile } from "@rennet/protocol";
import type { SessionContextFile } from "../session-context";
import type { DeltaPacket } from "./delta-packet";
import type { IndexedHunk } from "./hunk-index";

/** The one name the change index is written and read under, per session. */
export const CHANGE_INDEX_FILE = "change-index.md";

/**
 * The byte bound this artefact is rendered under, declared at the ONE call site that
 * renders it (CLAUDE.md: "every dynamic interpolation declares a byte bound").
 *
 * A file is not billed the way a prompt is, so this is not a token budget — it is the
 * bound that keeps a pathological change (a vendored tree rewrite, a lockfile-wide rename)
 * from producing a file no seat can usefully read. 24 KiB holds the 95-file drive's whole
 * index with room to spare; past it the file says how many files it dropped rather than
 * trailing off, because an index that silently ends is an index that lies about the change.
 */
export const CHANGE_INDEX_MAX_BYTES = 24_576;

/** The marker a truncated index ends on. `N` is the number of files not listed. */
export const CHANGE_INDEX_TRUNCATION = "… truncated, ";

const ENCODER = new TextEncoder();

function utf8Bytes(text: string): number {
  return ENCODER.encode(text).length;
}

/** `12-16` for five new-side lines from 12; `9+0` for a hunk that only deletes. */
function span(hunk: IndexedHunk): string {
  const { start, lines } = hunk.spans.new;
  return lines === 0 ? `${start}+0` : `${start}-${start + lines - 1}`;
}

/**
 * The file's added/deleted counts. `PatchFile.additions`/`deletions` are `number | null`
 * on the wire, so when the capture did not carry them they are counted off the hunk bodies
 * — which keep their unified-diff prefix — rather than reported as zero. A zero the reader
 * cannot tell apart from "not measured" is the lie this avoids.
 */
function countsOf(
  file: Pick<PatchFile, "additions" | "deletions">,
  hunks: readonly IndexedHunk[],
): { readonly added: number; readonly deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const hunk of hunks) {
    for (const line of hunk.body) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) deleted += 1;
    }
  }
  return {
    added: file.additions ?? added,
    deleted: file.deletions ?? deleted,
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The change's orientation index as a context file, or `undefined` when the packet names
 * no changed file at all — following `prPaperContextFile`: an empty index is a file that
 * claims there is something to orient by, and a seat would read it as evidence.
 *
 * Pure, node-free and deterministic: the packet in, markdown out. `maxBytes` is the caller's
 * bound; the default is {@link CHANGE_INDEX_MAX_BYTES}.
 */
export function changeIndexContextFile(
  packet: Pick<DeltaPacket, "patchset" | "hunks">,
  maxBytes: number = CHANGE_INDEX_MAX_BYTES,
): SessionContextFile | undefined {
  const files = packet.patchset.files;
  if (files.length === 0) return undefined;

  const byPath = new Map<string, IndexedHunk[]>();
  for (const hunk of packet.hunks.hunks) {
    const list = byPath.get(hunk.path);
    if (list === undefined) byPath.set(hunk.path, [hunk]);
    else list.push(hunk);
  }

  let totalAdded = 0;
  let totalDeleted = 0;
  let totalHunks = 0;
  const rows = files.map((file) => {
    const hunks = byPath.get(file.path) ?? [];
    const { added, deleted } = countsOf(file, hunks);
    totalAdded += added;
    totalDeleted += deleted;
    totalHunks += hunks.length;
    const name =
      file.previousPath === undefined || file.previousPath === file.path
        ? `\`${file.path}\``
        : `\`${file.path}\` (was \`${file.previousPath}\`)`;
    const facts: string[] = [file.status];
    if (file.binary) facts.push("binary");
    facts.push(`+${added} -${deleted}`);
    if (file.modeChange !== undefined) {
      facts.push(`mode ${file.modeChange.old} → ${file.modeChange.new}`);
    }
    const tail =
      hunks.length === 0
        ? file.binary
          ? "no text hunks"
          : "no hunks"
        : `${plural(hunks.length, "hunk")}: ${hunks.map(span).join(", ")}`;
    return `- ${name} — ${facts.join(", ")}, ${tail}`;
  });

  const repo = packet.patchset.repository;
  const reviewed = repo.reviewedTreeOid ?? repo.headOid;
  const head =
    repo.reviewedTreeOid === undefined
      ? `Reviewed range: ${repo.baseOid} (${repo.baseRef}) … ${repo.headOid}.`
      : `Reviewed range: ${repo.baseOid} (${repo.baseRef}) … tree ${repo.reviewedTreeOid} (uncommitted work included).`;
  const header = [
    "# Change index",
    "",
    "Every file the reviewed change touches, with its diffstat and the new-side line span of",
    "each hunk. The host derived this from the captured patchset, so you do not need to run",
    "`git diff --stat` or `git log` to find the change's shape — it is already below.",
    "",
    "This is the SHAPE, not the content: no hunk bodies, no file text. Read those from the",
    `checkout (\`git show ${reviewed}:<path>\`) for the spans you decide to look at.`,
    "",
    head,
    `${plural(files.length, "file")} changed, +${totalAdded} -${totalDeleted}, ${plural(totalHunks, "hunk")}.`,
    "",
    "Spans are new-side line ranges — `12-16` is lines 12 through 16 of the reviewed file;",
    "`9+0` is a hunk that only deletes, sitting at new-side line 9.",
    "",
  ];

  // The bound, applied to the whole rendered body: rows are kept whole until the next one
  // would not fit beside the marker that accounts for the rest.
  const prefix = `${header.join("\n")}\n`;
  let body = prefix;
  let used = utf8Bytes(prefix);
  for (const [index, row] of rows.entries()) {
    const remaining = rows.length - index;
    const marker = `${CHANGE_INDEX_TRUNCATION}${plural(remaining, "more file")}\n`;
    const line = `${row}\n`;
    if (used + utf8Bytes(line) + utf8Bytes(marker) > maxBytes) {
      body += marker;
      break;
    }
    body += line;
    used += utf8Bytes(line);
  }

  return {
    name: CHANGE_INDEX_FILE,
    body,
    holds:
      "The reviewed change's orientation index: every changed file with its status, added/deleted counts and the new-side line span of each hunk.",
    readWhen:
      "first, instead of running `git diff --stat` or `git log` — it is the shape of the change, already derived.",
  };
}
