import {
  DECOMPOSITION_PROPOSAL_CONTRACT,
  DECOMPOSITION_SKELETON_CONTRACT,
} from "@rennet/instructions";
import { CHUNK_ASSIGNABLE_ANGLES, sha256Hex } from "@rennet/protocol";
import type {
  DecompositionProposalBody,
  PatchFile,
  Patchset,
  RspCapabilitySnapshot,
  RspEnvelope,
} from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  buildOfferedManifest,
  type DecompositionProvenanceSeed,
  type DecompositionTurnResult,
  deterministicProposalBody,
  runDecompositionAngle,
} from "./angle-generation";
import { createCodexRunTurn } from "./codex-run-turn";
import type { CodexUtilityPort, CodexUtilityResult } from "./codex-utility-port";
import { decompose } from "./decomposition";
import { createInvocationBudget } from "./invocation-budget";

// ── A tiny real changeset: b.ts imports a.ts, plus one lockfile (mechanical) ─

function file(path: string, patch: string, extra: Partial<PatchFile> = {}): PatchFile {
  return {
    path,
    status: "modified",
    additions: null,
    deletions: null,
    binary: false,
    patch,
    ...extra,
  };
}

function patch(path: string, lines: string[]): string {
  const oldCount = lines.filter((l) => l[0] === "-" || l[0] === " ").length;
  const newCount = lines.filter((l) => l[0] === "+" || l[0] === " ").length;
  return (
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
    `@@ -1,${oldCount} +1,${newCount} @@\n${lines.join("\n")}\n`
  );
}

const PATCHSET: Patchset = {
  id: "ps_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/repo",
    commonDir: "/repo/.git",
    baseRef: "origin/main",
    baseOid: "0".repeat(40),
    headOid: "1".repeat(40),
  },
  files: [
    file("src/a.ts", patch("src/a.ts", ["+export const a = 1;"])),
    file("src/b.ts", patch("src/b.ts", ['+import { a } from "./a";', "+export const b = a + 1;"])),
    file("pnpm-lock.yaml", patch("pnpm-lock.yaml", ["+  resolution: {integrity: sha512-xxx}"])),
  ],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

const DECOMPOSITION = decompose(PATCHSET);

const CAPABILITY: RspCapabilitySnapshot = {
  structuredOutput: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
  perCallModelSelection: {
    implementedByAdapter: true,
    advertisedByHarness: false,
    availableInSession: false,
  },
};

const SEED: DecompositionProvenanceSeed = {
  harness: "claude-code",
  harnessVersion: "2.1.220",
  adapterVersion: "0.1.0",
  model: "claude-opus-4-8",
  modelReportedBy: "harness",
  capability: CAPABILITY,
};

const PORT_CAPABILITY: RspCapabilitySnapshot = {
  structuredOutput: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
  perCallModelSelection: {
    implementedByAdapter: false,
    advertisedByHarness: false,
    availableInSession: false,
  },
};

function codexEnvelope(body: DecompositionProposalBody): RspEnvelope {
  return {
    rsp: 1,
    docType: "decomposition.proposal",
    schemaVersion: 1,
    docId: "PORT_DOC",
    patchsetId: PATCHSET.id,
    provenance: {
      harness: "codex",
      harnessVersion: "0.9.0",
      adapterVersion: "0.1.0",
      model: "gpt-5.6-terra",
      modelReportedBy: "config",
      tier: "light",
      route: "utility",
      runId: "port_run",
      inputDigest: "sha256:port",
      capability: PORT_CAPABILITY,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: null, total: 2 },
      reportedUsd: null,
      derivedUsd: null,
    },
    body,
    x: {},
  };
}

function codexPort(body: DecompositionProposalBody): CodexUtilityPort {
  return {
    complete: async (): Promise<CodexUtilityResult> => ({
      status: "admitted",
      document: codexEnvelope(body),
      report: {
        docType: "decomposition.proposal",
        admission: "atomic",
        admitted: true,
        errors: [],
        admittedItemCount: null,
        rejectedItemCount: 0,
        rejectedItems: [],
      },
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: null, total: 2 },
      attempts: [],
    }),
  };
}

