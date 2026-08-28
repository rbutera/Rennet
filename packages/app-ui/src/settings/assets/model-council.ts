import type { ReviewRole } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// The Model Council presentation catalogue (C10 §5.3–5.4, claims 622–625). Two
// things the mappings dialog needs that are NOT per-host detection: the models a
// picker may offer per provider, and the council's per-role DEFAULTS (the values
// "Reset to default" restores and "changed from default" compares against).
//
// Ported verbatim from the spike's `lib/settings-data.ts` so the table reads
// exactly as the visual truth does. These are the Model Council's job catalogue
// (#460/#464, `packages/core/src/model-council.ts`) rendered for the surface —
// app-ui cannot import `core`, so the presentation copy lives here. When B10 lands
// the council serves detected models + the live defaults through the settings
// projection (reconciliation 5); until then this catalogue is the honest reference.
// ─────────────────────────────────────────────────────────────────────────────

/** The council's model set — bare ids, exactly as the mappings tables use them. */
export const CLAUDE_MODELS = ["haiku", "sonnet-5", "opus-4.8"] as const;
export const CODEX_MODELS = ["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"] as const;

/**
 * The council's per-role defaults across the three availability scenarios (Dual /
 * Claude-only / Codex-only). `null` means the role does not run in that scenario —
 * the surface renders an em dash, never a fabricated assignment (claim 624). Roles
 * cover the #460/#464 catalogue: Orchestrator, Context-Map Workers, Confirmation
 * Worker, Lens Drafters, Flagged Second Seat, Adjudication, Post-Process, Utility.
 */
export const REVIEW_ROLE_DEFAULTS: readonly ReviewRole[] = [
  {
    id: "orchestrator",
    label: "Orchestrator",
    hint: "The review seat — decomposition, the living draft, and chat.",
    dual: { model: "opus-4.8", effort: "high" },
    claudeOnly: { model: "opus-4.8", effort: "high" },
    codexOnly: { model: "gpt-5.6-sol", effort: "high" },
  },
  {
    id: "map-workers",
    label: "Context-Map Workers",
    hint: "Cheap partition workers, one per scope of the structural map.",
    dual: { model: "gpt-5.6-luna", effort: "low" },
    claudeOnly: { model: "haiku", effort: "low" },
    codexOnly: { model: "gpt-5.6-luna", effort: "low" },
  },
  {
    id: "confirmation",
    label: "Confirmation Worker",
    hint: "The verify/synthesis seat — re-reads cited evidence, settles hypotheses.",
    dual: { model: "sonnet-5", effort: "medium" },
    claudeOnly: { model: "sonnet-5", effort: "medium" },
    codexOnly: { model: "gpt-5.6-terra", effort: "medium" },
  },
  {
    id: "lens-workers",
    label: "Lens Drafters",
    hint: "One drafting agent per lens — Design, Sequence, Decisions, Flagged, Noise.",
    dual: { model: "opus-4.8", effort: "high" },
    claudeOnly: { model: "opus-4.8", effort: "high" },
    codexOnly: { model: "gpt-5.6-sol", effort: "high" },
  },
  {
    id: "second-seat",
    label: "Flagged Second Seat",
    hint: "The independent second opinion on Flagged — reconciled, never merged.",
    dual: { model: "gpt-5.6-sol", effort: "high" },
    claudeOnly: null,
    codexOnly: null,
  },
  {
    id: "adjudication",
    label: "Adjudication",
    hint: "One fresh-session turn per disagreement, capped per review.",
    dual: { model: "opus-4.8", effort: "high" },
    claudeOnly: { model: "opus-4.8", effort: "high" },
    codexOnly: { model: "gpt-5.6-sol", effort: "high" },
  },
  {
    id: "post-process",
    label: "Post-Process Pass",
    hint: "The editor pass every draft board takes before it shows.",
    dual: { model: "gpt-5.6-terra", effort: "medium" },
    claudeOnly: { model: "sonnet-5", effort: "medium" },
    codexOnly: { model: "gpt-5.6-terra", effort: "medium" },
  },
  {
    id: "utility",
    label: "Utility",
    hint: "The light tier — titles, narration, dedupe, everything with enumerable input.",
    dual: { model: "gpt-5.6-luna", effort: "low" },
    claudeOnly: { model: "haiku", effort: "low" },
    codexOnly: { model: "gpt-5.6-luna", effort: "low" },
  },
];

// `defaultAssignment` / `isRoleDefault` are GONE (C16, #485). Both compared a served
// role against this copied table to answer "is this a default?"; the wire now carries
// each cell's own `layer` provenance, so the surface reads the answer instead of
// re-deriving it — and Reset clears the override (`null`) rather than writing a copy
// of the table back.
