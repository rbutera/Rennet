/**
 * Rennet Surfacing Protocol (RSP) — document core.
 *
 * The document substrate every fleet emission passes through: a universal
 * envelope, a provenance block, an anchor grammar, and the deterministic
 * validator gate. Per-docType body schemas land with angle generation (#8);
 * this module is the core machinery, so `body` is opaque and the validator
 * walks it generically (resolving every `rennet:` anchor and byte-matching every
 * `{ anchor, quote }` evidence pair) without needing to know the body shape.
 *
 * The validator is a pure function of `(document, patchset, offeredManifest,
 * settings)`: no network, no model, no clock. It is standalone-runnable — the
 * future conformance oracle — and here it needs nothing from the app but the
 * offered manifest. Deterministic validation is a MECHANISM in service of
 * digestibility, not the product's purpose.
 */

import type {
  AdmissionKind,
  AnchorKind,
  AnchorSide,
  AnchorSpan,
  OfferedManifest,
  ParsedAnchor,
  PatchsetRef,
  RejectedItem,
  Resolution,
  RspDocType,
  RspEnvelope,
  SettingsProjection,
  SizeLimits,
  ValidationError,
  ValidationReport,
} from "@rennet/types";
import { z } from "zod";
import { validateBodyRules } from "./bodies";
import { sha256Hex } from "./sha256";

// ── Constants ────────────────────────────────────────────────────────────────

/** The RSP major version this build supports. */
export const RSP_MAJOR = 1;

export const ANCHOR_KINDS = [
  "hunk",
  "file",
  "symbol",
  "chunk",
  "patchset",
  "reach",
  "doc",
  "noisegroup",
  "spec",
  "requirement",
] as const satisfies readonly AnchorKind[];

export const ANCHOR_SIDES = [
  "additions",
  "deletions",
  "context",
] as const satisfies readonly AnchorSide[];

export const RSP_DOC_TYPES = [
  "spec.model",
  "decomposition.skeleton",
  "decomposition.proposal",
  "ordering",
  "decision.record",
  "claim",
  "adjudication",
  "test.mapping",
  "noise.patternProposal",
  "anomaly",
  "finding",
  "validation.report",
] as const satisfies readonly RspDocType[];

/**
 * Per-docType admission rules and the supported schemaVersion window.
 *
 * Admission granularity (§4.3): graph documents are atomic (any error rejects
 * the whole document); collection documents are item-wise (valid items admitted,
 * invalid items dropped with a MANDATORY visible rejected-count). `itemsPointer`
 * is populated only where the DSL gives the collection's body array explicitly
 * (decision.record `/body/decisions`, test.mapping `/body/edges`); the remaining
 * collection body schemas — and their pointers — land with #8. Until then an
 * item-wise type with no pointer is validated atomically (stricter, never a
 * silent mis-admission).
 */
export interface DocTypeSpec {
  admission: AdmissionKind;
  supportedSchemaVersions: readonly number[];
  itemsPointer?: string;
}

export const DOC_TYPE_REGISTRY: Readonly<Record<RspDocType, DocTypeSpec>> = {
  "spec.model": { admission: "atomic", supportedSchemaVersions: [1] },
  "decomposition.skeleton": { admission: "atomic", supportedSchemaVersions: [1] },
  "decomposition.proposal": { admission: "atomic", supportedSchemaVersions: [1] },
  // The comprehension ordering (#9) is admitted whole: a broken order is not a
  // set of independently-droppable items.
  ordering: { admission: "atomic", supportedSchemaVersions: [1] },
  "decision.record": {
    admission: "itemwise",
    supportedSchemaVersions: [1],
    itemsPointer: "/body/decisions",
  },
  claim: { admission: "itemwise", supportedSchemaVersions: [1] },
  adjudication: { admission: "atomic", supportedSchemaVersions: [1] },
  "test.mapping": {
    admission: "itemwise",
    supportedSchemaVersions: [1],
    itemsPointer: "/body/edges",
  },
  "noise.patternProposal": { admission: "itemwise", supportedSchemaVersions: [1] },
  anomaly: { admission: "itemwise", supportedSchemaVersions: [1] },
  finding: { admission: "itemwise", supportedSchemaVersions: [1] },
  "validation.report": { admission: "atomic", supportedSchemaVersions: [1] },
};

