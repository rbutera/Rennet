import { DIFF_TRUNCATION_MARKER, type HunkId, type PatchFile, sha256Hex } from "@rennet/protocol";
import { HUNK_HEADER, parseFilePatch } from "../decomposition";

/**
 * One hunk of the patchset, addressable by a stable content-derived id. The
 * header and body are verbatim slices of the unified diff (body lines keep
 * their `+`/`-`/` ` prefix), so the id is an identity over what the reviewer
 * actually sees, not a re-rendering of it.
 *
 * The id contract is PATCHSET-LOCAL rerun stability: the same patchset yields
 * the same ids on every run. It is NOT a cross-round identity — an unchanged
 * hunk whose `@@` header drifts (line moves) mints a new id; carrying identity
 * across rounds is lineage / element-diffs work (B8).
 */
export interface IndexedHunk {
  /**
   * `sha256Hex(path + "\n" + slice)` where `slice` is the hunk's VERBATIM text
   * from the diff — the `@@` header line plus every following line up to the
   * next header, including `\ No newline at end of file` markers. Hashing the
   * raw slice (not the parsed body) keeps positionally distinct changes
   * distinct: a no-newline marker on the deleted side vs the added side is a
   * different change and gets a different id.
   */
  readonly id: HunkId;
  readonly path: string;
  /** The verbatim `@@` header line. */
  readonly header: string;
  /** Verbatim body lines with their unified-diff prefix. */
  readonly body: readonly string[];
  /** The header's 1-based file ranges on each side. */
  readonly spans: {
    readonly old: { readonly start: number; readonly lines: number };
    readonly new: { readonly start: number; readonly lines: number };
  };
  /**
   * True when the file's patch carries `DIFF_TRUNCATION_MARKER`: the id names
   * only the bytes that survived the cap, so content past it is unaccounted
   * for. Consumers must not treat a lossy hunk as a complete identity — the
   * same fail-closed rule the disposition carry applies to file digests.
   */
  readonly lossy: boolean;
}

export interface HunkIndex {
  readonly hunks: readonly IndexedHunk[];
  readonly byId: ReadonlyMap<HunkId, IndexedHunk>;
}

/**
 * Parse every file patch of the (immutable) patchset into hunks with stable
 * ids. Binary and empty patches yield no hunks; nothing throws on them.
 */
/**
 * The verbatim per-hunk slices of a file patch: each slice is the `@@` header
 * line plus every following line up to the next header (or end of patch).
 * Split on the same header regex `parseFilePatch` uses, so the nth slice is
 * the nth parsed hunk's raw text — markers and all.
 */
function hunkSlices(patch: string): string[] {
  const slices: string[] = [];
  let current: string[] | null = null;
  for (const line of patch.split("\n")) {
    if (HUNK_HEADER.test(line)) {
      if (current) slices.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) slices.push(current.join("\n"));
  return slices;
}

export function buildHunkIndex(patchset: { files: readonly PatchFile[] }): HunkIndex {
  const hunks: IndexedHunk[] = [];
  for (const file of patchset.files) {
    if (file.binary || file.patch === "") continue;
    const lossy = file.patch.includes(DIFF_TRUNCATION_MARKER);
    const slices = hunkSlices(file.patch);
    parseFilePatch(file.patch).hunks.forEach((raw, i) => {
      // parseFilePatch retains the verbatim header for every parsed hunk; the
      // optional field only goes absent on synthesized split fragments, which
      // never appear here. Slices and parsed hunks split on the same regex,
      // so index i pairs them.
      const header = raw.header ?? "";
      hunks.push({
        id: sha256Hex(`${file.path}\n${slices[i] ?? ""}`),
        path: file.path,
        header,
        body: raw.body,
        spans: {
          old: { start: raw.oldStart, lines: raw.oldLines },
          new: { start: raw.newStart, lines: raw.newLines },
        },
        lossy,
      });
    });
  }
  return { hunks, byId: new Map(hunks.map((hunk) => [hunk.id, hunk])) };
}
