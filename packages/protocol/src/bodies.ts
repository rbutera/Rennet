/**
 * Per-docType body schemas and rules for the decomposition angle (issue #8).
 *
 * The RSP core (#6) validates every document's envelope and walks its opaque
 * body generically. This module extends that gate with the two decomposition
 * document bodies and the semantic rules the DSL plan reserves (§4.1):
 *
 *   V100 totality        — ⋃chunks.hunks ∪ residue == the offered hunk set, exactly
 *   V101 no duplication  — no hunk occurrence placed in two chunks
 *   V103 acyclic order   — edges are a DAG; readingOrder is a topological cover
 *   V104 angle set       — a chunk may only declare sequence/decisions/claims/blast-radius
 *   V105 rationale       — every proposal chunk carries a non-empty rationale
 *   V106 completeness    — chunk ids are unique; every referenced chunk is declared
 *   V108 body shape      — the body has the right structural shape at all (gate)
 *
 * Both decomposition documents are atomic (DOC_TYPE_REGISTRY), so any body error
 * rejects the whole document. Angle membership is deliberately NOT enforced by the
 * shape schema (angles parse as `string[]`) so a bad angle rejects with the precise
 * V104 code rather than a generic shape error.
 */

import type { AnchorKind, OfferedManifest, RspDocType, ValidationError } from "@rennet/types";
import { z } from "zod";

/**
 * The closed set of angles a chunk may be assigned to. Excludes `noise` (verified
 * only by deterministic checkers) and `spec` (a queue over requirements). V104.
 */
export const CHUNK_ASSIGNABLE_ANGLES = ["sequence", "decisions", "claims", "blast-radius"] as const;

const EDGE_KINDS = ["enables", "evidenced-by", "contradicts", "duplicates", "refactor-of"] as const;

// ── Structural body shape schemas (V108 gate) ────────────────────────────────

const residueItemSchema = z.object({ hunkId: z.string().min(1), reason: z.string() }).loose();

const skeletonChunkSchema = z
  .object({
    chunkId: z.string().min(1),
    hunkIds: z.array(z.string().min(1)),
    // `angles` are strings here on purpose; membership is V104's job so the
    // rejection carries V104's code, not a generic shape error.
    angles: z.array(z.string()),
  })
  .loose();

const proposalChunkSchema = z
  .object({
    chunkId: z.string().min(1),
    title: z.string(),
    hunkIds: z.array(z.string().min(1)),
    angles: z.array(z.string()),
    // Any string (incl. empty) passes the shape; V105 enforces non-empty so the
    // rejection carries V105's code.
    rationale: z.string(),
  })
  .loose();

const proposalEdgeSchema = z
  .object({ from: z.string().min(1), to: z.string().min(1), kind: z.enum(EDGE_KINDS) })
  .loose();

const skeletonBodySchema = z
  .object({
    chunks: z.array(skeletonChunkSchema),
    readingOrder: z.array(z.string().min(1)),
    residue: z.array(residueItemSchema),
  })
  .loose();

const proposalBodySchema = z
  .object({
    chunks: z.array(proposalChunkSchema),
    edges: z.array(proposalEdgeSchema),
    readingOrder: z.array(z.string().min(1)),
    residue: z.array(residueItemSchema),
  })
  .loose();

/**
 * The `ordering` body (issue #9): a comprehension reading order over chunk ids
 * plus a required rationale. `rationale` is any string here (empty passes the
 * shape); V113 enforces non-empty so the rejection carries V113's code.
 */
const orderingBodySchema = z
  .object({
    readingOrder: z.array(z.string().min(1)),
    rationale: z.string(),
  })
  .loose();

const BODY_SCHEMAS: Readonly<Partial<Record<RspDocType, z.ZodType>>> = {
  "decomposition.skeleton": skeletonBodySchema,
  "decomposition.proposal": proposalBodySchema,
  ordering: orderingBodySchema,
};

/**
 * The JSON Schema an agent's structured output is constrained to, projected from
 * the Zod body schema. `null` for a docType with no body schema in this slice.
 * The exact accepted feature subset is the deferred SDK probe; these bodies use
 * only objects, arrays, strings, and one enum, the safe intersection.
 */
