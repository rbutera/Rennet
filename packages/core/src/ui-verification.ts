import type { FindingElement, PatchFile, UiVerification } from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// The deterministic UI-surface classifier (#464 survivor, B2).
//
// The model-backed verify-ui pass (`runUiVerification` — the mount-and-screenshot
// turn) died with the Board rebuild (#489): the Board (B-series) owns the live
// verify surface. What survives is the DETERMINISTIC, $0, versioned classifier that
// decides whether a changeset touches UI at all — read live by the flagged review
// path to record the honest immediate `not-ui` / `pending` / `verifier-unavailable`
// status. No model anywhere in this file.
// ─────────────────────────────────────────────────────────────────────────────

/** Bumped when the classifier's rule set changes (A/B-able against verify quality). */
export const UI_SURFACE_CLASSIFIER_VERSION = 2;

/** Extensions that are UI surface regardless of where they live. */
const UI_SURFACE_EXTENSIONS: readonly string[] = [
  ".tsx",
  ".jsx",
  ".vue",
  ".svelte",
  ".html",
  ".css",
  ".scss",
  ".less",
];

/** A `.ts`/`.js` file counts as UI only under one of these path segments.
 * `ui` is the vendored kit (packages/ui); `app-ui` is Rennet's composites
 * (packages/app-ui, renamed from packages/ui) — both are UI surface. */
const UI_PATH_SEGMENTS: readonly string[] = ["renderer", "components", "ui", "app-ui"];
const AMBIGUOUS_SCRIPT_EXTENSIONS: readonly string[] = [".ts", ".js"];

function lowerExtension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot).toLowerCase();
}

function hasUiPathSegment(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  return segments.some((segment) => UI_PATH_SEGMENTS.includes(segment));
}

/** True when a single path is a UI-surface file under the versioned rule set. */
export function isUiSurfacePath(path: string): boolean {
  const extension = lowerExtension(path);
  // A `.d.ts` is a declaration, never a rendered surface — exclude before the .ts rule.
  if (path.toLowerCase().endsWith(".d.ts")) return false;
  if (UI_SURFACE_EXTENSIONS.includes(extension)) return true;
  if (AMBIGUOUS_SCRIPT_EXTENSIONS.includes(extension)) return hasUiPathSegment(path);
  return false;
}

export interface UiSurfaceClassification {
  readonly version: number;
  readonly touchesUi: boolean;
  /** The changed files the classifier judged UI surface (in input order). */
  readonly files: readonly string[];
}

/**
 * Decide whether a changeset touches UI. Deterministic, versioned, no model turn
 * (§spec). Extensions `.tsx .jsx .vue .svelte .html .css .scss .less` are UI wherever
 * they live; a `.ts`/`.js` file is UI only under a `renderer/`, `components/`,
 * `ui/`, or `app-ui/` path segment (a `.d.ts` is never a rendered surface). No UI file ⇒
 * `touchesUi: false`, and the caller records `not-ui` — a distinct status, not a
 * failure and not an all-clear.
 */
export function classifyUiSurface(
  files: readonly Pick<PatchFile, "path">[],
): UiSurfaceClassification {
  const uiFiles = files.map((file) => file.path).filter(isUiSurfacePath);
  return { version: UI_SURFACE_CLASSIFIER_VERSION, touchesUi: uiFiles.length > 0, files: uiFiles };
}

/**
 * The verify-ui result the flagged review path applies. The model turn that once
 * produced non-empty observations is gone (B2); the deterministic immediate path
 * still constructs this shape with an honest `not-ui` / `pending` / `unavailable`
 * status and no observations.
 */
export interface RunUiVerificationResult {
  /** The observations to surface as ordinary findings (empty on any non-`ran` status). */
  readonly observations: FindingElement[];
  /** The additive status that rides the review. */
  readonly status: UiVerification;
}