/**
 * Default size limits (§4.2). Exceeding one is a REJECTION, never a truncation.
 * There is no item-count limit: decisions are never capped. `documentBytes` is a
 * whole-document DoS guard on total serialized size, not a cap on item count.
 */
export const DEFAULT_SIZE_LIMITS: SizeLimits = {
  documentBytes: 512 * 1024,
  quoteBytes: 2 * 1024,
};

export const DEFAULT_SETTINGS: SettingsProjection = { sizeLimits: DEFAULT_SIZE_LIMITS };

// ── Zod schemas (V002) ───────────────────────────────────────────────────────

const capabilityLayersSchema = z.object({
  implementedByAdapter: z.boolean(),
  advertisedByHarness: z.boolean(),
  availableInSession: z.boolean(),
});

const tokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative(),
});

// `capability` is a record so that V003 can assert the two required capability
// NAMES semantically (a schema enum could not distinguish "missing a required
// name" from "present with an extra name").
const provenanceSchema = z
  .object({
    harness: z.string().min(1),
    harnessVersion: z.string().min(1),
    adapterVersion: z.string().min(1),
    model: z.string().min(1),
    modelReportedBy: z.enum(["harness", "config", "unknown"]),
    tier: z.enum(["heavy", "light", "deterministic"]),
    route: z.enum(["agentic", "utility", "deterministic"]),
    runId: z.string().min(1),
    inputDigest: z.string().min(1),
    capability: z.record(z.string(), capabilityLayersSchema),
    tokens: tokenUsageSchema,
    reportedUsd: z.number().nullable(),
    derivedUsd: z.number().nullable(),
    sampleGroupId: z.string().min(1).optional(),
    sampleIndex: z.number().int().nonnegative().optional(),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
  })
  .loose();

// A Crockford base32 ULID (uuidv7-shaped), minted by the adapter, never the agent.
const docIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

// `docType` is a plain string here so an unknown value passes the schema and is
// rejected LOUDLY by V001 with a specific message. `x` is required and preserves
// unknown extension keys; `.loose()` keeps unknown top-level keys rather than
// dropping them silently (raw-frame doctrine).
export const rspEnvelopeSchema = z
  .object({
    rsp: z.number().int(),
    docType: z.string().min(1),
    schemaVersion: z.number().int(),
    docId: docIdSchema.optional(),
    patchsetId: z.string().min(1),
    reviewId: z.string().min(1).optional(),
    projectSnapshotId: z.string().min(1).optional(),
    supersedes: z.string().min(1).nullable().optional(),
    provenance: provenanceSchema,
    body: z.unknown(),
    x: z.record(z.string(), z.unknown()),
  })
  .loose();

// ── Canonical serialisation + input digest ───────────────────────────────────

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Canonical JSON: recursively sorted keys, 2-space indent, LF. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value), null, 2);
}

/**
 * The `inputDigest` the validator recomputes for V009. Scoped in slice 1 to the
 * patchset identity plus the offered manifest — the part the validator can
 * reproduce with zero app context. Order-independent: occurrences and lineage
 * are sorted by id before hashing.
 */
