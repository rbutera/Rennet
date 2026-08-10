/**
 * The LLM knowledge layer read side (layer c, #14 knowledge half — design §6).
 *
 * This is the ONLY Repo Map layer a model writes, but this module is itself pure
 * and model-free: it validates the stored statement shape, resolves evidence
 * anchors against a snapshot, and answers `context.knowledge` from a stored
 * {@link KnowledgeSet} + a materialized snapshot. The model turn that MINTS
 * statements lives in `knowledge-generation.ts` (still node-free — the model
 * wiring is injected); the store I/O and the real harness call live in adapters.
 *
 * The honesty contract (design §6, spec repo-map-knowledge):
 *  - every statement carries EVIDENCE ANCHORS that resolve, PROVENANCE, a
 *    CONFIDENCE, and the snapshot it was learned against;
 *  - a model-derived statement is a LABELLED HYPOTHESIS until confirmed — served
 *    verbatim WITH its `status`, never re-labelled to an asserted fact;
 *  - a statement whose anchors do not resolve is INVALID and is never served;
 *  - a statement whose inputs the CURRENT snapshot changed is disclosed as
 *    INVALIDATED-PENDING, never silently dropped.
 *
 * An anchor RESOLVES against a snapshot iff the file at its `path` still carries
 * the anchor's `blobOid` in that snapshot's file inventory. That single join is
 * the whole invalidation mechanism: change the bytes a statement cited and its
 * anchor stops resolving, so the statement flips from `current` to
 * `invalidated-pending` deterministically — no separate persisted index, the
 * file inventory IS the index (Rule 75: freshness by content, never by age).
 */

import { canonicalize, sha256Hex } from "@rennet/protocol";
import type {
  AnchorSpan,
  KnowledgeAnchor,
  KnowledgeAspect,
  KnowledgeConfidence,
  KnowledgeSet,
  KnowledgeStatement,
  KnowledgeStatus,
} from "@rennet/types";
import { KNOWLEDGE_SCHEMA_VERSION } from "@rennet/types";
import type { LoadedSnapshot, SnapshotGateFailure } from "./project-context";
import { isSafeRepoRelativePath } from "./project-context";

const CONFIDENCES: readonly KnowledgeConfidence[] = ["high", "medium", "low"];
const STATUSES: readonly KnowledgeStatus[] = ["hypothesis", "confirmed"];
const ASPECTS: readonly KnowledgeAspect[] = ["purpose", "convention", "why"];

// ── Validation (fail-safe: a malformed stored statement is dropped, never trusted) ──

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validAnchorSpan(value: unknown): AnchorSpan | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const span = value as { startLine?: unknown; endLine?: unknown };
  if (typeof span.startLine !== "number" || !Number.isInteger(span.startLine) || span.startLine < 1)
    return undefined;
  if (span.endLine !== undefined) {
    if (typeof span.endLine !== "number" || !Number.isInteger(span.endLine) || span.endLine < 1)
      return undefined;
  }
  return span.endLine === undefined
    ? { startLine: span.startLine }
    : { startLine: span.startLine, endLine: span.endLine };
}

/**
 * Validate one evidence anchor, or `undefined` on any problem. An anchor MUST
 * carry a safe repo-relative `path` and a non-empty `blobOid` — those are the
 * resolution key; `symbol`/`lines` are optional narrowings.
 */
export function validateKnowledgeAnchor(value: unknown): KnowledgeAnchor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!isString(raw.path) || !isSafeRepoRelativePath(raw.path)) return undefined;
  if (!isString(raw.blobOid)) return undefined;
  const lines = validAnchorSpan(raw.lines);
  if (raw.lines !== undefined && lines === undefined) return undefined;
  return {
    path: raw.path,
    blobOid: raw.blobOid,
    ...(isString(raw.symbol) ? { symbol: raw.symbol } : {}),
    ...(lines === undefined ? {} : { lines }),
  };
}

/**
 * Validate one stored knowledge statement, or `undefined` on any problem. The
 * hard requirement is at least ONE well-formed evidence anchor — an unanchored
 * statement is invalid and must never be served (spec repo-map-knowledge).
 * Everything else (confidence, status, aspect) must be a known enum value.
 */
