/**
 * Deterministic, byte-budgeted context assembly (issue #30).
 *
 * The pipeline assembles "what each fleet agent is told" from declared inputs. This
 * module is the PURE, node-free core of that assembly: given an ORDERED list of
 * candidate documents and a byte budget, it produces the byte-exact assembled text,
 * a digest over it, and a per-document record (order, source label, content hash,
 * original + assembled bytes, included/truncated/dropped state).
 *
 * Two properties are load-bearing and golden-tested:
 *  - **Deterministic**: identical inputs → byte-identical assembled text + digest.
 *    A change to the section ordering changes the bytes, so an ordering drift is a
 *    reviewed decision, not a silent shift in review quality.
 *  - **Visible truncation**: the byte budget truncates only at section boundaries
 *    (whole documents, and within a document at line boundaries) and RECORDS every
 *    cut — a truncated document carries a visible marker in the text and a `bytes <
 *    originalBytes` record; a dropped document carries a visible marker and a
 *    `bytes: 0` record. The budget NEVER silently drops content.
 *
 * Repo guidance (CLAUDE.md, AGENTS.md, `.rennet/`) is just another labelled
 * document here — it feeds the assembly directly, labelled by `source`, with no
 * accept/trust step (Rule Zero). Honesty is provided by recording what was sent,
 * not by gating what may be sent.
 */

import { sha256Hex } from "@rennet/protocol";
import type { ContextDocumentRecord, ContextDocumentState } from "@rennet/types";

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
  /** The assembled prompt text, byte-exact — the thing an adapter would send. */
  readonly text: string;
  /** sha256 over {@link text} — the byte-identity anchor. */
  readonly digest: string;
  /** Per-document records in sent order (order, hash, bytes, state). */
  readonly documents: readonly ContextDocumentRecord[];
  /** The total bytes actually assembled across all documents (post-budget). */
  readonly totalBytes: number;
}

/** UTF-8 byte length of a string (the budgeting + record unit). */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The largest prefix of WHOLE LINES of `content` whose UTF-8 byte length is ≤
 * `maxBytes`. Truncation happens only at a line boundary (a section boundary
 * within a document), never mid-line. Returns "" when even the first line exceeds
 * the budget (the caller then records the document as `dropped`, not a 0-byte cut).
 */
function truncateAtLineBoundary(content: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(content) <= maxBytes) return content;
  const lines = content.split("\n");
  let kept = "";
  let keptBytes = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    // Re-add the newline that `split` removed for every line but the first.
    const candidate = kept === "" ? line : `${kept}\n${line}`;
    const candidateBytes = byteLength(candidate);
    if (candidateBytes > maxBytes) break;
    kept = candidate;
    keptBytes = candidateBytes;
  }
  void keptBytes;
  return kept;
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
 * visible marker once the budget is exhausted. Every cut is recorded; nothing is
 * silently dropped.
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

    let state: ContextDocumentState;
    let assembled: string;
    let bytes: number;

    if (remaining >= originalBytes) {
      state = "included";
      assembled = doc.content;
      bytes = originalBytes;
      remaining -= originalBytes;
    } else if (remaining > 0) {
      const truncated = truncateAtLineBoundary(doc.content, remaining);
      const truncatedBytes = byteLength(truncated);
      if (truncatedBytes === 0) {
        // Not even one line fit — record as dropped (a visible omission), not a
        // 0-byte "truncation".
        state = "dropped";
        assembled = "";
        bytes = 0;
      } else {
        state = "truncated";
        assembled = truncated;
        bytes = truncatedBytes;
      }
      remaining = 0;
    } else {
      state = "dropped";
      assembled = "";
      bytes = 0;
    }

    // Visible truncation/drop markers ride IN the assembled text — the reader sees
    // exactly what was cut, never a silent gap.
    if (state === "included") {
      parts.push(`${header}\n${assembled}`);
    } else if (state === "truncated") {
      parts.push(
        `${header}\n${assembled}\n[truncated ${originalBytes - bytes} of ${originalBytes} bytes at section boundary]`,
      );
    } else {
      parts.push(`${header}\n[dropped ${originalBytes} bytes — over byte budget]`);
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
  const totalBytes = records.reduce((sum, record) => sum + record.bytes, 0);
  return { text, digest: sha256Hex(text), documents: records, totalBytes };
}
