import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type AdmittedDocument,
  buildCanvas,
  type CanvasOpsBackend,
  type CanvasOpsEffect,
  canvasId,
  type ElementDetail,
  type OpsEnvelope,
  type ReviewIdentity,
  type ViewState,
} from "@rennet/core";
import type { CanvasAngle, Decomposition } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  buildCanvasOpsTools,
  CANVAS_OPS_INSTRUCTIONS,
  CANVAS_OPS_SERVER_NAME,
  createCanvasOpsServer,
} from "./canvas-ops-server";

const REVIEW_ID = "rev_1";
const PATCHSET_ID = "ps_1";

function decomposition(): Decomposition {
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
  };
}

function decisionsDoc(): AdmittedDocument {
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
function makeBackend(): { backend: CanvasOpsBackend; applied: CanvasOpsEffect[] } {
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
    applyEffects: (effects) => {
      for (const effect of effects) applied.push(effect);
    },
  };
  return { backend, applied };
}

/** Parse the envelope out of an SDK CallToolResult's text content. */
function envelopeOf(result: CallToolResult): OpsEnvelope {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("expected a text content block");
  return JSON.parse(first.text) as OpsEnvelope;
}

type SdkToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

/**
 * Invoke a compiled SDK tool by name. Each `tool()` def carries its own inferred
 * Zod schema, so the heterogeneous array's `handler` arg type collapses to
 * `never`; this casts past that to exercise the real handler with concrete args.
 */
function callTool(
  defs: Awaited<ReturnType<typeof buildCanvasOpsTools>>,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`missing tool def: ${name}`);
  return (def.handler as unknown as SdkToolHandler)(args, {});
}

describe("canvasOps@2 SDK server", () => {
  it("registers an in-process SDK MCP server with the canvasOps@2 tool set", async () => {
    const { backend } = makeBackend();
    const config = await createCanvasOpsServer(backend);
    expect(config.type).toBe("sdk");
    expect(config.name).toBe(CANVAS_OPS_SERVER_NAME);
    expect(config.instance).toBeDefined();
    expect(CANVAS_OPS_INSTRUCTIONS).toContain("MAP of the review");
  });

  it("compiles every descriptor with the right readOnlyHint and alwaysLoad markings", async () => {
    const { backend } = makeBackend();
    const defs = await buildCanvasOpsTools(backend);
    const names = defs.map((d) => d.name);
    expect(names).toEqual([
      "canvas.describe",
      "canvas.view",
      "canvas.focus",
      "canvas.annotate",
      "canvas.propose",
      "canvas.recompute",
      "canvas.read",
      "canvas.thread",
      "diff.read",
      "diff.search",
      "diff.structure",
      "run.ledger",
      "run.provenance",
      "context.map",
      "context.file",
      "context.novelty",
      "context.overview",
      "context.symbol",
      "context.references",
      "context.knowledge",
    ]);
    const byName = new Map(defs.map((d) => [d.name, d]));
    // Hot trio is always-loaded (SDK stores it under _meta).
    for (const hot of ["canvas.describe", "canvas.view"]) {
      expect(byName.get(hot)?._meta?.["anthropic/alwaysLoad"]).toBe(true);
    }
    // A non-hot tool is deferred (no always-load meta flag).
    expect(byName.get("run.ledger")?._meta?.["anthropic/alwaysLoad"]).not.toBe(true);
    // readOnlyHint tracks the descriptor: reads true, writers false.
    expect(byName.get("canvas.read")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("diff.search")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("context.map")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("context.file")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("context.novelty")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("context.overview")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("context.symbol")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("context.references")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("context.knowledge")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("canvas.propose")?.annotations?.readOnlyHint).toBe(false);
    // Structural: no user-only op is exposed as a tool.
    for (const userOp of [
      "canvas.disposition",
      "canvas.adjudicateProposal",
      "canvas.pinAnnotation",
      "canvas.select",
    ]) {
      expect(names).not.toContain(userOp);
    }
  });

  it("round-trips describe(counts) → describe(cohorts) → read(one element) through the SDK handlers", async () => {
    const { backend } = makeBackend();
    const defs = await buildCanvasOpsTools(backend);

    const counts = envelopeOf(await callTool(defs, "canvas.describe", { depth: "counts" }));
    expect((counts.data as { elements: number }).elements).toBe(3);
    expect(counts.freshness).toBe("current");

    const cohorts = envelopeOf(await callTool(defs, "canvas.describe", { depth: "cohorts" }));
    expect(cohorts.total).toBe(2);

    const elements = envelopeOf(await callTool(defs, "canvas.describe", { depth: "elements" }));
    const firstKey = (elements.data as Array<{ elementKey: string }>)[0]?.elementKey ?? "";

    const element = envelopeOf(await callTool(defs, "canvas.read", { ref: firstKey }));
    const detail = element.data as ElementDetail;
    expect(detail.ref).toBe(firstKey);
    expect(detail.element?.elementKey).toBe(firstKey);
  });

  it("round-trips context.map / context.file through the SDK handlers", async () => {
    const { backend } = makeBackend();
    const defs = await buildCanvasOpsTools(backend);

    const map = envelopeOf(await callTool(defs, "context.map", {}));
    expect(map.freshness).toBe("current");
    expect((map.data as { baseOid: string }).baseOid).toBe("a".repeat(40));

    const file = envelopeOf(await callTool(defs, "context.file", { path: "src/c1.ts" }));
    expect(file.freshness).toBe("current");
    expect((file.data as { path: string }).path).toBe("src/c1.ts");

    // context.file with no path → malformed call, isError.
    const bad = await callTool(defs, "context.file", {});
    expect(bad.isError).toBe(true);
  });

  it("round-trips context.novelty through the SDK handler", async () => {
    const { backend } = makeBackend();
    const defs = await buildCanvasOpsTools(backend);

    const novelty = envelopeOf(await callTool(defs, "context.novelty", {}));
    expect(novelty.freshness).toBe("current");
    const ledger = novelty.data as { baseOid: string; entries: Array<{ classification: string }> };
    expect(ledger.baseOid).toBe("a".repeat(40));
    expect(ledger.entries[0]?.classification).toBe("novel");
    expect(novelty.evidence).toEqual(["a".repeat(40), "fp", PATCHSET_ID]);
  });

  it("returns isError on a malformed call, distinguishable from a nothing-found reply", async () => {
    const { backend } = makeBackend();
    const defs = await buildCanvasOpsTools(backend);

    // Malformed: canvas.read with no ref → isError.
    const bad = await callTool(defs, "canvas.read", {});
    expect(bad.isError).toBe(true);

    // Nothing-found: diff.search matches nothing → ok envelope, total 0, scope named.
    const empty = envelopeOf(await callTool(defs, "diff.search", { query: "no-match" }));
    expect(empty.total).toBe(0);
    expect((empty.data as { scope: string }).scope).toContain("no-match");
  });

  it("applies a write op's effect through the backend (annotate ⇒ L3, never L2)", async () => {
    const { backend, applied } = makeBackend();
    const defs = await buildCanvasOpsTools(backend);
    await callTool(defs, "canvas.annotate", {
      target: "rennet:chunk/c1",
      kind: "highlight",
      body: "note",
    });
    expect(applied.length).toBe(1);
    expect(applied[0]?.kind).toBe("annotate");
    // No effect a canvasOps handler can produce is an L2 disposition write.
    expect(applied.map((e) => e.kind)).not.toContain("disposition");
  });
});
