import { parseUnifiedDiffFiles } from "@rennet/adapters";
import { buildHunkIndex } from "@rennet/core";
import { type HostElement, type RoundReportBoard, RoundReportBoardSchema } from "@rennet/protocol";

export interface RoundReportVerificationEvidence {
  readonly board: RoundReportBoard;
  readonly dispatchedAskIds: readonly string[];
  readonly expectedPatchsetId: string;
  readonly diff: string;
  readonly changedPaths: readonly string[];
}

interface FileEvidence {
  readonly canonicalPath: string;
  readonly binary: boolean;
  readonly hasLineChanges: boolean;
}

function lineKey(side: "base" | "head", path: string): string {
  return `${side}\0${path}`;
}

function evidenceHunks(diff: string): {
  readonly changedLines: ReadonlyMap<string, ReadonlySet<number>>;
  readonly files: ReadonlyMap<string, FileEvidence>;
} {
  const patchFiles = parseUnifiedDiffFiles(diff, Number.POSITIVE_INFINITY);
  const indexed = buildHunkIndex({ files: patchFiles });
  const changedLines = new Map<string, Set<number>>();
  const files = new Map<string, FileEvidence>();

  const addLine = (side: "base" | "head", path: string, line: number): void => {
    const key = lineKey(side, path);
    const lines = changedLines.get(key) ?? new Set<number>();
    lines.add(line);
    changedLines.set(key, lines);
  };

  for (const file of patchFiles) {
    const fileHunks = indexed.hunks.filter((hunk) => hunk.path === file.path);
    const basePath = file.previousPath ?? file.path;
    let fileHasLineChanges = false;
    for (const hunk of fileHunks) {
      let oldLine = hunk.spans.old.start;
      let newLine = hunk.spans.new.start;
      for (const line of hunk.body) {
        if (line.startsWith("+")) {
          addLine("head", file.path, newLine);
          newLine += 1;
          fileHasLineChanges = true;
        } else if (line.startsWith("-")) {
          addLine("base", basePath, oldLine);
          oldLine += 1;
          fileHasLineChanges = true;
        } else if (line.startsWith(" ")) {
          oldLine += 1;
          newLine += 1;
        }
      }
    }
    const fileEvidence = {
      canonicalPath: file.path,
      binary: file.binary,
      hasLineChanges: fileHasLineChanges,
    };
    files.set(file.path, fileEvidence);
    if (file.previousPath !== undefined) {
      files.set(file.previousPath, fileEvidence);
    }
  }

  return { changedLines, files };
}

function citedElement(
  elementsById: ReadonlyMap<string, HostElement>,
  outcome: Extract<HostElement, { kind: "round_outcome" }>,
): Extract<HostElement, { kind: "code_ref" }> {
  const ref = outcome.data.code_ref;
  if (ref === undefined) {
    throw new Error(
      `Round report outcome ${outcome.id} (${outcome.data.status}) has no diff evidence anchor.`,
    );
  }
  const element = elementsById.get(ref);
  if (element?.kind !== "code_ref") {
    throw new Error(`Round report outcome ${outcome.id} cites missing code_ref ${ref}.`);
  }
  return element;
}

function verifyEvidenceAnchor(
  elementsById: ReadonlyMap<string, HostElement>,
  outcome: Extract<HostElement, { kind: "round_outcome" }>,
  evidence: ReturnType<typeof evidenceHunks>,
  changedPaths: ReadonlySet<string>,
  expectedPatchsetId: string,
): void {
  const codeRef = citedElement(elementsById, outcome);
  if (codeRef.data.patchset_id !== expectedPatchsetId) {
    throw new Error(
      `Round report outcome ${outcome.id} cites patchset ${codeRef.data.patchset_id}, not ${expectedPatchsetId}.`,
    );
  }
  const file = evidence.files.get(codeRef.data.path);
  if (file === undefined || !changedPaths.has(file.canonicalPath)) {
    throw new Error(
      `Round report outcome ${outcome.id} cites ${codeRef.data.path}, which is absent from the round diff.`,
    );
  }
  if (file.binary || !file.hasLineChanges) {
    throw new Error(
      `Round report outcome ${outcome.id} cites ${codeRef.data.path}, which has no line-addressable change in the round diff.`,
    );
  }
  const lines = evidence.changedLines.get(lineKey(codeRef.data.side, codeRef.data.path));
  const overlapsChangedLine =
    lines !== undefined &&
    [...lines].some((line) => line >= codeRef.data.start_line && line <= codeRef.data.end_line);
  if (!overlapsChangedLine) {
    throw new Error(
      `Round report outcome ${outcome.id} cites ${codeRef.data.path}:${codeRef.data.start_line}-${codeRef.data.end_line}, outside the changed lines in the round diff.`,
    );
  }
}

/**
 * Verify the report's structural account against the exact worker receipt.
 *
 * This deliberately proves only facts the host can prove without another model pass: one
 * non-beyond outcome for every dispatched ask, no invented/duplicate ask references, and
 * concrete evidence for every claimed change that resolves into the measured round diff.
 */
export function verifyRoundReportEvidence(input: RoundReportVerificationEvidence): void {
  const board = RoundReportBoardSchema.parse(input.board);
  const knownAskIds = new Set(input.dispatchedAskIds);
  const counts = new Map(input.dispatchedAskIds.map((id) => [id, 0]));
  const beyondRefs = new Set<string>();
  const elementsById = new Map(board.elements.map((element) => [element.id, element]));
  const evidence = evidenceHunks(input.diff);
  const changedPaths = new Set(input.changedPaths);

  for (const element of board.elements) {
    if (element.kind !== "round_outcome") continue;
    const askRef = element.data.ask.ref;
    if (element.data.status === "beyond") {
      if (knownAskIds.has(askRef)) {
        throw new Error(`Round report marks dispatched ask ${askRef} as beyond the asks.`);
      }
      if (beyondRefs.has(askRef)) {
        throw new Error(`Round report repeats beyond-ask reference ${askRef}.`);
      }
      beyondRefs.add(askRef);
      verifyEvidenceAnchor(elementsById, element, evidence, changedPaths, input.expectedPatchsetId);
      continue;
    }

    const prior = counts.get(askRef);
    if (prior === undefined) {
      throw new Error(`Round report contains unknown dispatched ask ${askRef}.`);
    }
    counts.set(askRef, prior + 1);
    if (element.data.status === "addressed" || element.data.status === "partial") {
      verifyEvidenceAnchor(elementsById, element, evidence, changedPaths, input.expectedPatchsetId);
    }
  }

  const missing = [...counts].filter(([, count]) => count === 0).map(([id]) => id);
  if (missing.length > 0) {
    throw new Error(`Round report omitted dispatched asks: ${missing.join(", ")}`);
  }
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicates.length > 0) {
    throw new Error(`Round report repeats dispatched asks: ${duplicates.join(", ")}`);
  }
}
