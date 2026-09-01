import { parseUnifiedDiffFiles } from "@rennet/adapters";
import { buildHunkIndex } from "@rennet/core";
import {
  type ComposableAsk,
  type HostElement,
  type RoundReportBoard,
  RoundReportBoardSchema,
} from "@rennet/protocol";

export interface RoundReportVerificationEvidence {
  readonly board: RoundReportBoard;
  readonly dispatchedAsks: readonly ComposableAsk[];
  readonly expectedPatchsetId: string;
  readonly diff: string;
  readonly changedPaths: readonly string[];
}

interface FileEvidence {
  readonly canonicalPath: string;
  readonly binary: boolean;
  readonly hasLineChanges: boolean;
}

type RoundOutcome = Extract<HostElement, { kind: "round_outcome" }>;
type CodeRef = Extract<HostElement, { kind: "code_ref" }>;
type ReportSection = Extract<HostElement, { kind: "section" }>;

export const CLASSIFIED_ROUND_REPORT_AUTHOR = {
  kind: "lens-agent" as const,
  id: "round-report",
};
export const CLASSIFIED_ROUND_REPORT_SECTION_ID = "rennet:host:round-report:section";
export const CLASSIFIED_ROUND_REPORT_SECTION_TITLE = "Round outcomes";
export const CLASSIFIED_ROUND_REPORT_STATUS_ORDER = [
  "addressed",
  "partial",
  "untouched",
  "beyond",
] as const;