export function computeInputDigest(patchset: PatchsetRef, manifest: OfferedManifest): string {
  const occurrences = manifest.occurrences
    .map((occurrence) => ({
      id: occurrence.id,
      kind: occurrence.kind,
      sides: occurrence.sides ?? null,
    }))
    .sort((a, b) => compareStrings(a.id, b.id));
  const lineage = (manifest.lineage ?? [])
    .map((entry) => ({ fromId: entry.fromId, lineage: entry.lineage, toId: entry.toId ?? null }))
    .sort((a, b) => compareStrings(a.fromId, b.fromId));
  return `sha256:${sha256Hex(canonicalize({ patchsetId: patchset.id, occurrences, lineage }))}`;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ── Anchor grammar (§3.1) ────────────────────────────────────────────────────

// rennet: kind / id [ # frag ] [ @ side ] [ ^ proposal ]
// `id` allows `/` and `.` (symbol paths); `frag` excludes `@`/`^` so side and
// proposal parse unambiguously.
const ANCHOR_RE =
  /^rennet:([a-z]+)\/([A-Za-z0-9_./-]{1,64})(?:#([^@^]+))?(?:@([a-z]+))?(?:\^([0-9A-Za-z]{26}))?$/;

export type AnchorParse =
  | { ok: true; anchor: ParsedAnchor }
  | { ok: false; reason: "malformed" | "unknown-kind" | "unknown-side" };

/** Parse a `rennet:` anchor string against the grammar. */
export function parseAnchor(raw: string): AnchorParse {
  const match = ANCHOR_RE.exec(raw);
  if (!match) return { ok: false, reason: "malformed" };
  const [, kindRaw, id, fragRaw, sideRaw, proposal] = match;
  // `kind` and `id` are non-optional capture groups, so a match guarantees them;
  // the guard satisfies the type checker under noUncheckedIndexedAccess.
  if (kindRaw === undefined || id === undefined) return { ok: false, reason: "malformed" };
  if (!(ANCHOR_KINDS as readonly string[]).includes(kindRaw))
    return { ok: false, reason: "unknown-kind" };

  const anchor: ParsedAnchor = { raw, kind: kindRaw as AnchorKind, id };

  if (fragRaw !== undefined) {
    if (fragRaw.startsWith("L")) {
      const span = parseSpan(fragRaw);
      if (!span) return { ok: false, reason: "malformed" };
      anchor.span = span;
    } else if (fragRaw.startsWith("/")) {
      anchor.pointer = fragRaw;
    } else {
      return { ok: false, reason: "malformed" };
    }
  }

  if (sideRaw !== undefined) {
    if (!(ANCHOR_SIDES as readonly string[]).includes(sideRaw))
      return { ok: false, reason: "unknown-side" };
    anchor.side = sideRaw as AnchorSide;
  }

  if (proposal !== undefined) anchor.proposal = proposal;

  return { ok: true, anchor };
}

function parseSpan(frag: string): AnchorSpan | null {
  const match = /^L(\d+)(?:-L(\d+))?$/.exec(frag);
  if (!match) return null;
  const startLine = Number(match[1]);
  if (startLine < 1) return null;
  if (match[2] === undefined) return { startLine };
  const endLine = Number(match[2]);
  if (endLine < startLine) return null;
  return { startLine, endLine };
}

// ── Resolution (§3.3) — a total function with four outcomes and no fifth ──────

/** Resolve a parsed anchor against a patchset's offered manifest. */
export function resolveAnchor(parsed: ParsedAnchor, manifest: OfferedManifest): Resolution {
  const occurrence = manifest.occurrences.find((candidate) => candidate.id === parsed.id);
  if (occurrence) {
    if (parsed.span) {
      const lines = parsed.side ? occurrence.sides?.[parsed.side] : undefined;
      // Spans are always side-qualified (§3.2); a span with no resolvable side
      // line source cannot resolve.
      if (!lines) return { outcome: "unresolved", reason: "no-such-side" };
      const end = parsed.span.endLine ?? parsed.span.startLine;
      if (parsed.span.startLine > lines.length || end > lines.length) {
        return { outcome: "unresolved", reason: "out-of-bounds" };
      }
      const resolvedText = lines.slice(parsed.span.startLine - 1, end).join("\n");
      return { outcome: "resolved", occurrenceId: occurrence.id, resolvedText };
    }
    return { outcome: "resolved", occurrenceId: occurrence.id };
  }

  const entry = manifest.lineage?.find((candidate) => candidate.fromId === parsed.id);
  if (entry) {
    // Ambiguity fails closed: an ambiguous or terminated lineage never carries
    // read-state forward; it orphans, surfaced against its last known version.
    if (
      entry.lineage === "ambiguous" ||
      entry.lineage === "terminated" ||
      entry.toId === undefined
    ) {
      return { outcome: "orphaned", lineage: entry.lineage, carriesState: false };
    }
    return {
      outcome: "superseded",
      occurrenceId: entry.toId,
      lineage: entry.lineage,
      carriesState: true,
    };
  }

  // Not in the manifest and not in the lineage graph: an agent-minted identity.
  return { outcome: "unresolved", reason: "minted" };
}

/** The declared quote normalisation (§3.4): CRLF→LF, trailing whitespace
 *  stripped per line, leading indentation preserved. */
export function normalizeQuote(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

// ── The validator (§4) ───────────────────────────────────────────────────────

export interface ValidatorInput {
  readonly document: unknown;
  readonly patchset: PatchsetRef;
  readonly manifest: OfferedManifest;
  readonly settings?: SettingsProjection;
}

/**
 * The deterministic admission gate. Pure function of
 * `(document, patchset, offeredManifest, settings)`; standalone-runnable.
 */
export function validateDocument(input: ValidatorInput): ValidationReport {
  const settings = input.settings ?? DEFAULT_SETTINGS;

  // V002 — envelope + provenance shape.
  const parsed = rspEnvelopeSchema.safeParse(input.document);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => ({
      code: "V002",
      pointer: pointerOf(issue.path),
      message: issue.message,
    }));
    return atomicReject(null, null, errors);
  }
  const doc = parsed.data as unknown as RspEnvelope;
  const envelopeErrors: ValidationError[] = [];

  // V001 — rsp major, docType known, schemaVersion window.
  if (doc.rsp !== RSP_MAJOR) {
    envelopeErrors.push({
      code: "V001",
      pointer: "/rsp",
      message: `unsupported rsp major ${doc.rsp}`,
    });
  }
  const isKnownType = (RSP_DOC_TYPES as readonly string[]).includes(doc.docType);
  if (!isKnownType) {
    envelopeErrors.push({
      code: "V001",
      pointer: "/docType",
      message: `unknown docType ${JSON.stringify(doc.docType)}`,
    });
    return atomicReject(null, null, envelopeErrors);
  }
  const docType = doc.docType as RspDocType;
  const spec = DOC_TYPE_REGISTRY[docType];
  if (!spec.supportedSchemaVersions.includes(doc.schemaVersion)) {
    envelopeErrors.push({
      code: "V001",
      pointer: "/schemaVersion",
      message: `schemaVersion ${doc.schemaVersion} outside the supported window for ${docType}`,
    });
  }

  // V003 — provenance carries both required capabilities, each with three layers.
  for (const name of ["structuredOutput", "perCallModelSelection"] as const) {
    const capability = doc.provenance.capability[name];
    if (!isThreeLayer(capability)) {
      envelopeErrors.push({
        code: "V003",
        pointer: `/provenance/capability/${name}`,
        message: `provenance capability ${name} must carry all three layers`,
      });
    }
  }

  // V009 — inputDigest equals the digest of the offered manifest.
  const expectedDigest = computeInputDigest(input.patchset, input.manifest);
  if (doc.provenance.inputDigest !== expectedDigest) {
    envelopeErrors.push({
      code: "V009",
      pointer: "/provenance/inputDigest",
      message: "inputDigest does not match the offered manifest",
      detail: { expected: expectedDigest },
    });
  }

  // V004 — whole-document size limit (reject, never truncate).
  const documentBytes = utf8Length(canonicalize(doc));
  if (documentBytes > settings.sizeLimits.documentBytes) {
    envelopeErrors.push({
      code: "V004",
      pointer: "",
      message: `document ${documentBytes} bytes exceeds the limit of ${settings.sizeLimits.documentBytes}`,
    });
  }

  // Any envelope-level error rejects the whole document, whatever the admission
  // kind: a collection document with a broken envelope is atomic too.
  if (envelopeErrors.length > 0) return atomicReject(docType, spec.admission, envelopeErrors);

  // Body anchor / quote / vocabulary / quote-size checks.
  if (spec.admission === "itemwise" && spec.itemsPointer !== undefined) {
    return validateItemwise(doc, docType, spec.itemsPointer, input.manifest, settings);
  }
  // Atomic (or an item-wise type whose body pointer is a #8 deliverable):
  // validate the whole body; any error rejects the whole document. The generic
  // anchor/quote walk runs for every docType; per-body semantic rules (#8) run
  // for docTypes that have a body schema (the decomposition documents) and are
  // `[]` for every other type, so the merge is unconditional.
  const genericErrors = validateSubtree(doc.body, "/body", input.manifest, settings);
  // The per-body validator receives the whole manifest so each document family
  // derives the occurrence kind it constrains: decomposition over `hunk`
  // occurrences, ordering (#9) over `chunk` occurrences.
  const perBodyErrors = validateBodyRules(docType, doc.body, input.manifest);
  const bodyErrors = [...genericErrors, ...perBodyErrors];
  if (bodyErrors.length > 0) return atomicReject(docType, spec.admission, bodyErrors);
  return {
    docType,
    admission: spec.admission,
    admitted: true,
    errors: [],
    admittedItemCount: null,
    rejectedItemCount: 0,
    rejectedItems: [],
  };
}

function validateItemwise(
  doc: RspEnvelope,
  docType: RspDocType,
  itemsPointer: string,
  manifest: OfferedManifest,
  settings: SettingsProjection,
): ValidationReport {
  const items = resolvePointer(doc, itemsPointer);
  if (!Array.isArray(items)) {
    return atomicReject(docType, "itemwise", [
      {
        code: "V002",
        pointer: itemsPointer,
        message: `expected a collection array at ${itemsPointer}`,
      },
    ]);
  }

  const rejectedItems: RejectedItem[] = [];
  let admittedItemCount = 0;
  items.forEach((item, index) => {
    const itemPointer = `${itemsPointer}/${index}`;
    const itemErrors = validateSubtree(item, itemPointer, manifest, settings);
    if (itemErrors.length > 0) {
      rejectedItems.push({ pointer: itemPointer, errors: itemErrors });
    } else {
      admittedItemCount += 1;
    }
  });

  // The document is admitted (envelope is sound); the rejected count is always
  // visible, never a silent per-item drop.
  return {
    docType,
    admission: "itemwise",
    admitted: true,
    errors: [],
    admittedItemCount,
    rejectedItemCount: rejectedItems.length,
    rejectedItems,
  };
}

/** Collect every anchor and quote error within a subtree. */
function validateSubtree(
  node: unknown,
  basePointer: string,
  manifest: OfferedManifest,
  settings: SettingsProjection,
): ValidationError[] {
  const errors: ValidationError[] = [];

  forEachAnchorString(node, basePointer, (raw, pointer) => {
    const error = checkAnchorString(raw, pointer, manifest);
    if (error) errors.push(error);
  });

  forEachQuoted(node, basePointer, (anchorRaw, quote, pointer) => {
    // V004 — quote size.
    const quoteBytes = utf8Length(quote);
    if (quoteBytes > settings.sizeLimits.quoteBytes) {
      errors.push({
        code: "V004",
        pointer: `${pointer}/quote`,
        message: `quote ${quoteBytes} bytes exceeds the limit of ${settings.sizeLimits.quoteBytes}`,
      });
      return;
    }
    // V006 — byte-match against the resolved span. A resolution error, if any,
    // is already reported by the anchor pass, so only match when it resolves.
    const anchor = parseAnchor(anchorRaw);
    if (!anchor.ok) return;
    const resolution = resolveAnchor(anchor.anchor, manifest);
    if (resolution.outcome !== "resolved" || resolution.resolvedText === undefined) return;
    if (normalizeQuote(quote) !== normalizeQuote(resolution.resolvedText)) {
      errors.push({
        code: "V006",
        pointer: `${pointer}/quote`,
        message: "quote does not match the resolved span byte-for-byte",
        detail: { anchor: anchorRaw },
      });
    }
  });

  return errors;
}

/** V005 / V007 / V008 for one anchor string. */
function checkAnchorString(
  raw: string,
  pointer: string,
  manifest: OfferedManifest,
): ValidationError | null {
  const anchor = parseAnchor(raw);
  if (!anchor.ok) {
    if (anchor.reason === "unknown-kind") {
      return {
        code: "V007",
        pointer,
        message: `anchor kind is not in the closed vocabulary: ${raw}`,
      };
    }
    if (anchor.reason === "unknown-side") {
      return {
        code: "V007",
        pointer,
        message: `anchor side is not in the closed vocabulary: ${raw}`,
      };
    }
    return { code: "V005", pointer, message: `malformed anchor: ${raw}` };
  }

  const resolution = resolveAnchor(anchor.anchor, manifest);
  if (resolution.outcome === "resolved") return null;
  if (resolution.outcome === "unresolved" && resolution.reason === "minted") {
    return {
      code: "V008",
      pointer,
      message: `anchor id is not in the offered manifest (agent-minted identity): ${raw}`,
    };
  }
  const detail = resolution.reason
    ? `${resolution.outcome}: ${resolution.reason}`
    : resolution.outcome;
  return {
    code: "V005",
    pointer,
    message: `anchor does not resolve in the offered manifest (${detail}): ${raw}`,
  };
}

// ── Generic body walk ────────────────────────────────────────────────────────

function forEachAnchorString(
  node: unknown,
  pointer: string,
  callback: (raw: string, pointer: string) => void,
): void {
  if (typeof node === "string") {
    if (node.startsWith("rennet:")) callback(node, pointer);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((value, index) => {
      forEachAnchorString(value, `${pointer}/${index}`, callback);
    });
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      forEachAnchorString(value, `${pointer}/${escapePointer(key)}`, callback);
    }
  }
}

