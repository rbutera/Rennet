import { ORDERING_CONTRACT } from "@rennet/instructions";
import { sha256Hex } from "@rennet/protocol";
import type { DecompositionProposalBody, OrderingBody, RspCapabilitySnapshot } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { createInvocationBudget } from "./invocation-budget";
import {
  buildChunkManifest,
  deterministicOrderingBody,
  type OrderingProvenanceSeed,
  type OrderingTurnResult,
  resolveLiveOrder,
  runOrderingPass,
} from "./ordering-pass";

// ── A tiny admitted decomposition: three chunks, one dependency c1 -> c2 ──────

const PROPOSAL: DecompositionProposalBody = {
  chunks: [
    {
      chunkId: "c1",
      title: "schema",
      hunkIds: ["h1"],
      angles: ["sequence"],
      rationale: "the base",
    },
    {
      chunkId: "c2",
      title: "core",
      hunkIds: ["h2"],
      angles: ["sequence"],
      rationale: "the middle",
    },
    { chunkId: "c3", title: "ui", hunkIds: ["h3"], angles: ["sequence"], rationale: "the top" },
  ],
  edges: [{ from: "c1", to: "c2", kind: "enables" }],
  readingOrder: ["c1", "c2", "c3"], // the deterministic baseline
  residue: [],
};

const PATCHSET_ID = "ps_1";

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

const SEED: OrderingProvenanceSeed = {
  harness: "claude-code",
  harnessVersion: "2.1.220",
  adapterVersion: "0.1.0",
  model: "claude-opus-4-8",
  modelReportedBy: "harness",
  capability: CAPABILITY,
};

/** An agent order that DIFFERS from the baseline but respects the c1 -> c2 edge. */
const AGENT_ORDER: OrderingBody = {
  readingOrder: ["c1", "c3", "c2"],
  rationale: "Read the base, then the surface it enables, then the caller.",
};

function scriptedTurn(
  bodies: unknown[],
): (prompt: string, attempt: number) => Promise<OrderingTurnResult> {
  return (_prompt, attempt) => {
    const body = bodies[attempt];
    if (body === undefined)
      return Promise.resolve({ status: "failed", message: "no scripted body" });
    return Promise.resolve({ status: "emitted", body });
  };
}

function base(input: Partial<Parameters<typeof runOrderingPass>[0]> = {}) {
  return {
    proposal: PROPOSAL,
    patchsetId: PATCHSET_ID,
    contract: ORDERING_CONTRACT,
    provenance: SEED,
    runTurn: scriptedTurn([AGENT_ORDER]),
    // Explicit budget by default so ordering-logic tests exercise a real ceiling.
    // (An absent budget runs ungated per #260 — no ceiling.) Overridable via input.
    budget: createInvocationBudget(10),
    ...input,
  };
}

describe("buildChunkManifest", () => {
  it("offers exactly the decomposition's chunk ids as chunk occurrences", () => {
    const manifest = buildChunkManifest(PROPOSAL);
    expect(manifest.occurrences.map((o) => o.id).sort()).toEqual(["c1", "c2", "c3"]);
    expect(manifest.occurrences.every((o) => o.kind === "chunk")).toBe(true);
  });
});