export function classifiedRoundReportIntro(
  statuses: readonly RoundOutcome["data"]["status"][],
): string {
  const tally = CLASSIFIED_ROUND_REPORT_STATUS_ORDER.flatMap((status) => {
    const count = statuses.filter((current) => current === status).length;
    return count === 0 ? [] : [`${count} ${status}`];
  });
  return `Verified against the coding turn: ${tally.join(", ")}.`;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function hasCanonicalAuthor(element: HostElement): boolean {
  return (
    element.data.author.kind === CLASSIFIED_ROUND_REPORT_AUTHOR.kind &&
    element.data.author.id === CLASSIFIED_ROUND_REPORT_AUTHOR.id
  );
}

function canonicalOutcomeOrder(
  outcomes: readonly RoundOutcome[],
  dispatchedAsks: readonly ComposableAsk[],
): RoundOutcome[] {
  const askOrder = new Map(dispatchedAsks.map((ask, index) => [ask.id, index]));
  return [...outcomes].sort((left, right) => {
    const statusOrder =
      CLASSIFIED_ROUND_REPORT_STATUS_ORDER.indexOf(left.data.status) -
      CLASSIFIED_ROUND_REPORT_STATUS_ORDER.indexOf(right.data.status);
    if (statusOrder !== 0) return statusOrder;
    if (left.data.status === "beyond" && right.data.status === "beyond") {
      return left.data.ask.ref.localeCompare(right.data.ask.ref);
    }
    return (
      (askOrder.get(left.data.ask.ref) ?? Number.MAX_SAFE_INTEGER) -
      (askOrder.get(right.data.ask.ref) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

/**
 * Prove that a classified report is exactly the deterministic board the host emits.
 *
 * Semantic fields (notes and anchors) remain classifier-owned. Everything around them is
 * host-owned, so accepting a merely schema-valid variation would let recovered state claim
 * to be a report the deterministic builder never wrote.
 */
function verifyCanonicalClassifiedRoundReport(
  board: RoundReportBoard,
  dispatchedAsks: readonly ComposableAsk[],
): void {
  if (
    board.elements.some(
      (element) =>
        element.kind !== "section" &&
        element.kind !== "round_outcome" &&
        element.kind !== "code_ref",
    )
  ) {
    throw new Error(
      "Canonical round report only permits section, round_outcome, and code_ref elements.",
    );
  }

  const sections = board.elements.filter(
    (element): element is ReportSection => element.kind === "section",
  );
  const outcomes = board.elements.filter(
    (element): element is RoundOutcome => element.kind === "round_outcome",
  );
  const codeRefs = board.elements.filter(
    (element): element is CodeRef => element.kind === "code_ref",
  );
  const section = sections[0];
  if (
    sections.length !== 1 ||
    section === undefined ||
    section.id !== CLASSIFIED_ROUND_REPORT_SECTION_ID ||
    section.data.title !== CLASSIFIED_ROUND_REPORT_SECTION_TITLE
  ) {
    throw new Error("Canonical round report must contain its one deterministic host section.");
  }
  if (board.elements.some((element) => !hasCanonicalAuthor(element))) {
    throw new Error("Canonical round report elements must use the canonical host author.");
  }
  if (
    !hasExactKeys(section.data, [
      "author",
      "title",
      "children",
      ...(section.data.delta === undefined ? [] : ["delta"]),
    ])
  ) {
    throw new Error("Canonical round report section contains fields the host cannot emit.");
  }
  for (const outcome of outcomes) {
    if (
      !hasExactKeys(outcome.data, [
        "author",
        "status",
        "ask",
        "note",
        ...(outcome.data.code_ref === undefined ? [] : ["code_ref"]),
      ])
    ) {
      throw new Error(`Canonical round report outcome ${outcome.id} contains extra fields.`);
    }
  }
  for (const codeRef of codeRefs) {
    if (
      !hasExactKeys(codeRef.data, [
        "author",
        "patchset_id",
        "path",
        "side",
        "start_line",
        "end_line",
      ])
    ) {
      throw new Error(`Canonical round report code_ref ${codeRef.id} contains extra fields.`);
    }
  }

  const orderedOutcomes = canonicalOutcomeOrder(outcomes, dispatchedAsks);
  const expectedOutcomeIds = orderedOutcomes.map(
    (_outcome, index) => `rennet:host:round-report:${index}:outcome`,
  );
  const childCounts = new Map<string, number>();
  for (const child of section.data.children) {
    childCounts.set(child, (childCounts.get(child) ?? 0) + 1);
  }
  if (
    section.data.children.length !== expectedOutcomeIds.length ||
    expectedOutcomeIds.some((id) => childCounts.get(id) !== 1) ||
    [...childCounts.keys()].some((id) => !expectedOutcomeIds.includes(id))
  ) {
    throw new Error("Canonical round report section must contain every outcome exactly once.");
  }

  const citationCounts = new Map<string, number>();
  for (const outcome of outcomes) {
    if (outcome.data.code_ref === undefined) continue;
    citationCounts.set(outcome.data.code_ref, (citationCounts.get(outcome.data.code_ref) ?? 0) + 1);
  }
  if (
    codeRefs.some((codeRef) => citationCounts.get(codeRef.id) !== 1) ||
    [...citationCounts.keys()].some((id) => !codeRefs.some((codeRef) => codeRef.id === id))
  ) {
    throw new Error("Canonical round report must cite every code_ref exactly once.");
  }

  for (const [index, outcome] of orderedOutcomes.entries()) {
    const expectedOutcomeId = expectedOutcomeIds[index];
    if (expectedOutcomeId === undefined || outcome.id !== expectedOutcomeId) {
      throw new Error(`Canonical round report outcome ${outcome.id} has a non-deterministic id.`);
    }
    if (outcome.data.code_ref !== undefined) {
      const expectedCodeRefId = `rennet:host:round-report:${index}:code`;
      if (outcome.data.code_ref !== expectedCodeRefId) {
        throw new Error(
          `Canonical round report outcome ${outcome.id} cites a non-deterministic id.`,
        );
      }
    }
  }
  // The board service persists creates in dependency order (code ref, outcome, section),
  // not the builder's source-array order. Reading order lives in the section's children;
  // treating Map insertion order as semantic would reject the host's own durable report.
  if (section.data.children.some((child, index) => child !== expectedOutcomeIds[index])) {
    throw new Error("Canonical round report section children are outside deterministic order.");
  }

  if (
    board.document.title !== "Round report" ||
    board.document.introMarkdown !==
      classifiedRoundReportIntro(orderedOutcomes.map((outcome) => outcome.data.status)) ||
    board.document.measure !== "reading" ||
    board.document.sources !== undefined ||
    board.document.stats !== undefined
  ) {
    throw new Error("Canonical round report has a non-deterministic document.");
  }
  const projectedSection = board.sections[0];
  const expectedCounts = outcomes.length === 0 ? {} : { outcomes: outcomes.length };
  if (
    board.sections.length !== 1 ||
    projectedSection === undefined ||
    projectedSection.ref !== CLASSIFIED_ROUND_REPORT_SECTION_ID ||
    projectedSection.gist !== CLASSIFIED_ROUND_REPORT_SECTION_TITLE ||
    projectedSection.delta !== section.data.delta ||
    !hasExactKeys(projectedSection, [
      "ref",
      "gist",
      "counts",
      ...(projectedSection.delta === undefined ? [] : ["delta"]),
    ]) ||
    !hasExactKeys(projectedSection.counts, Object.keys(expectedCounts)) ||
    Object.entries(expectedCounts).some(([kind, count]) => projectedSection.counts[kind] !== count)
  ) {
    throw new Error("Canonical round report has a non-deterministic section tally.");
  }
  if (board.skippedHunks.length !== 0) {
    throw new Error("Canonical round report cannot carry skipped hunks.");
  }
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
): Extract<HostElement, { kind: "code_ref" }> {
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
  if (codeRef.data.start_line !== codeRef.data.end_line) {
    throw new Error(
      `Round report outcome ${outcome.id} must cite one exact changed line, not ${codeRef.data.start_line}-${codeRef.data.end_line}.`,
    );
  }
  const lines = evidence.changedLines.get(lineKey(codeRef.data.side, codeRef.data.path));
  if (!lines?.has(codeRef.data.start_line)) {
    throw new Error(
      `Round report outcome ${outcome.id} cites ${codeRef.data.path}:${codeRef.data.start_line}-${codeRef.data.end_line}, outside the changed lines in the round diff.`,
    );
  }
  return codeRef;
}

function verifyAskPath(
  ask: ComposableAsk,
  codeRef: Extract<HostElement, { kind: "code_ref" }>,
  evidence: ReturnType<typeof evidenceHunks>,
): void {
  const askedFile = evidence.files.get(ask.path);
  const citedFile = evidence.files.get(codeRef.data.path);
  if (
    askedFile === undefined ||
    citedFile === undefined ||
    askedFile.canonicalPath !== citedFile.canonicalPath
  ) {
    throw new Error(
      `Round report outcome for ${ask.id} cites ${codeRef.data.path}, not the asked path ${ask.path}.`,
    );
  }
}

/**
 * Verify the report's structural account against the exact worker receipt.
 *
 * This deliberately proves only facts the host can prove without another model pass: one
 * non-beyond outcome for every exact dispatched ask, no invented/duplicate ask references,
 * and concrete evidence for every claimed change on that ask's path in the measured diff.
 */
export function verifyRoundReportEvidence(input: RoundReportVerificationEvidence): void {
  const board = RoundReportBoardSchema.parse(input.board);
  const asksById = new Map(input.dispatchedAsks.map((ask) => [ask.id, ask]));
  const knownAskIds = new Set(asksById.keys());
  const counts = new Map(input.dispatchedAsks.map((ask) => [ask.id, 0]));
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
    const ask = asksById.get(askRef);
    if (ask === undefined) {
      throw new Error(`Round report contains unknown dispatched ask ${askRef}.`);
    }
    if (element.data.ask.text !== ask.instruction) {
      throw new Error(`Round report rewrites dispatched ask ${askRef}.`);
    }
    counts.set(askRef, prior + 1);
    if (element.data.status === "addressed" || element.data.status === "partial") {
      const codeRef = verifyEvidenceAnchor(
        elementsById,
        element,
        evidence,
        changedPaths,
        input.expectedPatchsetId,
      );
      verifyAskPath(ask, codeRef, evidence);
    } else if (element.data.code_ref !== undefined) {
      throw new Error(`Round report marks untouched ask ${askRef} with change evidence.`);
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
  verifyCanonicalClassifiedRoundReport(board, input.dispatchedAsks);
}