export function validateKnowledgeStatement(value: unknown): KnowledgeStatement | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!isString(raw.id) || !isString(raw.subject) || !isString(raw.claim)) return undefined;
  if (!ASPECTS.includes(raw.aspect as KnowledgeAspect)) return undefined;
  if (!CONFIDENCES.includes(raw.confidence as KnowledgeConfidence)) return undefined;
  if (!STATUSES.includes(raw.status as KnowledgeStatus)) return undefined;

  if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) return undefined;
  const evidence: KnowledgeAnchor[] = [];
  for (const entry of raw.evidence) {
    const anchor = validateKnowledgeAnchor(entry);
    if (!anchor) return undefined; // one bad anchor invalidates the whole statement
    evidence.push(anchor);
  }

  const provRaw = raw.provenance;
  if (!provRaw || typeof provRaw !== "object") return undefined;
  const prov = provRaw as Record<string, unknown>;
  if (!isString(prov.generator)) return undefined;

  const learnedRaw = raw.learnedAgainst;
  if (!learnedRaw || typeof learnedRaw !== "object") return undefined;
  const learned = learnedRaw as Record<string, unknown>;
  if (!isString(learned.baseOid) || !isString(learned.snapshotFingerprint)) return undefined;

  return {
    id: raw.id,
    subject: raw.subject,
    aspect: raw.aspect as KnowledgeAspect,
    claim: raw.claim,
    evidence,
    confidence: raw.confidence as KnowledgeConfidence,
    status: raw.status as KnowledgeStatus,
    provenance: {
      generator: prov.generator,
      model: typeof prov.model === "string" ? prov.model : null,
      apiKeySource: typeof prov.apiKeySource === "string" ? prov.apiKeySource : null,
    },
    learnedAgainst: {
      baseOid: learned.baseOid,
      snapshotFingerprint: learned.snapshotFingerprint,
    },
  };
}

/**
 * Validate a stored {@link KnowledgeSet}, or `undefined` on any problem. Every
 * malformed STATEMENT inside is dropped (not the whole set) so a single bad
 * statement cannot suppress an otherwise-good set — but the set's identity pins
 * (repoKey/baseOid/fingerprint) must be well-formed or the whole set is untrusted.
 */
export function validateKnowledgeSet(value: unknown): KnowledgeSet | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.schemaVersion !== "number") return undefined;
  if (!isString(raw.repoKey) || !isString(raw.baseOid) || !isString(raw.snapshotFingerprint))
    return undefined;
  if (!isString(raw.generator)) return undefined;
  if (!Array.isArray(raw.statements)) return undefined;

  const statements: KnowledgeStatement[] = [];
  for (const entry of raw.statements) {
    const statement = validateKnowledgeStatement(entry);
    if (statement) statements.push(statement);
  }
  return {
    schemaVersion: raw.schemaVersion,
    repoKey: raw.repoKey,
    baseOid: raw.baseOid,
    snapshotFingerprint: raw.snapshotFingerprint,
    generator: raw.generator,
    statements,
  };
}

// ── Stable statement id ──────────────────────────────────────────────────────

/**
 * The content-addressed id for a statement: a hash over its meaning-bearing
 * fields (subject, aspect, claim, and its anchors' resolution keys). Two runs
 * that mint the same claim about the same code get the same id, so a delta pass
 * can dedup net-new against surviving statements deterministically.
 */
export function knowledgeStatementId(input: {
  readonly subject: string;
  readonly aspect: KnowledgeAspect;
  readonly claim: string;
  readonly evidence: readonly KnowledgeAnchor[];
}): string {
  const anchors = [...input.evidence]
    .map((a) => ({ path: a.path, blobOid: a.blobOid, symbol: a.symbol ?? null }))
    .sort((l, r) =>
      l.path === r.path
        ? l.blobOid === r.blobOid
          ? (l.symbol ?? "").localeCompare(r.symbol ?? "")
          : l.blobOid.localeCompare(r.blobOid)
        : l.path.localeCompare(r.path),
    );
  return sha256Hex(
    canonicalize({ subject: input.subject, aspect: input.aspect, claim: input.claim, anchors }),
  );
}

// ── Anchor resolution (the whole invalidation mechanism) ─────────────────────

/** Index a snapshot's file inventory by path → blobOid, for O(1) anchor resolution. */
export function fileBlobIndex(
  files: readonly { readonly path: string; readonly blobOid: string }[],
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const file of files) index.set(file.path, file.blobOid);
  return index;
}

/** Whether an anchor resolves against a file index: the cited bytes still live at that path. */
export function anchorResolves(
  anchor: KnowledgeAnchor,
  filesByPath: ReadonlyMap<string, string>,
): boolean {
  return filesByPath.get(anchor.path) === anchor.blobOid;
}