describe("runOrderingPass — the agent produces the order (no user approval)", () => {
  it("feeds assembled context verbatim and preserves the absent-context prompt golden", async () => {
    const capture = async (assembledContext?: string): Promise<string> => {
      let prompt = "";
      await runOrderingPass(
        base({
          assembledContext,
          runTurn: (sent) => {
            prompt = sent;
            return Promise.resolve({ status: "emitted", body: AGENT_ORDER });
          },
        }),
      );
      return prompt;
    };
    const context = "shared context line one\nshared context line two";
    const absent = await capture();
    const present = await capture(context);

    expect(sha256Hex(absent)).toBe(
      "18ecc07374cb598854386ba19586da8acc9ee70cc2e92ed1928027292cd4adca",
    );
    expect(absent).not.toContain("<<<rennet:layer context>>>");
    expect(present).toContain(
      `<<<rennet:layer context>>>\n${context}\n\n<<<rennet:layer payload>>>`,
    );
  });

  it("admits a valid agent order and stamps the envelope itself", async () => {
    const result = await runOrderingPass(
      base({ mintDocId: () => "0123456789ABCDEFGHJKMNPQRS", newRunId: () => "run_fixed" }),
    );
    expect(result.admitted).toBe(true);
    expect(result.usedFallback).toBe(false);
    expect(result.document.docId).toBe("0123456789ABCDEFGHJKMNPQRS");
    expect(result.document.provenance.runId).toBe("run_fixed");
    expect(result.document.provenance.inputDigest).toMatch(/^sha256:/);
    expect(result.document.provenance.route).toBe("agentic");
    expect((result.document.body as OrderingBody).readingOrder).toEqual(["c1", "c3", "c2"]);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.outcome).toBe("admitted");
  });

  it("never places a forbidden ordering signal (blast-radius) in the model prompt", async () => {
    // Correction 8: danger/blast-radius/salience must never reach the ordering
    // prompt as a signal. The contract's prohibition prose names "blast radius"
    // (spaced) legitimately; the hyphenated angle token "blast-radius" only ever
    // came from the chunk payload, and must not be there.
    const withBlastRadius: DecompositionProposalBody = {
      ...PROPOSAL,
      chunks: PROPOSAL.chunks.map((chunk, index) =>
        index === 0 ? { ...chunk, angles: ["sequence", "blast-radius"] } : chunk,
      ),
    };
    let capturedPrompt = "";
    const capturing = (prompt: string, attempt: number): Promise<OrderingTurnResult> => {
      capturedPrompt = prompt;
      return scriptedTurn([AGENT_ORDER])(prompt, attempt);
    };
    await runOrderingPass(base({ proposal: withBlastRadius, runTurn: capturing }));
    expect(capturedPrompt).not.toContain("blast-radius");
  });

  it("feeds a rejection back and admits on the retry", async () => {
    const missingChunk: OrderingBody = {
      readingOrder: ["c1", "c2"],
      rationale: "oops, dropped c3",
    };
    const result = await runOrderingPass(
      base({ runTurn: scriptedTurn([missingChunk, AGENT_ORDER]), maxRetries: 2 }),
    );
    expect(result.admitted).toBe(true);
    expect(result.usedFallback).toBe(false);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.outcome).toBe("rejected");
    expect(result.attempts[0]?.report?.errors.map((e) => e.code)).toContain("V111");
    expect(result.attempts[1]?.outcome).toBe("admitted");
  });

  it("falls back to the deterministic baseline when every attempt is rejected", async () => {
    const bad: OrderingBody = { readingOrder: ["c1", "c2"], rationale: "still missing c3" };
    const result = await runOrderingPass(
      base({ runTurn: scriptedTurn([bad, bad, bad]), maxRetries: 2 }),
    );
    expect(result.usedFallback).toBe(true);
    expect(result.admitted).toBe(true);
    expect(result.document.provenance.route).toBe("deterministic");
    expect(result.document.provenance.tier).toBe("deterministic");
    expect((result.document.body as OrderingBody).readingOrder).toEqual(["c1", "c2", "c3"]);
    expect(result.attempts.filter((a) => a.outcome === "rejected")).toHaveLength(3);
  });

  it("falls back when the turn itself fails", async () => {
    const result = await runOrderingPass(
      base({
        runTurn: () => Promise.resolve({ status: "failed", message: "overloaded" }),
        maxRetries: 1,
      }),
    );
    expect(result.usedFallback).toBe(true);
    expect(result.admitted).toBe(true);
    expect(result.attempts.every((a) => a.outcome === "turn-failed")).toBe(true);
  });

  it("is fail-closed: an order violating a dependency edge falls back to the baseline", async () => {
    // c2 before c1 violates the c1 -> c2 edge; the document is a valid cover, so
    // the RSP validator admits it, but the pass's dependency floor rejects it.
    const violating: OrderingBody = {
      readingOrder: ["c2", "c1", "c3"],
      rationale: "reads the caller before the thing it depends on",
    };
    const result = await runOrderingPass(
      base({ runTurn: scriptedTurn([violating]), maxRetries: 0 }),
    );
    expect(result.usedFallback).toBe(true);
    expect(result.document.provenance.route).toBe("deterministic");
    expect(result.attempts[0]?.outcome).toBe("rejected");
    expect(result.attempts[0]?.report?.errors.map((e) => e.code)).toContain("ORDER_DEPENDENCY");
    expect((result.document.body as OrderingBody).readingOrder).toEqual(["c1", "c2", "c3"]);
  });
});

describe("deterministicOrderingBody", () => {
  it("projects the baseline reading order into a valid ordering body", () => {
    const body = deterministicOrderingBody(PROPOSAL);
    expect(body.readingOrder).toEqual(["c1", "c2", "c3"]);
    expect(body.rationale.trim().length).toBeGreaterThan(0);
  });
});

describe("resolveLiveOrder — the canvas consumes the live order (agent ≠ baseline)", () => {
  it("returns the agent order with route agentic when admitted, baseline unchanged", async () => {
    const result = await runOrderingPass(base());
    const live = resolveLiveOrder(result);
    // Agent order differs from the baseline and is the live order.
    expect(live.readingOrder).toEqual(["c1", "c3", "c2"]);
    expect(live.route).toBe("agentic");
    expect(result.baselineOrder).toEqual(["c1", "c2", "c3"]);
    // Both are covers of the same chunk set (a switch renders either correctly).
    expect([...live.readingOrder].sort()).toEqual([...result.baselineOrder].sort());
  });

  it("returns the baseline with route deterministic on fallback", async () => {
    const bad: OrderingBody = { readingOrder: ["c1", "c2"], rationale: "missing c3" };
    const result = await runOrderingPass(base({ runTurn: scriptedTurn([bad]), maxRetries: 0 }));
    const live = resolveLiveOrder(result);
    expect(live.readingOrder).toEqual(["c1", "c2", "c3"]);
    expect(live.route).toBe("deterministic");
    expect(live.readingOrder).toEqual(result.baselineOrder);
  });
});
