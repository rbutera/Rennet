import type { DeltaDigestResult, SuccessorAccount } from "@rennet/protocol";
import type { SessionContextFile } from "./session-context";

export type { DeltaDigestResult };

// ─────────────────────────────────────────────────────────────────────────────
// review.deltaDigest — the light-tier prose over the successor account (#73 / M25,
// Model Council job `delta-rereview-summary`).
//
// N2 shipped the DETERMINISTIC successor account: per staged ask addressed / partially /
// untouched, plus the paths the successor changed beyond the asks. This module is the
// optional light-tier LLM rephrasing of that account into one or two plain-English
// sentences, rendered ON TOP of the facts. The accountability guarantee stays intact
// because the prompt is built from ONLY the structured account — no diff, no repo
// content — so the model literally cannot introduce a fact the account does not carry.
//
// STRUCTURAL SIBLING of `draft-pr-body.ts`: a PURE router over an injected port. The
// port owns the ONE real model turn (the live seat is composed in apps/desktop,
// council-routed); this module stays node-free and unit-testable with a fake. The
// honesty floor it owns: a `drafted` verdict whose text is empty is NOT a digest — it
// is a `failed` turn, so the panel shows no headline (the facts are complete on their
// own) rather than a blank the reviewer reads as "nothing to see". A failed/unavailable
// turn never fabricates a digest. This producer posts NOTHING — it returns text into a
// panel (R33).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the injected port returns — the outcome of ONE real model turn. `emitted`
 * carries the model's text; `unavailable`/`failed` are the honest degradations. The
 * port NEVER fabricates a success. `model` is the model that ACTUALLY ran when the
 * port can observe it (else the caller falls back to the resolved model).
 */
export type DeltaDigestPortResult =
  | { readonly status: "emitted"; readonly text?: string; readonly model?: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * The digest port: takes the assembled prompt and runs one real turn. The caller owns
 * the harness wiring (the live Codex/Claude seat, or a fake in tests), so this module
 * never imports an adapter and stays pure.
 */
export type DeltaDigestPort = (prompt: string) => Promise<DeltaDigestPortResult>;

/**
 * The successor account as ONE file (design D4) — whole, uncapped, since a file is not
 * billed. The enumeration cap the prompt used to need is gone with the enumeration: a
 * hundred beyond-ask hunks cost the turn nothing now, and the digest can be honest about
 * a large delta instead of reading "…and 90 more".
 */
export function deltaDigestContextFile(account: SuccessorAccount): SessionContextFile {
  return {
    name: "digest-input.json",
    body: JSON.stringify(account),
    holds:
      "The deterministic successor account: each staged ask with its path, type, one-line summary and status, the paths changed beyond the asks, and (when present) those changes at hunk grain.",
    readWhen: "always — it is the only thing you may state as fact.",
  };
}

/**
 * Assemble the digest prompt. The grounding guarantee is unchanged and now structural:
 * the ONLY thing the turn may state is what `digest-input.json` holds, and that file is
 * the structured account — no diff, no file content — so the model can rephrase what the
 * account states and nothing else. The account is named by path, never interpolated.
 *
 * `contextDir` is the session's context directory AS THE WRITER RETURNED IT, never
 * re-derived from a review id here (review finding 1). One key for the write and for the
 * pointer, or the seat reads a directory the archive purge has never heard of.
 */
export function buildDeltaDigestPrompt(contextDir: string): string {
  const dir = contextDir;
  return [
    "You are writing a ONE- or TWO-SENTENCE plain-English summary of what a coding agent did to a code review's requests, for the reviewer to read at a glance.",
    "",
    `Read \`${dir}/digest-input.json\` — the review's own structured account of the turn:`,
    "each staged ask with its status (`partially-addressed` means the file changed but not",
    "the flagged spot), and what the agent changed beyond the asks.",
    "",
    "Rules, in order of importance:",
    "1. Use ONLY the facts in that file. Do NOT invent any file, change, or motivation that is not stated there. You are rephrasing a structured account, not analysing code.",
    "2. Say plainly what was addressed, what was left untouched, and — LOUDLY — anything changed beyond what was asked (the reviewer most needs to see scope-creep).",
    "3. One or two sentences. Plain prose, no markdown, no bullet list, no preamble like 'The agent…' is required but keep it natural. No trailing meta-commentary.",
    "",
    'Return JSON: {"digest":"<the one- or two-sentence summary>"}. The field is required and must be non-empty.',
  ].join("\n");
}

/**
 * Produce the delta digest from the account via the injected port. Pure and
 * deterministic given its port: assemble the prompt, run the one turn, map the
 * outcome, and enforce the honesty floor — a `drafted` result carries genuine
 * non-empty text, never an empty string dressed as a digest. A failed/unavailable
 * turn returns that state, and the panel shows the facts with no headline.
 */
export async function draftDeltaDigest(
  contextDir: string,
  port: DeltaDigestPort,
  model: string,
): Promise<DeltaDigestResult> {
  const turn = await port(buildDeltaDigestPrompt(contextDir));
  if (turn.status === "unavailable") return { status: "unavailable", reason: turn.reason };
  if (turn.status === "failed") return { status: "failed", reason: turn.reason };
  // Report the model that ACTUALLY ran when the port observed it; else the resolved
  // model — provenance records who wrote the digest, not the council's planned pick.
  const reportedModel = turn.model ?? model;
  const text = (turn.text ?? "").trim();
  // The honesty floor: an empty digest is not a digest — it is a failed turn, so the
  // panel keeps to the facts rather than a blank headline the reviewer skims past.
  if (text === "") return { status: "failed", reason: "the digest turn returned empty text" };
  return { status: "drafted", text, model: reportedModel };
}