export function bodyJsonSchema(docType: RspDocType): unknown | null {
  const schema = BODY_SCHEMAS[docType];
  return schema ? z.toJSONSchema(schema) : null;
}

// ── Typed views over a shape-validated body ──────────────────────────────────

interface ChunkView {
  chunkId: string;
  hunkIds: string[];
  angles: string[];
  rationale?: string;
}

interface DecompositionBodyView {
  chunks: ChunkView[];
  edges: { from: string; to: string }[];
  readingOrder: string[];
  residue: { hunkId: string }[];
}

function viewOf(docType: RspDocType, parsed: unknown): DecompositionBodyView {
  const body = parsed as Record<string, unknown>;
  const chunks = (body.chunks as Record<string, unknown>[]).map((chunk) => ({
    chunkId: chunk.chunkId as string,
    hunkIds: chunk.hunkIds as string[],
    angles: chunk.angles as string[],
    rationale: typeof chunk.rationale === "string" ? chunk.rationale : undefined,
  }));
  const edges =
    docType === "decomposition.proposal" ? (body.edges as { from: string; to: string }[]) : [];
  return {
    chunks,
    edges,
    readingOrder: body.readingOrder as string[],
    residue: body.residue as { hunkId: string }[],
  };
}

// ── The rule catalogue ───────────────────────────────────────────────────────

/** The immutable ids the manifest offers for one occurrence kind. */
function offeredIdsOfKind(manifest: OfferedManifest, kind: AnchorKind): Set<string> {
  return new Set(
    manifest.occurrences.filter((occurrence) => occurrence.kind === kind).map((o) => o.id),
  );
}

/**
 * Validate a document's body against its schema (V108) and its family's semantic
 * rules. The decomposition family (V100/V101/V103/V104/V105/V106) is checked
 * against the offered `hunk` occurrences; the ordering document (#9,
 * V111/V112/V113) against the offered `chunk` occurrences. Returns every error;
 * an empty array means the body is admitted. Returns `[]` for a docType with no
 * per-body validator, so the caller can dispatch unconditionally.
 */
export function validateBodyRules(
  docType: RspDocType,
  body: unknown,
  manifest: OfferedManifest,
): ValidationError[] {
  const schema = BODY_SCHEMAS[docType];
  if (!schema) return [];

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      code: "V108",
      pointer: `/body${pointerOf(issue.path)}`,
      message: issue.message,
    }));
  }

  // The ordering document (#9) orders the CHUNK set the decomposition declared.
  if (docType === "ordering") {
    return validateOrderingRules(parsed.data, offeredIdsOfKind(manifest, "chunk"));
  }

  const offeredHunkIds = offeredIdsOfKind(manifest, "hunk");
  const view = viewOf(docType, parsed.data);
  const errors: ValidationError[] = [];
  const declared = declaredChunkIds(view, errors); // V106 duplicate-id
  checkTotalityAndDuplication(view, offeredHunkIds, errors); // V100, V101
  checkAngles(view, errors); // V104
  if (docType === "decomposition.proposal") checkRationale(view, errors); // V105
  checkCompleteness(view, declared, errors); // V106 dangling refs
  checkReadingOrder(view, declared, errors); // V103
  return errors;
}

// ── The ordering rule catalogue (issue #9) ───────────────────────────────────

/**
 * Validate an `ordering` body against the offered chunk set: V112 (no minted
 * identity — every ordered id was offered), V111 (totality/cover — every offered
 * chunk appears exactly once), V113 (a non-empty rationale is required). All
 * atomic. The order is a flat cover of the chunk set; there is no edge graph
 * here (the dependency constraints live in the decomposition the pass reads
 * through and are enforced there), so this document only asserts the cover.
 */
