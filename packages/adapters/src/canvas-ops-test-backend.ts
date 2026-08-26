import {
  type AdmittedDocument,
  buildCanvas,
  type CanvasOpsBackend,
  type CanvasOpsEffect,
  canvasId,
  type ElementDetail,
  type ReviewIdentity,
  type ViewState,
} from "@rennet/core";
import type { CanvasAngle, Decomposition } from "@rennet/protocol";

// Shared canvasOps@2 test backend fixture — a minimal but complete backend
// sufficient for tool registration and the describe→read round-trip, reused by
// the in-process SDK server test and the external streamable-HTTP transport test.

export const REVIEW_ID = "rev_1";
export const PATCHSET_ID = "ps_1";

export function decomposition(): Decomposition {
  const chunk = (chunkId: string, hunkId: string, layer: number) => ({
    chunkId,
    kind: "substantive" as const,
    title: `chunk ${chunkId}`,
    layer,
    filePaths: [`src/${chunkId}.ts`],
    hunkIds: [hunkId],
    changedLoc: 3,
  });
  return {
    patchsetId: PATCHSET_ID,
    hunks: [],
    classifications: [],
    chunks: [chunk("c1", "h1", 0), chunk("c2", "h2", 1)],
    edges: [{ from: "c1", to: "c2", kind: "enables" }],
    readingOrder: ["c1", "c2"],
    residue: [],
    blockingStates: [],
  };
}

export function decisionsDoc(): AdmittedDocument {
  return {
    docId: "doc_dec",
    docType: "decision.record",
    body: {
      decisions: [
        { decisionId: "d0", anchor: "rennet:chunk/c1", title: "decision 0" },
        { decisionId: "d1", anchor: "rennet:chunk/c1", title: "decision 1" },
        { decisionId: "d2", anchor: "rennet:chunk/c2", title: "decision 2" },
      ],
    },
  };
}

/** A minimal backend sufficient for registration + the describe→read round-trip. */
export function makeCanvasOpsTestBackend(): {
  backend: CanvasOpsBackend;
  applied: CanvasOpsEffect[];
} {
  const decomp = decomposition();
  const docs = [decisionsDoc()];
  const applied: CanvasOpsEffect[] = [];
  const cid = canvasId(REVIEW_ID, PATCHSET_ID, "decisions");
  const build = () =>
    buildCanvas({
      reviewId: REVIEW_ID,
      patchsetId: PATCHSET_ID,
      angle: "decisions",
      admittedDocs: docs,
      decomposition: decomp,
      dispositions: [],
      canvasEvents: [],
    });
  const backend: CanvasOpsBackend = {
    identity: (): ReviewIdentity => ({ reviewId: REVIEW_ID, patchsetId: PATCHSET_ID }),
    freshness: () => "current",
    angles: () => ["decisions"],
    canvas: (id?: string) => (id !== undefined && id !== cid ? undefined : build()),
    view: (): ViewState => ({ openCanvasId: cid, angle: "decisions", expandedCohorts: [] }),
    element: (ref: string): ElementDetail | undefined => {
      const element = build().layers.analysis.elements.find((e) => e.elementKey === ref);
      return element
        ? { refKind: "element", ref, element, provenancePointer: element.docId }
        : undefined;
    },
    thread: () => undefined,
    hunk: () => undefined,
    searchDiff: () => [],
    decomposition: () => decomp,
    runLedger: () => [],
    provenance: () => undefined,
    planRecompute: (scope: string, angle?: CanvasAngle) => ({
      refused: false,
      invocations: [{ purpose: "proposal", tier: "light", label: `${scope}:${angle ?? "all"}` }],
      harnessInvocationCount: 1,
      maxHarnessInvocations: 5,
    }),
    projectMap: () => ({
      ok: true,
      map: {
        baseRef: "refs/heads/main",
        baseRefResolution: "explicit-setting",
        baseOid: "a".repeat(40),
        fingerprint: "fp",
        files: [{ path: "src/c1.ts", blobOid: "b".repeat(40), size: 3, mode: "100644" }],
        scopes: [{ name: "root", root: "", private: true, tags: [] }],
        edges: [],
        entryPoints: [],
        tests: [],
        ownership: [],
        conventions: [],
      },
    }),
    fileContext: (path: string) => ({
      ok: true,
      context: {
        path,
        blobOid: "b".repeat(40),
        size: 3,
        mode: "100644",
        isSymlink: false,
        scope: "root",
        hasSymbols: false,
        extractor: null,
        symbols: [],
        tests: [],
      },
    }),
    fileOverview: (path: string) => ({
      ok: true,
      overview: {
        path,
        blobOid: "b".repeat(40),
        extractor: null,
        hasSymbols: false,
        symbols: [],
      },
    }),
    symbolDefinition: (query) => ({ ok: true, definitions: { name: query.name, sites: [] } }),
    references: (query) => ({ ok: true, references: { name: query.name, sites: [] } }),
    novelty: () => ({
      ok: true,
      ledger: {
        projectSnapshotId: "fp",
        snapshotFingerprint: "fp",
        baseOid: "a".repeat(40),
        patchsetId: PATCHSET_ID,
        entries: [
          {
            unit: { kind: "file", path: "src/c1.ts", fileStatus: "added" },
            classification: "novel",
            evidence: {
              snapshotFingerprint: "fp",
              baseOid: "a".repeat(40),
              shard: null,
              match: { kind: "file-absent", path: "src/c1.ts" },
              context: {
                scope: "root",
                isKnownTest: false,
                isConvention: false,
                patchTruncated: false,
              },
            },
          },
        ],
      },
    }),
    knowledge: () => ({
      ok: true,
      knowledge: {
        baseOid: "a".repeat(40),
        snapshotFingerprint: "fp",
        generator: null,
        statements: [],
        invalidatedPending: [],
      },
    }),
    ask: async () => ({
      status: "answered",
      answer: {
        answer: "a served answer",
        evidence: [{ path: "packages/a/src/index.ts", blobOid: "a".repeat(40) }],
        confidence: "high",
        consulted: ["context.knowledge (0 statements)"],
        cost: {
          turns: 1,
          model: "opus-4.8",
          effort: "high",
          budgetGranted: true,
          overage: false,
          resolution: {
            jobId: "context-ask-fetch",
            tier: "light",
            scenario: "degraded",
            source: "council-table",
            summary: "resolved",
          },
        },
      },
    }),
    applyEffects: (effects) => {
      for (const effect of effects) applied.push(effect);
    },
  };
  return { backend, applied };
}
