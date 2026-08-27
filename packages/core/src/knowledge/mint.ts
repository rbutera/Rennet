/**
 * Mint-time honesty helpers, extracted verbatim from the retired flat pass
 * (B06 cluster 3): the ONE implementation of anchor→blobOid resolution,
 * anchor-or-drop, hypothesis stamping, and statement parsing/dedup. Every
 * statement the swarm mints comes through here — no second implementation.
 *
 * The honesty contract is enforced at mint time, not asserted:
 *  - every emitted statement's evidence is resolved to authoritative `blobOid`s
 *    from THIS snapshot's file inventory — the model cites a `path` (+ optional
 *    symbol/lines), never a git OID it cannot know; a cited path not in the
 *    snapshot is dropped, and a statement left with NO resolvable anchor is
 *    dropped (unanchored ⇒ invalid, never served);
 *  - every minted statement is a `hypothesis` (model-derived ⇒ labelled
 *    hypothesis until confirmed), stamped with provenance + the snapshot it was
 *    learned against.
 */

import type {
  KnowledgeAnchor,
  KnowledgeAspect,
  KnowledgeConfidence,
  KnowledgeStatement,
} from "@rennet/protocol";
import { knowledgeStatementId } from "./read";

/** A compact, model-facing projection of the snapshot the swarm reasons over. */
export interface KnowledgeSnapshotContext {
  readonly repoKey: string;
  readonly baseOid: string;
  readonly snapshotFingerprint: string;
  /** The file inventory `path → blobOid`; the anchor-resolution authority. */
  readonly files: readonly { readonly path: string; readonly blobOid: string }[];
  /** Workspace scopes (name + root) — the natural subjects to enrich. */
  readonly scopes: readonly { readonly name: string; readonly root: string }[];
}

/** The provenance a caller knows before the run; the model/apiKeySource is observed per turn. */
export interface KnowledgeProvenanceSeed {
  readonly model: string | null;
  readonly apiKeySource: string | null;
  /** Override the generator id (defaults to the swarm's). */
  readonly generator?: string;
}

/**
 * The JSON output schema a statement-emitting session is constrained to (passed
 * as the harness `outputSchema`). The model emits statements citing a
 * repo-relative `path` (+ optional `symbol`/lines); the runner resolves the
 * authoritative `blobOid` from the snapshot — the model never mints identity.
 */
export const KNOWLEDGE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["statements"],
  properties: {
    statements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subject", "aspect", "claim", "confidence", "evidence"],
        properties: {
          subject: { type: "string" },
          aspect: { type: "string", enum: ["purpose", "convention", "why"] },
          claim: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          evidence: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path"],
              properties: {
                path: { type: "string" },
                symbol: { type: "string" },
                startLine: { type: "integer", minimum: 1 },
                endLine: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
    },
  },
} as const;

/** The shared, model-facing statement contract (the prompt half of the honesty contract). */
export const KNOWLEDGE_CONTRACT = `You are reconstructing the DURABLE KNOWLEDGE layer of a Repo Map: what each
module or area DOES, the CONVENTIONS it embodies, and the reconstructed WHY behind
its design. This is evidence-anchored understanding, not a summary of a diff.

RULES (non-negotiable):
- Every statement MUST cite EVIDENCE: one or more files (by repo-relative path,
  optionally a symbol name and a 1-based line span) that the statement is DRAWN
  FROM. A statement you cannot anchor to a concrete file you have seen is NOT
  allowed — omit it.
- Only cite paths that appear in the provided file inventory. Do not invent paths.
- Mark each statement's confidence honestly (high | medium | low). A reconstructed
  inference (a WHY you are inferring, not reading) is at most 'medium'.
- 'aspect' is 'purpose' (what it does), 'convention' (a pattern/rule it embodies),
  or 'why' (the reconstructed intent).
- 'subject' is a workspace scope name or a repo-relative path/subtree the statement
  is about.
- Prefer a few well-anchored, high-signal statements over many shallow ones.`;

const CONFIDENCES: readonly KnowledgeConfidence[] = ["high", "medium", "low"];
const ASPECTS: readonly KnowledgeAspect[] = ["purpose", "convention", "why"];