function validateOrderingRules(
  parsed: unknown,
  offeredChunkIds: ReadonlySet<string>,
): ValidationError[] {
  const body = parsed as { readingOrder: string[]; rationale: string };
  const errors: ValidationError[] = [];

  // V112 — every ordered id is an offered chunk (agents never mint identity).
  body.readingOrder.forEach((id, index) => {
    if (!offeredChunkIds.has(id)) {
      errors.push({
        code: "V112",
        pointer: `/body/readingOrder/${index}`,
        message: `reading order references a chunk not in the offered set (minted identity): ${id}`,
      });
    }
  });

  // V111 — the order is a cover of the offered set: each offered chunk exactly
  // once. A duplicate and a missing chunk both reject, with distinct messages.
  const counts = new Map<string, number>();
  for (const id of body.readingOrder) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1 && offeredChunkIds.has(id)) {
      errors.push({
        code: "V111",
        pointer: "/body/readingOrder",
        message: `chunk is ordered more than once: ${id}`,
      });
    }
  }
  for (const offeredId of offeredChunkIds) {
    if (!counts.has(offeredId)) {
      errors.push({
        code: "V111",
        pointer: "/body/readingOrder",
        message: `offered chunk is missing from the reading order (not totally ordered): ${offeredId}`,
      });
    }
  }

  // V113 — a rationale is required (the "why this order aids comprehension").
  if (body.rationale.trim().length === 0) {
    errors.push({
      code: "V113",
      pointer: "/body/rationale",
      message: "ordering rationale is empty",
    });
  }

  return errors;
}

/** Declared chunk ids (order-preserving), flagging duplicates with V106. */
function declaredChunkIds(view: DecompositionBodyView, errors: ValidationError[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const chunk of view.chunks) {
    if (seen.has(chunk.chunkId)) duplicates.add(chunk.chunkId);
    seen.add(chunk.chunkId);
  }
  for (const id of duplicates) {
    errors.push({
      code: "V106",
      pointer: "/body/chunks",
      message: `chunk id is declared more than once: ${id}`,
    });
  }
  return [...seen];
}

/** V100 totality (exact partition over offered) and V101 no-duplication. */
function checkTotalityAndDuplication(
  view: DecompositionBodyView,
  offered: ReadonlySet<string>,
  errors: ValidationError[],
): void {
  const chunkCounts = new Map<string, number>();
  for (const chunk of view.chunks) {
    for (const hunkId of chunk.hunkIds) {
      chunkCounts.set(hunkId, (chunkCounts.get(hunkId) ?? 0) + 1);
    }
  }
  for (const [hunkId, count] of chunkCounts) {
    if (count > 1) {
      errors.push({
        code: "V101",
        pointer: "/body/chunks",
        message: `hunk placed in more than one chunk: ${hunkId}`,
      });
    }
  }

  const residueIds = new Set(view.residue.map((item) => item.hunkId));
  const chunkIds = new Set(chunkCounts.keys());

  // A hunk cannot be both placed in a chunk and left in residue.
  for (const hunkId of chunkIds) {
    if (residueIds.has(hunkId)) {
      errors.push({
        code: "V100",
        pointer: "/body/residue",
        message: `hunk is both placed in a chunk and left in residue: ${hunkId}`,
      });
    }
  }

  const placed = new Set<string>([...chunkIds, ...residueIds]);
  for (const offeredId of offered) {
    if (!placed.has(offeredId)) {
      errors.push({
        code: "V100",
        pointer: "/body",
        message: `offered hunk is unaccounted for (not in any chunk or residue): ${offeredId}`,
      });
    }
  }
  for (const placedId of placed) {
    if (!offered.has(placedId)) {
      errors.push({
        code: "V100",
        pointer: "/body",
        message: `hunk is not in the offered manifest (minted or extra): ${placedId}`,
      });
    }
  }
}

/** V104 — every chunk angle is in the closed chunk-assignable set. */
function checkAngles(view: DecompositionBodyView, errors: ValidationError[]): void {
  const allowed = new Set<string>(CHUNK_ASSIGNABLE_ANGLES);
  view.chunks.forEach((chunk, index) => {
    for (const angle of chunk.angles) {
      if (!allowed.has(angle)) {
        errors.push({
          code: "V104",
          pointer: `/body/chunks/${index}/angles`,
          message: `angle is not chunk-assignable (${angle}); allowed: ${CHUNK_ASSIGNABLE_ANGLES.join(", ")}`,
        });
      }
    }
  });
}

