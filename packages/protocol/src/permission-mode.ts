import { z } from "zod";

/**
 * Permission MODES, harness-style (issue #103, Rai ruling 2026-08-08).
 *
 * Instead of every gate carrying its own hardcoded consent prompt, Rennet has a
 * single permission MODE — like Claude Code / Codex harnesses — that governs
 * every gated action:
 *
 *   - `manual`  — ASK before a gated action runs (the safe default).
 *   - `auto`    — run gated actions without prompting (the action's OWN safety
 *                 gate, e.g. #21's degradation ledger, still applies).
 *   - `bypass`  — no gate at all (skip even the action's own safety gate).
 *
 * The mode is a workspace-level default, overridable per-run. This module is the
 * pure decision core: the type, the resolver (workspace default ← per-run
 * override), and the per-action gate resolution. It lives in `protocol` so BOTH
 * the renderer (`ui`, the #58 Canvases consumer) and the main process
 * (`core`/`adapters`/`app`, future #21 egress) reach the same contract — `ui`
 * cannot import `core`, but both may import `protocol`.
 */
export const PERMISSION_MODES = ["manual", "auto", "bypass"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * The safe default until the user opts up (Rai's lean: manual / ask-on-first-run).
 * Manual is the fail-safe: an unset, corrupt, or unrecognised mode resolves HERE,
 * never to `bypass` — defaulting toward "no gate" would be wrong-side.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "manual";

export const permissionModeSchema = z.enum(PERMISSION_MODES);

/**
 * The registry of gated actions the mode governs. Extensible: adding a member
 * (and, if it needs non-uniform policy, an `ACTION_POLICY` entry below) is the
 * whole extension surface for a new consumer.
 *
 *   - `harness.run`     — running the review harness / shipping the diff to a
 *                         model (issue #58, the FIRST consumer wired here).
 *   - `publish.egress`  — the outbound review post to GitHub (issue #21). Named
 *                         seam only: no live egress exists to gate yet.
 *   - `model.spend`     — any metered model spend. Named seam only.
 */
export const GATED_ACTIONS = ["harness.run", "publish.egress", "model.spend"] as const;
export type GatedAction = (typeof GATED_ACTIONS)[number];

/**
 * The three-way resolution of a gate under a mode:
 *   - `ask`    — require an explicit user act before the action runs.
 *   - `allow`  — run the action; its OWN safety gate (if any) still applies.
 *   - `bypass` — run the action with no gate at all, skipping even a safety gate.
 *
 * For a consumer with no separate safety gate (e.g. `harness.run`), `allow` and
 * `bypass` proceed identically. The distinction is load-bearing for a consumer
 * that carries its own gate (e.g. #21's degradation-ledger gate): `allow` keeps
 * that gate, `bypass` removes it.
 */
export type GateResolution = "ask" | "allow" | "bypass";

function modeGate(mode: PermissionMode): GateResolution {
  switch (mode) {
    case "manual":
      return "ask";
    case "auto":
      return "allow";
    case "bypass":
      return "bypass";
  }
}

/**
 * Per-action policy overrides. Empty today: every gated action is governed
 * uniformly by the mode. This is the ONLY place per-action policy lives — the
 * seam where a vital action (e.g. `publish.egress`, #21) can later refuse a
 * `bypass`, or force a ledger even under `auto`, without touching any consumer.
 */
const ACTION_POLICY: Partial<Record<GatedAction, (mode: PermissionMode) => GateResolution>> = {};

/** Resolve how `action` is gated under `mode` (mode-driven, per-action extensible). */
export function gateResolution(mode: PermissionMode, action: GatedAction): GateResolution {
  // Fail SAFE (Rule 75, wrong-side): a mode value that defeated the type at
  // runtime (a corrupt persisted string, a garbled per-run override, a future
  // consumer calling this with a raw value) resolves to the safe default before
  // gating. This is the SECOND, independent guard on the vital circuit —
  // `resolvePermissionMode` sanitises inputs, and this defends the gate for any
  // caller that reaches it directly. An unrecognised mode therefore ASKS; it can
  // never fall through to `allow`/`bypass`.
  const safe = permissionModeSchema.safeParse(mode);
  const resolved = safe.success ? safe.data : DEFAULT_PERMISSION_MODE;
  return (ACTION_POLICY[action] ?? modeGate)(resolved);
}

/** Whether `action` requires an explicit user act (consent) under `mode`. */
export function requiresConsent(mode: PermissionMode, action: GatedAction): boolean {
  return gateResolution(mode, action) === "ask";
}

/**
 * A layered mode selection: the persisted workspace default plus an optional
 * per-run override. `resolvePermissionMode` collapses it to the effective mode.
 */
export interface PermissionModeSelection {
  /** The persisted workspace-level default. Absent ⇒ {@link DEFAULT_PERMISSION_MODE}. */
  workspace?: PermissionMode;
  /** A per-run override that WINS over the workspace default when present. */
  run?: PermissionMode;
}

/**
 * The effective mode: per-run override ← workspace default ← the safe default.
 *
 * Fail SAFE (Rule 75, wrong-side): a layer that is ABSENT (`undefined`) simply
 * defers to the next, but a layer that is PRESENT yet unrecognised is corruption
 * — it resolves to {@link DEFAULT_PERMISSION_MODE} (`manual`) rather than passing
 * a garbled string downstream or silently falling through to a possibly-less-safe
 * lower layer. The returned value is ALWAYS a valid {@link PermissionMode}.
 */
export function resolvePermissionMode(selection: PermissionModeSelection): PermissionMode {
  for (const layer of [selection.run, selection.workspace]) {
    if (layer === undefined) continue;
    const parsed = permissionModeSchema.safeParse(layer);
    return parsed.success ? parsed.data : DEFAULT_PERMISSION_MODE;
  }
  return DEFAULT_PERMISSION_MODE;
}