function scriptedTurn(
  bodies: unknown[],
): (prompt: string, attempt: number) => Promise<DecompositionTurnResult> {
  return (_prompt, attempt) => {
    const body = bodies[attempt];
    if (body === undefined)
      return Promise.resolve({ status: "failed", message: "no scripted body" });
    return Promise.resolve({ status: "emitted", body });
  };
}

describe("buildOfferedManifest", () => {
  it("offers exactly the substantive hunks (mechanical hunks are the noise floor's)", () => {
    const manifest = buildOfferedManifest(DECOMPOSITION);
    const substantiveHunkIds = DECOMPOSITION.classifications
      .filter((classification) => classification.kind === "substantive")
      .map((classification) => classification.hunkId);
    expect(manifest.occurrences.map((occurrence) => occurrence.id).sort()).toEqual(
      [...substantiveHunkIds].sort(),
    );
    expect(manifest.occurrences.every((occurrence) => occurrence.kind === "hunk")).toBe(true);
    // The lockfile hunk is mechanical, so it is not offered.
    expect(manifest.occurrences.length).toBeLessThan(DECOMPOSITION.hunks.length);
  });
});

describe("decomposition prompt angle vocabulary", () => {
  it("advertises exactly the V104 chunk-assignable set", () => {
    for (const contract of [DECOMPOSITION_SKELETON_CONTRACT, DECOMPOSITION_PROPOSAL_CONTRACT]) {
      const advertised = contract.discipline
        .match(/closed set: ([^.]+)\./)?.[1]
        ?.split(",")
        .map((angle) => angle.trim());
      expect(advertised).toEqual([...CHUNK_ASSIGNABLE_ANGLES]);
    }
  });
});

describe("deterministicProposalBody", () => {
  it("projects the floor into a proposal the validator admits", async () => {
    const body = deterministicProposalBody(DECOMPOSITION);
    const manifest = buildOfferedManifest(DECOMPOSITION);
    const result = await runDecompositionAngle({
      decomposition: DECOMPOSITION,
      contract: DECOMPOSITION_PROPOSAL_CONTRACT,
      manifest,
      provenance: SEED,
      runTurn: scriptedTurn([body]),
      maxRetries: 0,
      budget: createInvocationBudget(10), // explicit budget: absent now fails closed (#95)
    });
    expect(result.admitted).toBe(true);
    expect(result.usedFallback).toBe(false);
    expect(result.report.errors).toEqual([]);
  });
});