/** V105 — every proposal chunk carries a non-empty rationale. */
function checkRationale(view: DecompositionBodyView, errors: ValidationError[]): void {
  view.chunks.forEach((chunk, index) => {
    if ((chunk.rationale ?? "").trim().length === 0) {
      errors.push({
        code: "V105",
        pointer: `/body/chunks/${index}/rationale`,
        message: "proposal chunk rationale is empty",
      });
    }
  });
}

/** V106 — every chunk id referenced by an edge or the reading order is declared. */
function checkCompleteness(
  view: DecompositionBodyView,
  declared: readonly string[],
  errors: ValidationError[],
): void {
  const declaredSet = new Set(declared);
  view.edges.forEach((edge, index) => {
    for (const [end, id] of [
      ["from", edge.from],
      ["to", edge.to],
    ] as const) {
      if (!declaredSet.has(id)) {
        errors.push({
          code: "V106",
          pointer: `/body/edges/${index}/${end}`,
          message: `edge references an undeclared chunk: ${id}`,
        });
      }
    }
  });
  view.readingOrder.forEach((id, index) => {
    if (!declaredSet.has(id)) {
      errors.push({
        code: "V106",
        pointer: `/body/readingOrder/${index}`,
        message: `reading order references an undeclared chunk: ${id}`,
      });
    }
  });
}

/**
 * V103 — the edges are a DAG and `readingOrder` is a topological cover: it lists
 * every declared chunk exactly once and places the source of every edge before
 * its target. Dangling references are V106's job; here we only reason over
 * declared chunks.
 */
function checkReadingOrder(
  view: DecompositionBodyView,
  declared: readonly string[],
  errors: ValidationError[],
): void {
  const declaredSet = new Set(declared);

  // Cover: readingOrder over declared chunks is a permutation (each once).
  const orderDeclared = view.readingOrder.filter((id) => declaredSet.has(id));
  const orderCounts = new Map<string, number>();
  for (const id of orderDeclared) orderCounts.set(id, (orderCounts.get(id) ?? 0) + 1);
  let coverBroken = false;
  for (const id of declared) {
    const count = orderCounts.get(id) ?? 0;
    if (count !== 1) coverBroken = true;
  }
  if (coverBroken) {
    errors.push({
      code: "V103",
      pointer: "/body/readingOrder",
      message: "reading order does not cover every declared chunk exactly once",
    });
  }

  // Acyclicity over declared edges (Kahn: a leftover node means a cycle).
  const declaredEdges = view.edges.filter(
    (edge) => declaredSet.has(edge.from) && declaredSet.has(edge.to),
  );
  if (hasCycle(declared, declaredEdges)) {
    errors.push({ code: "V103", pointer: "/body/edges", message: "edges contain a cycle" });
    return; // a topological-consistency check is meaningless on a cyclic graph
  }

  // Consistency: for every edge from→to, `from` precedes `to` in the order.
  const position = new Map<string, number>();
  view.readingOrder.forEach((id, index) => {
    if (!position.has(id)) position.set(id, index);
  });
  for (const edge of declaredEdges) {
    const fromPos = position.get(edge.from);
    const toPos = position.get(edge.to);
    if (fromPos === undefined || toPos === undefined) continue; // cover error already raised
    if (fromPos >= toPos) {
      errors.push({
        code: "V103",
        pointer: "/body/readingOrder",
        message: `reading order violates edge ${edge.from} -> ${edge.to}`,
      });
    }
  }
}

function hasCycle(
  nodes: readonly string[],
  edges: readonly { from: string; to: string }[],
): boolean {
  const indegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node, 0);
    successors.set(node, []);
  }
  for (const edge of edges) {
    successors.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = nodes.filter((node) => (indegree.get(node) ?? 0) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    visited += 1;
    for (const next of successors.get(node) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  return visited < nodes.length;
}

function pointerOf(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "";
  return `/${path.map((segment) => String(segment).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}
