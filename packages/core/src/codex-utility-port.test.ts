import { computeInputDigest } from "@rennet/protocol";
import type { OfferedManifest, PatchsetRef } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  type CodexExecRequest,
  type CodexExecutor,
  createCodexUtilityPort,
  DEFAULT_CODEX_UTILITY_EFFORT,
  DEFAULT_CODEX_UTILITY_MODEL,
} from "./codex-utility-port";

// ── Fixtures: a minimal `ordering` scenario (the proven spike docType) ─────────
// `ordering` has a body schema (so the port derives + passes an outputSchema) and
// per-body rules (V111/V112/V113) checked against the offered `chunk` set, so a
// document is admittable iff its readingOrder is an exact cover of the chunks.

const PATCHSET: PatchsetRef = { id: "ps-1" };
const MANIFEST: OfferedManifest = {
  occurrences: [
    { id: "c1", kind: "chunk" },
    { id: "c2", kind: "chunk" },
  ],
};

const VALID_ORDERING = {
  readingOrder: ["c1", "c2"],
  rationale: "high-level first, then bottom-up",
};
// cX is not an offered chunk (V112) and c2 is missing from the cover (V111): rejected.
const INVALID_ORDERING = { readingOrder: ["c1", "cX"], rationale: "broken" };
// SHAPE-invalid: readingOrder must be an array of strings; a bare string fails the
// projected body schema itself (not just the semantic ordering rules), so this
// proves fail-closed at the SCHEMA layer, not only the semantic layer.
const SHAPE_INVALID_ORDERING = { readingOrder: "c1", rationale: "broken shape" };

// A valid 26-char Crockford base32 docId (excludes I/L/O/U) so V002's docId regex passes.
const DOC_ID = "0123456789ABCDEFGHJKMNPQRS";

interface FakeExec {
  readonly executor: CodexExecutor;
  readonly calls: CodexExecRequest[];
}

/** A fake executor returning one canned output per attempt (last output repeats). */
function fakeExecutor(outputs: readonly unknown[]): FakeExec {
  const calls: CodexExecRequest[] = [];
  let index = 0;
  const executor: CodexExecutor = async (req) => {
    calls.push(req);
    const output = outputs[Math.min(index, outputs.length - 1)];
    index += 1;
    return { output };
  };
  return { executor, calls };
}

function portWith(exec: FakeExec) {
  return createCodexUtilityPort({
    executor: exec.executor,
    mintDocId: () => DOC_ID,
    newRunId: () => "run_test",
  });
}