function forEachQuoted(
  node: unknown,
  pointer: string,
  callback: (anchor: string, quote: string, pointer: string) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((value, index) => {
      forEachQuoted(value, `${pointer}/${index}`, callback);
    });
    return;
  }
  if (node !== null && typeof node === "object") {
    const object = node as Record<string, unknown>;
    if (typeof object.anchor === "string" && typeof object.quote === "string") {
      callback(object.anchor, object.quote, pointer);
    }
    for (const [key, value] of Object.entries(object)) {
      forEachQuoted(value, `${pointer}/${escapePointer(key)}`, callback);
    }
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

function atomicReject(
  docType: RspDocType | null,
  admission: AdmissionKind | null,
  errors: ValidationError[],
): ValidationReport {
  return {
    docType,
    admission,
    admitted: false,
    errors,
    admittedItemCount: null,
    rejectedItemCount: 0,
    rejectedItems: [],
  };
}

function isThreeLayer(capability: unknown): boolean {
  if (capability === null || typeof capability !== "object") return false;
  const layers = capability as Record<string, unknown>;
  return (
    typeof layers.implementedByAdapter === "boolean" &&
    typeof layers.advertisedByHarness === "boolean" &&
    typeof layers.availableInSession === "boolean"
  );
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const part of parts) {
    if (current !== null && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function pointerOf(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "";
  return `/${path.map((segment) => escapePointer(String(segment))).join("/")}`;
}
