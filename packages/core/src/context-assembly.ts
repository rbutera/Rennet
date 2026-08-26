/**
 * Deterministic, byte-budgeted context assembly (issue #30).
 *
 * The pipeline composes review context from declared inputs. This
 * module is the PURE, node-free core of that assembly: given an ORDERED list of
 * candidate documents and a byte budget, it produces the byte-exact assembled text,
 * a digest over it, and a per-document record (order, source label, content hash,
 * original + assembled bytes, included/truncated/dropped state).
 *
 * Two properties are load-bearing and golden-tested:
 *  - **Deterministic**: identical inputs → byte-identical assembled text + digest.
 *    A change to the section ordering changes the bytes, so an ordering drift is a
 *    reviewed decision, not a silent shift in review quality.
 *  - **Honest byte accounting**: headers, separators, and visible cut markers draw
 *    from the SAME byte budget as document bodies. A marker is included when it
 *    fits; every cut is recorded even when the budget is too small to render its
 *    marker. `totalBytes` is always the UTF-8 length of the final text.
 *
 * Repo guidance (CLAUDE.md, AGENTS.md, `.rennet/`) is just another labelled
 * document here — it feeds the assembly directly, labelled by `source`, with no
 * accept/trust step (Rule Zero). Honesty is provided by recording what Rennet
 * composed, not by gating what may be composed.
 */

import type { ContextDocumentRecord, ContextDocumentState } from "@rennet/protocol";
import { sha256Hex } from "@rennet/protocol";

/** One candidate document offered to the assembly, in its declared order. */
export interface ContextDocumentInput {
  /** The source label (e.g. "claude-md", "agents-md", "rennet", "project-map", "knowledge"). */
  readonly source: string;
  /** The repo-relative (or synthetic) source path of the document. */
  readonly sourcePath: string;
  /** The document's full content. */
  readonly content: string;
}

/** The result of assembling context: the byte-exact text, its digest, and per-document records. */
export interface ContextAssembly {
  /** The context Rennet assembled, byte-exact. */
  readonly text: string;
  /** sha256 over {@link text} — the byte-identity anchor. */
  readonly digest: string;
  /** Per-document records in composition order (order, hash, bytes, state). */
  readonly documents: readonly ContextDocumentRecord[];
  /** The total bytes actually assembled across all documents (post-budget). */
  readonly totalBytes: number;
}

/** UTF-8 byte length of a string (the budgeting + record unit). */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Every non-empty prefix ending at a line boundary, longest first. */
function lineBoundaryPrefixes(content: string): string[] {
  const lines = content.split("\n");
  const prefixes: string[] = [];
  let kept = "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    kept = i === 0 ? line : `${kept}\n${line}`;
    if (kept.length > 0) prefixes.push(kept);
  }
  return prefixes.reverse();
}

/** Render one document's header, labelled by source (deterministic). */
function renderHeader(source: string, sourcePath: string): string {
  return `### ${source} — ${sourcePath}`;
}

/**
 * Assemble the ordered candidate documents into a byte-budgeted context. Documents
 * are consumed IN THE GIVEN ORDER (the caller declares the order; the assembly is
 * deterministic over it). Each document is included whole if it fits, truncated at
 * a line boundary if it partially fits (with a visible marker), or dropped with a
 * visible marker when that framing fits. Every byte of framing is charged to the
 * same budget as content; every cut remains recorded even when no marker fits.
 */
export function assembleContext(
  documents: readonly ContextDocumentInput[],
  byteBudget: number,
): ContextAssembly {
  const records: ContextDocumentRecord[] = [];
  const parts: string[] = [];
  let remaining = Math.max(0, Math.floor(byteBudget));

  documents.forEach((doc, order) => {
    const originalBytes = byteLength(doc.content);
    const contentHash = sha256Hex(doc.content);
    const header = renderHeader(doc.source, doc.sourcePath);

    const separator = parts.length === 0 ? "" : "\n\n";
    const includedSection = `${separator}${header}\n${doc.content}`;
    let state: ContextDocumentState = "dropped";
    let bytes = 0;
    let rendered = "";

    if (byteLength(includedSection) <= remaining) {
      state = "included";
      bytes = originalBytes;
      rendered = includedSection;
    } else {
      for (const prefix of lineBoundaryPrefixes(doc.content)) {
        const prefixBytes = byteLength(prefix);
        if (prefixBytes >= originalBytes) continue;
        const candidate = `${separator}${header}\n${prefix}\n[truncated ${originalBytes - prefixBytes} of ${originalBytes} bytes at section boundary]`;
        if (byteLength(candidate) > remaining) continue;
        state = "truncated";
        bytes = prefixBytes;
        rendered = candidate;
        break;
      }
      if (rendered === "") {
        const droppedSection = `${separator}${header}\n[dropped ${originalBytes} bytes — over byte budget]`;
        if (byteLength(droppedSection) <= remaining) rendered = droppedSection;
      }
    }

    if (rendered !== "") {
      parts.push(rendered.slice(separator.length));
      remaining -= byteLength(rendered);
    }

    records.push({
      order,
      source: doc.source,
      sourcePath: doc.sourcePath,
      contentHash,
      originalBytes,
      bytes,
      state,
    });
  });

  const text = parts.join("\n\n");
  const totalBytes = byteLength(text);
  return { text, digest: sha256Hex(text), documents: records, totalBytes };
}