describe("CodexUtilityPort", () => {
  it("returns a validator-ADMITTED RSP document from a faked executor, stamped light/utility", async () => {
    const exec = fakeExecutor([VALID_ORDERING]);
    const result = await portWith(exec).complete({
      docType: "ordering",
      prompt: "Order these chunks for comprehension.",
      patchset: PATCHSET,
      manifest: MANIFEST,
    });

    expect(result.status).toBe("admitted");
    if (result.status !== "admitted") return;

    // The trustworthy envelope the port stamped around the executor body.
    expect(result.document.docType).toBe("ordering");
    expect(result.document.body).toEqual(VALID_ORDERING);
    expect(result.document.docId).toBe(DOC_ID);
    expect(result.document.patchsetId).toBe("ps-1");
    expect(result.report.admitted).toBe(true);

    const p = result.document.provenance;
    expect(p.harness).toBe("codex");
    expect(p.tier).toBe("light");
    expect(p.route).toBe("utility");
    expect(p.model).toBe(DEFAULT_CODEX_UTILITY_MODEL);
    expect(p.effort).toBe(DEFAULT_CODEX_UTILITY_EFFORT);
    expect(p.modelReportedBy).toBe("config");
    expect(p.reportedUsd).toBeNull();
    expect(p.derivedUsd).toBeNull();
    // The digest is computed over the offered input by the port, never the agent.
    expect(p.inputDigest).toBe(computeInputDigest(PATCHSET, MANIFEST));
    // V003 requires both capabilities, each with all three layers.
    for (const cap of [p.capability.structuredOutput, p.capability.perCallModelSelection]) {
      expect(cap.implementedByAdapter).toBe(true);
      expect(cap.advertisedByHarness).toBe(true);
      expect(cap.availableInSession).toBe(true);
    }
  });

  it("passes the docType-derived output schema, model, and effort to the executor", async () => {
    const exec = fakeExecutor([VALID_ORDERING]);
    await portWith(exec).complete({
      docType: "ordering",
      prompt: "Order these.",
      patchset: PATCHSET,
      manifest: MANIFEST,
    });
    expect(exec.calls).toHaveLength(1);
    // `ordering` has a body schema, so the executor is asked to constrain output.
    expect(exec.calls[0]?.outputSchema).toBeDefined();
    expect(exec.calls[0]?.model).toBe(DEFAULT_CODEX_UTILITY_MODEL);
    expect(exec.calls[0]?.effort).toBe(DEFAULT_CODEX_UTILITY_EFFORT);
    expect(exec.calls[0]?.prompt).toContain("Order these.");
  });

  it("honours per-request model + effort overrides", async () => {
    const exec = fakeExecutor([VALID_ORDERING]);
    const result = await portWith(exec).complete({
      docType: "ordering",
      prompt: "Order.",
      model: "gpt-5.6-terra",
      effort: "medium",
      patchset: PATCHSET,
      manifest: MANIFEST,
    });
    expect(exec.calls[0]?.model).toBe("gpt-5.6-terra");
    expect(exec.calls[0]?.effort).toBe("medium");
    if (result.status === "admitted") {
      expect(result.document.provenance.model).toBe("gpt-5.6-terra");
      expect(result.document.provenance.effort).toBe("medium");
    }
  });

  it("retries a rejected document with the report fed back, then admits", async () => {
    const exec = fakeExecutor([INVALID_ORDERING, VALID_ORDERING]);
    const result = await portWith(exec).complete({
      docType: "ordering",
      prompt: "Order these chunks.",
      patchset: PATCHSET,
      manifest: MANIFEST,
    });
    expect(result.status).toBe("admitted");
    expect(result.attempts.map((a) => a.outcome)).toEqual(["rejected", "admitted"]);
    // The second prompt carried the rejection report so the model can fix it.
    expect(exec.calls).toHaveLength(2);
    expect(exec.calls[1]?.prompt).toContain("REJECTED");
  });

  it("fails closed (never admits blind) when every attempt is rejected", async () => {
    const exec = fakeExecutor([INVALID_ORDERING]);
    const result = await portWith(exec).complete({
      docType: "ordering",
      prompt: "Order these chunks.",
      patchset: PATCHSET,
      manifest: MANIFEST,
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.report.admitted).toBe(false);
    }
    // Three attempts: initial + 2 retries (the default).
    expect(exec.calls).toHaveLength(3);
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.every((a) => a.outcome === "rejected")).toBe(true);
  });

  it("respects a custom maxRetries", async () => {
    const exec = fakeExecutor([INVALID_ORDERING]);
    const result = await portWith(exec).complete({
      docType: "ordering",
      prompt: "Order.",
      patchset: PATCHSET,
      manifest: MANIFEST,
      maxRetries: 0,
    });
    expect(result.status).toBe("rejected");
    expect(exec.calls).toHaveLength(1);
  });

  it("surfaces a terminal executor failure as exec-failed", async () => {
    const calls: CodexExecRequest[] = [];
    const executor: CodexExecutor = async (req) => {
      calls.push(req);
      throw new Error("codex spawn failed");
    };
    const port = createCodexUtilityPort({ executor, mintDocId: () => DOC_ID });
    const result = await port.complete({
      docType: "ordering",
      prompt: "Order.",
      patchset: PATCHSET,
      manifest: MANIFEST,
    });
    expect(result.status).toBe("exec-failed");
    if (result.status === "exec-failed") {
      expect(result.message).toContain("codex spawn failed");
    }
    // It still exhausted its attempts before giving up.
    expect(calls).toHaveLength(3);
  });

  it("fails closed on a SCHEMA-invalid body (not merely a semantic violation)", async () => {
    const exec = fakeExecutor([SHAPE_INVALID_ORDERING]);
    const result = await portWith(exec).complete({
      docType: "ordering",
      prompt: "Order these chunks.",
      patchset: PATCHSET,
      manifest: MANIFEST,
      maxRetries: 0,
    });
    // A body that violates the projected schema shape must never be admitted.
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.report.admitted).toBe(false);
    }
  });

  it("stamps structuredOutput.availableInSession HONESTLY: false when no schema was exercised", async () => {
    // `finding` has no body schema (bodyJsonSchema returns null), so NO
    // --output-schema is passed and structured output is NOT exercised this call.
    // The capability snapshot must not claim it was available in session.
    const exec = fakeExecutor([{}]);
    const result = await portWith(exec).complete({
      docType: "finding",
      prompt: "Report a finding.",
      patchset: PATCHSET,
      manifest: MANIFEST,
    });
    expect(result.status).toBe("admitted");
    if (result.status !== "admitted") return;
    const cap = result.document.provenance.capability;
    // Honest: structured output was neither passed nor exercised for this call.
    expect(cap.structuredOutput.availableInSession).toBe(false);
    // The adapter still IMPLEMENTS and the harness still ADVERTISES it (static facts).
    expect(cap.structuredOutput.implementedByAdapter).toBe(true);
    expect(cap.structuredOutput.advertisedByHarness).toBe(true);
    // `-m` IS always passed, so per-call model selection is genuinely available.
    expect(cap.perCallModelSelection.availableInSession).toBe(true);

    // The exec call carried no schema, corroborating the honest stamp.
    expect(exec.calls[0]?.outputSchema).toBeUndefined();
  });

  it("still stamps structuredOutput available when a schema IS exercised (ordering)", async () => {
    const exec = fakeExecutor([VALID_ORDERING]);
    const result = await portWith(exec).complete({
      docType: "ordering",
      prompt: "Order these chunks.",
      patchset: PATCHSET,
      manifest: MANIFEST,
    });
    expect(result.status).toBe("admitted");
    if (result.status !== "admitted") return;
    expect(result.document.provenance.capability.structuredOutput.availableInSession).toBe(true);
  });

  it("short-circuits an already-aborted signal without spending any executor call", async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = fakeExecutor([VALID_ORDERING]);
    const result = await portWith(exec).complete({
      docType: "ordering",
      prompt: "Order these chunks.",
      patchset: PATCHSET,
      manifest: MANIFEST,
      signal: controller.signal,
    });
    // No metered/quota spend after cancellation, and never an admit.
    expect(exec.calls).toHaveLength(0);
    expect(result.status).not.toBe("admitted");
  });

  it("prefers a rejection report over an exec failure when both occurred", async () => {
    // attempt 0 rejects (has a report), attempts 1+2 throw: the terminal state is
    // the more-informative rejection, not exec-failed.
    const calls: CodexExecRequest[] = [];
    let index = 0;
    const executor: CodexExecutor = async (req) => {
      calls.push(req);
      const attempt = index;
      index += 1;
      if (attempt === 0) return { output: INVALID_ORDERING };
      throw new Error("later spawn failed");
    };
    const port = createCodexUtilityPort({ executor, mintDocId: () => DOC_ID });
    const result = await port.complete({
      docType: "ordering",
      prompt: "Order.",
      patchset: PATCHSET,
      manifest: MANIFEST,
    });
    expect(result.status).toBe("rejected");
  });
});
