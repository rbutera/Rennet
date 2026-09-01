import {
  type ComposableAsk,
  type HostElement,
  type RoundEvidenceAnchor,
  type RoundEvidenceUnit,
  type RoundReportBoard,
  RoundReportBoardSchema,
} from "@rennet/protocol";
import {
  buildRoundEvidenceManifest,
  verifyRoundEvidencePartition,
} from "./round-evidence-manifest";

export interface RoundReportVerificationEvidence {
  readonly board: RoundReportBoard;
  readonly dispatchedAsks: readonly ComposableAsk[];
  readonly expectedPatchsetId: string;
  readonly diff: string;
  readonly changedPaths: readonly string[];
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
        ...(outcome.data.evidence_ids === undefined ? [] : ["evidence_ids"]),
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

/**
 * The round's evidence manifest, rebuilt from the measured diff. The verifier parses
 * the diff itself rather than trusting the board: this is the check that a RECOVERED
 * report is the report the deterministic builder would have written for this exact
 * coding turn, ids and anchors included.
 */
function manifestFor(diff: string): {
  readonly units: readonly RoundEvidenceUnit[];
  readonly byId: ReadonlyMap<string, RoundEvidenceUnit>;
} {
  const units = buildRoundEvidenceManifest(diff);
  return { units, byId: new Map(units.map((unit) => [unit.id, unit])) };
}

function previousPathOf(unit: RoundEvidenceUnit): string | undefined {
  return "previousPath" in unit ? unit.previousPath : undefined;
}

/** The host's anchor derivation, mirrored here so the stored board can be held to it:
 *  the first cited TEXT HUNK in canonical manifest order, preferring the ask's path. */
function derivedAnchor(
  ids: readonly string[],
  units: readonly RoundEvidenceUnit[],
  preferredPath?: string,
): RoundEvidenceAnchor | undefined {
  const cited = new Set(ids);
  const hunks = units.filter(
    (unit): unit is Extract<RoundEvidenceUnit, { kind: "text-hunk" }> =>
      unit.kind === "text-hunk" && cited.has(unit.id),
  );
  const preferred =
    preferredPath === undefined
      ? undefined
      : hunks.find((unit) => unit.path === preferredPath || unit.anchor.path === preferredPath);
  return (preferred ?? hunks[0])?.anchor;
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

/**
 * Verify one outcome's evidence: every cited id is real manifest evidence on a path the
 * round actually changed, and the displayed anchor is EXACTLY the one the host derives
 * from that evidence — or absent, when every cited unit is a rename, a mode change, or a
 * binary file. Nothing here accepts a line number the diff does not carry.
 */
function verifyOutcomeEvidence(
  elementsById: ReadonlyMap<string, HostElement>,
  outcome: Extract<HostElement, { kind: "round_outcome" }>,
  manifest: ReturnType<typeof manifestFor>,
  changedPaths: ReadonlySet<string>,
  expectedPatchsetId: string,
  askPath?: string,
): void {
  const ids = outcome.data.evidence_ids ?? [];
  if (ids.length === 0) {
    throw new Error(
      `Round report outcome ${outcome.id} (${outcome.data.status}) cites no round evidence.`,
    );
  }
  const cited = ids.map((id) => {
    const unit = manifest.byId.get(id);
    if (unit === undefined) {
      throw new Error(
        `Round report outcome ${outcome.id} cites evidence ${id}, which is absent from the round diff.`,
      );
    }
    if (!changedPaths.has(unit.path)) {
      throw new Error(
        `Round report outcome ${outcome.id} cites ${unit.path}, which is absent from the round diff.`,
      );
    }
    return unit;
  });
  if (
    askPath !== undefined &&
    !cited.some(
      (unit) =>
        unit.path === askPath ||
        previousPathOf(unit) === askPath ||
        (unit.kind === "text-hunk" && unit.anchor.path === askPath),
    )
  ) {
    throw new Error(
      `Round report outcome ${outcome.id} cites no evidence on the asked path ${askPath}.`,
    );
  }
  const anchor = derivedAnchor(ids, manifest.units, askPath);
  if (anchor === undefined) {
    if (outcome.data.code_ref !== undefined) {
      throw new Error(
        `Round report outcome ${outcome.id} anchors a line, but its evidence has no line-addressable change.`,
      );
    }
    return;
  }
  const codeRef = citedElement(elementsById, outcome);
  if (codeRef.data.patchset_id !== expectedPatchsetId) {
    throw new Error(
      `Round report outcome ${outcome.id} cites patchset ${codeRef.data.patchset_id}, not ${expectedPatchsetId}.`,
    );
  }
  if (
    codeRef.data.path !== anchor.path ||
    codeRef.data.side !== anchor.side ||
    codeRef.data.start_line !== anchor.line ||
    codeRef.data.end_line !== anchor.line
  ) {
    throw new Error(
      `Round report outcome ${outcome.id} anchors ${codeRef.data.side} ${codeRef.data.path}:${codeRef.data.start_line}-${codeRef.data.end_line}, not the derived ${anchor.side} ${anchor.path}:${anchor.line}.`,
    );
  }
}

export function verifyRoundReportEvidence(input: RoundReportVerificationEvidence): void {
  const board = RoundReportBoardSchema.parse(input.board);
  const asksById = new Map(input.dispatchedAsks.map((ask) => [ask.id, ask]));
  const knownAskIds = new Set(asksById.keys());
  const counts = new Map(input.dispatchedAsks.map((ask) => [ask.id, 0]));
  const beyondRefs = new Set<string>();
  const elementsById = new Map(board.elements.map((element) => [element.id, element]));
  const manifest = manifestFor(input.diff);
  const changedPaths = new Set(input.changedPaths);

  // #726 — the durable report partitions the round's evidence exactly once. A
  // recovered board that lost, duplicated, or invented an id fails here, before it can
  // be reused as this round's report.
  verifyRoundEvidencePartition(
    board.elements.flatMap((element) =>
      element.kind === "round_outcome"
        ? [
            {
              bucket: `outcome ${element.id}`,
              evidenceIds: element.data.evidence_ids ?? [],
            },
          ]
        : [],
    ),
    manifest.units,
  );

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
      verifyOutcomeEvidence(
        elementsById,
        element,
        manifest,
        changedPaths,
        input.expectedPatchsetId,
      );
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
      verifyOutcomeEvidence(
        elementsById,
        element,
        manifest,
        changedPaths,
        input.expectedPatchsetId,
        ask.path,
      );
    } else if (element.data.code_ref !== undefined || element.data.evidence_ids !== undefined) {
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