/** Whether EVERY anchor of a statement resolves against the file index (⇒ `current`). */
export function statementResolves(
  statement: KnowledgeStatement,
  filesByPath: ReadonlyMap<string, string>,
): boolean {
  return statement.evidence.every((anchor) => anchorResolves(anchor, filesByPath));
}

// ── context.knowledge (the pure read) ────────────────────────────────────────

/** A `context.knowledge` query: optionally narrowed by subject, aspect, or path subtree. */
export interface KnowledgeQuery {
  /** Restrict to statements whose `subject` equals this (a scope name or path). */
  readonly subject?: string;
  /** Restrict to this aspect of understanding. */
  readonly aspect?: KnowledgeAspect;
  /** Restrict to statements citing evidence under this repo-relative subtree prefix. */
  readonly path?: string;
}

/**
 * The served knowledge view: statements pinned to the CURRENT snapshot, split
 * into the `statements` that are current (every anchor resolves) and the
 * `invalidatedPending` ones whose cited bytes the current snapshot changed —
 * disclosed, never dropped. Both carry each statement verbatim, `status` and
 * `confidence` labels intact.
 */
export interface KnowledgeView {
  readonly baseOid: string;
  readonly snapshotFingerprint: string;
  /** The generator identity behind the set, or null when no set exists yet. */
  readonly generator: string | null;
  /** Statements current at this snapshot (all anchors resolve), verbatim + labelled. */
  readonly statements: readonly KnowledgeStatement[];
  /** Statements whose inputs the current snapshot invalidated — disclosed as pending. */
  readonly invalidatedPending: readonly KnowledgeStatement[];
}

/**
 * `context.knowledge` gated result: a served view at the requested base OID, or a
 * typed snapshot-gate failure. A failure is NEVER a served view — the gate fails
 * closed exactly like `context.map` (mirrors {@link ProjectMapResult}). "Not yet
 * enriched" is NOT a failure: it is `ok:true` with an empty view, so knowledge
 * degrades to absent honestly rather than blocking a read.
 */
export type KnowledgeResult =
  | { readonly ok: true; readonly knowledge: KnowledgeView }
  | { readonly ok: false; readonly failure: SnapshotGateFailure };

function underPrefix(entryPath: string, prefix: string): boolean {
  if (prefix === "") return true;
  return entryPath === prefix || entryPath.startsWith(`${prefix}/`);
}

function matchesQuery(statement: KnowledgeStatement, query?: KnowledgeQuery): boolean {
  if (!query) return true;
  if (query.subject !== undefined && statement.subject !== query.subject) return false;
  if (query.aspect !== undefined && statement.aspect !== query.aspect) return false;
  if (query.path !== undefined) {
    const cites = statement.evidence.some((anchor) =>
      underPrefix(anchor.path, query.path as string),
    );
    const subjectUnder = underPrefix(statement.subject, query.path);
    if (!cites && !subjectUnder) return false;
  }
  return true;
}

/**
 * Answer `context.knowledge` from a stored set (or `null` when none exists yet)
 * against a materialized snapshot. Deterministic and total:
 *  - a `null` set ⇒ an empty view (not-yet-enriched, honest absence);
 *  - each statement whose every anchor resolves against the snapshot ⇒ `current`;
 *  - each statement with an anchor that no longer resolves ⇒ `invalidatedPending`
 *    (disclosed, never silently absent);
 *  - statements are served verbatim with `status`/`confidence` intact.
 *
 * Ordering is deterministic (by statement id) so the reply is byte-stable for a
 * given snapshot + set.
 */
export function queryKnowledge(
  set: KnowledgeSet | null,
  snapshot: LoadedSnapshot,
  query?: KnowledgeQuery,
): KnowledgeView {
  const identity = {
    baseOid: snapshot.manifest.baseOid,
    snapshotFingerprint: snapshot.manifest.fingerprint,
  };
  if (!set) {
    return { ...identity, generator: null, statements: [], invalidatedPending: [] };
  }

  const filesByPath = fileBlobIndex(snapshot.files);
  const current: KnowledgeStatement[] = [];
  const pending: KnowledgeStatement[] = [];
  for (const statement of set.statements) {
    if (!matchesQuery(statement, query)) continue;
    if (statementResolves(statement, filesByPath)) current.push(statement);
    else pending.push(statement);
  }
  const byId = (a: KnowledgeStatement, b: KnowledgeStatement): number => a.id.localeCompare(b.id);
  current.sort(byId);
  pending.sort(byId);

  return {
    ...identity,
    generator: set.generator,
    statements: current,
    invalidatedPending: pending,
  };
}

export { KNOWLEDGE_SCHEMA_VERSION };
