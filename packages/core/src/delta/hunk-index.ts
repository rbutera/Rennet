import { DIFF_TRUNCATION_MARKER, type HunkId, type PatchFile, sha256Hex } from "@rennet/protocol";
import { parseFilePatch } from "../decomposition";

/**
 * One hunk of the patchset, addressable by a stable content-derived id. The
 * header and body are verbatim slices of the unified diff (body lines keep
 * their `+`/`-`/` ` prefix), so the id is an identity over what the reviewer
 * actually sees, not a re-rendering of it.
 */
export interface IndexedHunk {
  /**
   * `sha256Hex(path + "\n" + header + "\n" + body)` — deterministic: the same
   * patchset yields the same ids on every run, and any body change mints a new id.
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
export function buildHunkIndex(patchset: { files: readonly PatchFile[] }): HunkIndex {
  const hunks: IndexedHunk[] = [];
  for (const file of patchset.files) {
    if (file.binary || file.patch === "") continue;
    const lossy = file.patch.includes(DIFF_TRUNCATION_MARKER);
    for (const raw of parseFilePatch(file.patch).hunks) {
      // parseFilePatch retains the verbatim header for every parsed hunk; the
      // optional field only goes absent on synthesized split fragments, which
      // never appear here.
      const header = raw.header ?? "";
      const body = raw.body;
      hunks.push({
        id: sha256Hex(`${file.path}\n${header}\n${body.join("\n")}`),
        path: file.path,
        header,
        body,
        spans: {
          old: { start: raw.oldStart, lines: raw.oldLines },
          new: { start: raw.newStart, lines: raw.newLines },
        },
        lossy,
      });
    }
  }
  return { hunks, byId: new Map(hunks.map((hunk) => [hunk.id, hunk])) };
}
