import type {
  OfferedManifest,
  PatchsetRef,
  RspEnvelope,
  RspTokenUsage,
  ValidationReport,
} from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createCodexRunTurn } from "./codex-run-turn";
import type {
  CodexUtilityCompleteRequest,
  CodexUtilityPort,
  CodexUtilityResult,
} from "./codex-utility-port";

const PATCHSET: PatchsetRef = { id: "patch-1" };
const MANIFEST: OfferedManifest = { occurrences: [{ id: "h1", kind: "hunk" }] };

const TOKENS: RspTokenUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: null,
  total: 15,
};

function admittedReport(): ValidationReport {
  return {
    docType: "ordering",
    admission: "atomic",
    admitted: true,
    errors: [],
    admittedItemCount: null,
    rejectedItemCount: 0,
    rejectedItems: [],
  };
}

function rejectedReport(): ValidationReport {
  return {
    docType: "ordering",
    admission: "atomic",
    admitted: false,
    errors: [{ code: "V006", pointer: "/body", message: "quote not found in span" }],
    admittedItemCount: null,
    rejectedItemCount: 0,
    rejectedItems: [],
  };
}

function envelope(body: unknown): RspEnvelope {
  return {
    rsp: 1,
    docType: "ordering",
    schemaVersion: 1,
    docId: "DOC1",
    patchsetId: "patch-1",
    // The runTurn reads only `document.body`; a minimal provenance is fine here.
    provenance: {
      harness: "codex",
      harnessVersion: "unknown",
      adapterVersion: "0.1.0",
      model: "gpt-5.6-terra",
      modelReportedBy: "config",
      tier: "light",
      route: "utility",
      runId: "run_x",
      inputDigest: "digest",
      capability: {
        structuredOutput: {
          implementedByAdapter: true,
          advertisedByHarness: true,
          availableInSession: true,
        },
        perCallModelSelection: {
          implementedByAdapter: true,
          advertisedByHarness: true,
          availableInSession: true,
        },
      },
      tokens: TOKENS,
      reportedUsd: null,
      derivedUsd: null,
      effort: "medium",
    },
    body,
    x: {},
  };
}

function portReturning(result: CodexUtilityResult): {
  port: CodexUtilityPort;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn(async (): Promise<CodexUtilityResult> => result);
  return { port: { complete }, complete };
}

describe("createCodexRunTurn", () => {
  it("maps an admitted document to an emitted body carrying the document body", async () => {
    const body = { readingOrder: ["c1", "c2"], rationale: "logical" };
    const { port, complete } = portReturning({
      status: "admitted",
      document: envelope(body),
      report: admittedReport(),
      tokens: TOKENS,
      attempts: [],
    });

    const runTurn = createCodexRunTurn(port, {
      docType: "ordering",
      patchset: PATCHSET,
      manifest: MANIFEST,
      model: "gpt-5.6-terra",
      effort: "medium",
    });

    const turn = await runTurn("the prompt", 0);
    expect(turn.status).toBe("emitted");
    if (turn.status !== "emitted") throw new Error("unreachable");
    expect(turn.body).toEqual(body);
    expect(turn.tokens).toEqual(TOKENS);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("carries the port's honest executor facts back on the emitted turn (#88)", async () => {
    const doc = envelope({ readingOrder: ["c1"], rationale: "logical" });
    const { port } = portReturning({
      status: "admitted",
      document: doc,
      report: admittedReport(),
      tokens: TOKENS,
      attempts: [],
    });

    const runTurn = createCodexRunTurn(port, {
      docType: "ordering",
      patchset: PATCHSET,
      manifest: MANIFEST,
      model: "gpt-5.6-terra",
      effort: "medium",
    });

    const turn = await runTurn("the prompt", 0);
    if (turn.status !== "emitted") throw new Error("unreachable");
    // The runner re-stamps the envelope, but must stamp WHAT RAN: the port's
    // utility/light route and its per-call capability, not the seat's default.
    expect(turn.executor).toEqual({
      route: "utility",
      tier: "light",
      capability: doc.provenance.capability,
    });
  });

  it("passes the seat's docType, model, effort, patchset, manifest, and maxRetries:0 to the port", async () => {
    const { port, complete } = portReturning({
      status: "admitted",
      document: envelope({ readingOrder: [], rationale: "" }),
      report: admittedReport(),
      tokens: TOKENS,
      attempts: [],
    });

    const runTurn = createCodexRunTurn(port, {
      docType: "decomposition.proposal",
      patchset: PATCHSET,
      manifest: MANIFEST,
      model: "gpt-5.6-sol",
      effort: "high",
    });

    await runTurn("assembled prompt text", 2);

    // The runner, not the port, owns retries and the shared budget: exactly one
    // port call per turn, with maxRetries pinned to 0.
    expect(complete).toHaveBeenCalledTimes(1);
    const req = complete.mock.calls[0]?.[0] as CodexUtilityCompleteRequest;
    expect(req.docType).toBe("decomposition.proposal");
    expect(req.model).toBe("gpt-5.6-sol");
    expect(req.effort).toBe("high");
    expect(req.maxRetries).toBe(0);
    expect(req.patchset).toEqual(PATCHSET);
    expect(req.manifest).toEqual(MANIFEST);
    expect(req.prompt).toBe("assembled prompt text");
  });

  it("maps a rejection to a turn failure so the runner retries and the floor can stand", async () => {
    const { port } = portReturning({
      status: "rejected",
      report: rejectedReport(),
      attempts: [],
    });

    const runTurn = createCodexRunTurn(port, {
      docType: "ordering",
      patchset: PATCHSET,
      manifest: MANIFEST,
      model: "gpt-5.6-terra",
      effort: "medium",
    });

    const turn = await runTurn("prompt", 0);
    expect(turn.status).toBe("failed");
    if (turn.status !== "failed") throw new Error("unreachable");
    expect(turn.message).toContain("V006");
  });

  it("maps an exec failure to a turn failure", async () => {
    const { port } = portReturning({
      status: "exec-failed",
      message: "codex exec exited 1: no stderr",
      attempts: [],
    });

    const runTurn = createCodexRunTurn(port, {
      docType: "ordering",
      patchset: PATCHSET,
      manifest: MANIFEST,
      model: "gpt-5.6-terra",
      effort: "medium",
    });

    const turn = await runTurn("prompt", 0);
    expect(turn.status).toBe("failed");
    if (turn.status !== "failed") throw new Error("unreachable");
    expect(turn.message).toContain("codex exec exited 1");
  });

  it("forwards an abort signal to the port", async () => {
    const { port, complete } = portReturning({
      status: "admitted",
      document: envelope({ readingOrder: [], rationale: "" }),
      report: admittedReport(),
      tokens: TOKENS,
      attempts: [],
    });
    const controller = new AbortController();
    const runTurn = createCodexRunTurn(port, {
      docType: "ordering",
      patchset: PATCHSET,
      manifest: MANIFEST,
      model: "gpt-5.6-terra",
      effort: "medium",
      signal: controller.signal,
    });
    await runTurn("prompt", 0);
    const req = complete.mock.calls[0]?.[0] as CodexUtilityCompleteRequest;
    expect(req.signal).toBe(controller.signal);
  });
});
