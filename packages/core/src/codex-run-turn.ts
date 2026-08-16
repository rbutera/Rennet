/**
 * The injected turn: a `CodexUtilityPort` → `runTurn` adapter (issue #69, bead
 * workspace-sglle).
 *
 * `runDecompositionAngle` (#8) and `runOrderingPass` (#9) both take an injected
 * `runTurn(prompt, attempt)` so the model wiring is the caller's. `createHarnessRunTurn`
 * supplies that turn for a Claude-resolved seat; THIS supplies it for a
 * Codex-resolved seat, so the Model Council's cross-harness routing (R39) is not
 * merely NAMED in provenance but actually EXECUTED — the light-tier seat runs on
 * the cheap Codex model at $0 metered.
 *
 * It depends ONLY on the `CodexUtilityPort` interface (this package), never on
 * `@rennet/adapters`, so `core` never imports `adapters` — the concrete
 * `codex exec` executor is composed by `apps/desktop` and passed in behind the
 * port. The division of labour is deliberate:
 *
 *   - The RUNNER (`runDecompositionAngle`/`runOrderingPass`) owns the shared
 *     invocation budget, the retry loop, the seat provenance stamping, and the
 *     deterministic floor. So one turn here is EXACTLY one port call: the port
 *     is invoked with `maxRetries: 0`, and every retry — the money-relevant
 *     count (R10) — is the runner's, drawn from the one shared budget.
 *   - The PORT owns the `codex exec` spawn, the docType→schema derivation
 *     (schema-constrained emission), and the admission decision. An admitted
 *     document's body is handed back as an emitted turn (the runner re-stamps it
 *     with the seat provenance and re-validates); a rejection or exec failure is
 *     a turn failure, so the runner retries and the always-present deterministic
 *     floor stands. "Never admits blind" holds at both layers.
 */

import type { OfferedManifest, PatchsetRef, RspDocType } from "@rennet/types";
import type { CodexUtilityPort } from "./codex-utility-port";
import type { HarnessTurnResult } from "./harness-run-turn";

export interface CodexRunTurnOptions {
  /** The document type this seat emits; determines the port's output schema. */
  readonly docType: RspDocType;
  /** The immutable patchset the document binds to (for the port's validation). */
  readonly patchset: PatchsetRef;
  /** The offered manifest the port resolves anchors against — the SAME one the
   *  runner validates over, so the two admission checks agree. */
  readonly manifest: OfferedManifest;
  /** The resolved Codex model, e.g. "gpt-5.6-terra". */
  readonly model: string;
  /** The resolved reasoning effort, e.g. "medium". */
  readonly effort: string;
  readonly signal?: AbortSignal;
}

/** Render the rejection into the failure message the runner records as a turn
 *  failure (the runner does not feed a port rejection back into the port; the
 *  port ran a single attempt, so a retry is a fresh runner turn). */
function rejectionMessage(errors: readonly { code: string; message: string }[]): string {
  const first = errors[0];
  if (first === undefined) return "the codex utility port rejected the document";
  return `codex utility rejected: ${first.code} ${first.message}`;
}

/**
 * Build the injected `runTurn` for one Codex-resolved seat over a
 * `CodexUtilityPort`. Each call runs exactly ONE `port.complete` with
 * `maxRetries: 0` and maps the terminal result: an admitted document becomes an
 * emitted body (with the port's token usage), a rejection or exec failure
 * becomes a turn failure.
 */
export function createCodexRunTurn(
  port: CodexUtilityPort,
  options: CodexRunTurnOptions,
): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  return async function runTurn(prompt: string): Promise<HarnessTurnResult> {
    const result = await port.complete({
      docType: options.docType,
      prompt,
      model: options.model,
      effort: options.effort,
      patchset: options.patchset,
      manifest: options.manifest,
      // The runner owns retries and the shared budget; the port runs once.
      maxRetries: 0,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (result.status === "admitted") {
      // Carry the port's HONEST provenance back to the runner (#88): the codex
      // utility port built `route:"utility"`, `tier:"light"`, and a per-call
      // capability snapshot; without this the runner would re-stamp the seat's
      // `agentic`/`heavy` defaults over a turn the utility port actually ran.
      const { route, tier, capability } = result.document.provenance;
      return {
        status: "emitted",
        body: result.document.body,
        tokens: result.tokens,
        executor: { route, tier, capability },
      };
    }
    if (result.status === "rejected") {
      return { status: "failed", message: rejectionMessage(result.report.errors) };
    }
    return { status: "failed", message: result.message };
  };
}