describe("runDecompositionAngle", () => {
  it("feeds assembled context verbatim and preserves the absent-context prompt golden", async () => {
    const capture = async (assembledContext?: string): Promise<string> => {
      let prompt = "";
      const manifest = buildOfferedManifest(DECOMPOSITION);
      await runDecompositionAngle({
        decomposition: DECOMPOSITION,
        contract: DECOMPOSITION_PROPOSAL_CONTRACT,
        manifest,
        provenance: SEED,
        assembledContext,
        runTurn: (sent) => {
          prompt = sent;
          return Promise.resolve({
            status: "emitted",
            body: deterministicProposalBody(DECOMPOSITION),
          });
        },
        maxRetries: 0,
        budget: createInvocationBudget(10),
      });
      return prompt;
    };
    const context = "shared context line one\nshared context line two";
    const absent = await capture();
    const present = await capture(context);

    expect(sha256Hex(absent)).toBe(
      "0b39d2f9ab6197a48bbe2f0a6b43e9b353a6d11e566dacff503c18115d006c91",
    );
    expect(absent).not.toContain("<<<rennet:layer context>>>");
    expect(present).toContain(
      `<<<rennet:layer context>>>\n${context}\n\n<<<rennet:layer payload>>>`,
    );
  });

  it("admits a valid body and stamps the envelope itself (agent never mints identity)", async () => {
    const manifest = buildOfferedManifest(DECOMPOSITION);
    const body = deterministicProposalBody(DECOMPOSITION);
    const result = await runDecompositionAngle({
      decomposition: DECOMPOSITION,
      contract: DECOMPOSITION_PROPOSAL_CONTRACT,
      manifest,
      provenance: SEED,
      runTurn: scriptedTurn([body]),
      budget: createInvocationBudget(10), // explicit budget: absent now fails closed (#95)
      mintDocId: () => "0123456789ABCDEFGHJKMNPQRS",
      newRunId: () => "run_fixed",
    });
    expect(result.admitted).toBe(true);
    // The orchestration minted docId and stamped inputDigest, not the agent's body.
    expect(result.document.docId).toBe("0123456789ABCDEFGHJKMNPQRS");
    expect(result.document.provenance.runId).toBe("run_fixed");
    expect(result.document.provenance.inputDigest).toMatch(/^sha256:/);
    expect(result.document.provenance.route).toBe("agentic");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.outcome).toBe("admitted");
  });

  it("prefers a Codex utility turn's executor provenance over the seed (#88)", async () => {
    const manifest = buildOfferedManifest(DECOMPOSITION);
    const body = deterministicProposalBody(DECOMPOSITION);
    const runTurn = createCodexRunTurn(codexPort(body), {
      docType: "decomposition.proposal",
      patchset: { id: PATCHSET.id },
      manifest,
      model: "gpt-5.6-terra",
      effort: "medium",
    });
    const result = await runDecompositionAngle({
      decomposition: DECOMPOSITION,
      contract: DECOMPOSITION_PROPOSAL_CONTRACT,
      manifest,
      provenance: SEED,
      runTurn,
      budget: createInvocationBudget(10),
    });

    expect(result.document.provenance.route).toBe("utility");
    expect(result.document.provenance.tier).toBe("light");
    expect(result.document.provenance.capability).toEqual(PORT_CAPABILITY);
  });

  it("feeds a rejection back and admits on the retry", async () => {
    const manifest = buildOfferedManifest(DECOMPOSITION);
    const valid = deterministicProposalBody(DECOMPOSITION);
    // An invalid first body: drop a hunk so totality (V100) fails.
    const invalid: DecompositionProposalBody = JSON.parse(JSON.stringify(valid));
    if (invalid.chunks[0]) invalid.chunks[0].hunkIds = [];
    const result = await runDecompositionAngle({
      decomposition: DECOMPOSITION,
      contract: DECOMPOSITION_PROPOSAL_CONTRACT,
      manifest,
      provenance: SEED,
      runTurn: scriptedTurn([invalid, valid]),
      maxRetries: 2,
      budget: createInvocationBudget(10), // explicit budget: absent now fails closed (#95)
    });
    expect(result.admitted).toBe(true);
    expect(result.usedFallback).toBe(false);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.outcome).toBe("rejected");
    expect(result.attempts[0]?.report?.errors.map((error) => error.code)).toContain("V100");
    expect(result.attempts[1]?.outcome).toBe("admitted");
  });

  it("falls back to the deterministic floor when every attempt is rejected", async () => {
    const manifest = buildOfferedManifest(DECOMPOSITION);
    const valid = deterministicProposalBody(DECOMPOSITION);
    const invalid: DecompositionProposalBody = JSON.parse(JSON.stringify(valid));
    if (invalid.chunks[0]) invalid.chunks[0].hunkIds = [];
    const result = await runDecompositionAngle({
      decomposition: DECOMPOSITION,
      contract: DECOMPOSITION_PROPOSAL_CONTRACT,
      manifest,
      provenance: SEED,
      runTurn: scriptedTurn([invalid, invalid, invalid]),
      maxRetries: 2,
      budget: createInvocationBudget(10), // explicit budget: absent now fails closed (#95)
    });
    expect(result.usedFallback).toBe(true);
    expect(result.admitted).toBe(true);
    expect(result.document.provenance.route).toBe("deterministic");
    expect(result.document.provenance.tier).toBe("deterministic");
    // Three rejected attempts, then the fallback.
    expect(result.attempts.filter((attempt) => attempt.outcome === "rejected")).toHaveLength(3);
  });

  it("falls back when the turn itself fails", async () => {
    const manifest = buildOfferedManifest(DECOMPOSITION);
    const result = await runDecompositionAngle({
      decomposition: DECOMPOSITION,
      contract: DECOMPOSITION_PROPOSAL_CONTRACT,
      manifest,
      provenance: SEED,
      runTurn: () => Promise.resolve({ status: "failed", message: "harness overloaded" }),
      maxRetries: 1,
      budget: createInvocationBudget(10), // explicit budget: absent now fails closed (#95)
    });
    expect(result.usedFallback).toBe(true);
    expect(result.admitted).toBe(true);
    expect(result.attempts.every((attempt) => attempt.outcome === "turn-failed")).toBe(true);
  });
});
