import type { DeltaAccount, DeltaAskStatus, DeltaDigestResult } from "@rennet/types";

export type { DeltaDigestResult };

// ─────────────────────────────────────────────────────────────────────────────
// review.deltaDigest — the light-tier prose over the delta account (#73 / M25,
// Model Council job `delta-rereview-summary`).
//
// N2 shipped the DETERMINISTIC delta account: per staged ask addressed / partially /
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

/** A stable, human phrasing of each ask status inside the prompt. */
const STATUS_PHRASE: Record<DeltaAskStatus, string> = {
  addressed: "addressed",
  "partially-addressed": "partially addressed (the file changed, but not the flagged spot)",
  untouched: "left untouched",
};

/**
 * Assemble the digest prompt from ONLY the structured account. This is the whole
 * grounding guarantee: the model sees the ask paths + statuses + summaries and the
 * beyond-asks paths, and nothing else — no diff, no file content — so it can only
 * rephrase what the account already states, never invent a change. The reviewer reads
 * the one-liner then the facts below it, so the prompt asks for a tight, honest gist.
 */
export function buildDeltaDigestPrompt(account: DeltaAccount): string {
  const lines: string[] = [
    "You are writing a ONE- or TWO-SENTENCE plain-English summary of what a coding agent did to a code review's requests, for the reviewer to read at a glance.",
    "",
    "Rules, in order of importance:",
    "1. Use ONLY the facts listed below. Do NOT invent any file, change, or motivation that is not stated here. You are rephrasing a structured account, not analysing code.",
    "2. Say plainly what was addressed, what was left untouched, and — LOUDLY — anything changed beyond what was asked (the reviewer most needs to see scope-creep).",
    "3. One or two sentences. Plain prose, no markdown, no bullet list, no preamble like 'The agent…' is required but keep it natural. No trailing meta-commentary.",
    "",
    "What the agent did to each request:",
  ];
  if (account.asks.length === 0) {
    lines.push("- (no staged requests)");
  } else {
    for (const ask of account.asks) {
      const summary = ask.summary.trim();
      lines.push(`- ${ask.path}: ${STATUS_PHRASE[ask.status]}${summary ? ` — "${summary}"` : ""}`);
    }
  }
  lines.push("", "Files the agent changed that NObody asked about (scope-creep):");
  if (account.beyondAsks.length === 0) {
    lines.push("- (none)");
  } else {
    for (const path of account.beyondAsks) lines.push(`- ${path}`);
  }
  lines.push(
    "",
    'Return JSON: {"digest":"<the one- or two-sentence summary>"}. The field is required and must be non-empty.',
  );
  return lines.join("\n");
}

/**
 * Produce the delta digest from the account via the injected port. Pure and
 * deterministic given its port: assemble the prompt, run the one turn, map the
 * outcome, and enforce the honesty floor — a `drafted` result carries genuine
 * non-empty text, never an empty string dressed as a digest. A failed/unavailable
 * turn returns that state, and the panel shows the facts with no headline.
 */
export async function draftDeltaDigest(
  account: DeltaAccount,
  port: DeltaDigestPort,
  model: string,
): Promise<DeltaDigestResult> {
  const turn = await port(buildDeltaDigestPrompt(account));
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