export function coerceAspect(value: unknown): KnowledgeAspect {
  return ASPECTS.includes(value as KnowledgeAspect) ? (value as KnowledgeAspect) : "purpose";
}

export function coerceConfidence(value: unknown): KnowledgeConfidence {
  // Unknown ⇒ the most conservative label; a bad confidence never inflates trust.
  return CONFIDENCES.includes(value as KnowledgeConfidence)
    ? (value as KnowledgeConfidence)
    : "low";
}

/** How many raw anchors were dropped as unresolvable, for honest telemetry. */
export interface MintTally {
  droppedAnchors: number;
  droppedStatements: number;
}

/**
 * Turn one raw model statement into a trustworthy {@link KnowledgeStatement}, or
 * `undefined` when it has no resolvable anchor. Every anchor's `blobOid` is stamped
 * from the snapshot's file inventory (the model cites paths, never OIDs); an anchor
 * whose path is absent is dropped; a statement left unanchored is dropped.
 */
export function mintStatement(
  raw: unknown,
  filesByPath: ReadonlyMap<string, string>,
  snapshot: Pick<KnowledgeSnapshotContext, "baseOid" | "snapshotFingerprint">,
  seed: KnowledgeProvenanceSeed,
  generator: string,
  tally: MintTally,
): KnowledgeStatement | undefined {
  if (!raw || typeof raw !== "object") {
    tally.droppedStatements += 1;
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const subject = typeof record.subject === "string" ? record.subject : "";
  const claim = typeof record.claim === "string" ? record.claim.trim() : "";
  if (subject.length === 0 || claim.length === 0) {
    tally.droppedStatements += 1;
    return undefined;
  }

  const rawEvidence = Array.isArray(record.evidence) ? record.evidence : [];
  const evidence: KnowledgeAnchor[] = [];
  for (const entry of rawEvidence) {
    if (!entry || typeof entry !== "object") {
      tally.droppedAnchors += 1;
      continue;
    }
    const anchor = entry as Record<string, unknown>;
    const path = typeof anchor.path === "string" ? anchor.path : "";
    const blobOid = filesByPath.get(path);
    if (blobOid === undefined) {
      // Cited a path not in the snapshot — unresolvable, so it cannot anchor a fact.
      tally.droppedAnchors += 1;
      continue;
    }
    const startLine = typeof anchor.startLine === "number" ? anchor.startLine : undefined;
    const endLine = typeof anchor.endLine === "number" ? anchor.endLine : undefined;
    evidence.push({
      path,
      blobOid,
      ...(typeof anchor.symbol === "string" && anchor.symbol.length > 0
        ? { symbol: anchor.symbol }
        : {}),
      ...(startLine !== undefined && startLine >= 1
        ? {
            lines:
              endLine !== undefined && endLine >= startLine
                ? { startLine, endLine }
                : { startLine },
          }
        : {}),
    });
  }
  if (evidence.length === 0) {
    // Unanchored ⇒ invalid; never served (spec repo-map-knowledge).
    tally.droppedStatements += 1;
    return undefined;
  }

  const aspect = coerceAspect(record.aspect);
  return {
    id: knowledgeStatementId({ subject, aspect, claim, evidence }),
    subject,
    aspect,
    claim,
    evidence,
    confidence: coerceConfidence(record.confidence),
    // Model-derived ⇒ a labelled hypothesis until confirmed.
    status: "hypothesis",
    provenance: { generator, model: seed.model, apiKeySource: seed.apiKeySource },
    learnedAgainst: {
      baseOid: snapshot.baseOid,
      snapshotFingerprint: snapshot.snapshotFingerprint,
    },
  };
}

export function parseStatements(body: unknown): readonly unknown[] {
  if (!body || typeof body !== "object") return [];
  const statements = (body as Record<string, unknown>).statements;
  return Array.isArray(statements) ? statements : [];
}

/** Dedup minted statements by id (a re-adjudicated claim and a survivor can coincide). */
export function dedupById(statements: readonly KnowledgeStatement[]): KnowledgeStatement[] {
  const byId = new Map<string, KnowledgeStatement>();
  for (const statement of statements)
    if (!byId.has(statement.id)) byId.set(statement.id, statement);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
