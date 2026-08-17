/**
 * verify-ui (issue #183) — the fourth verse of the review-intelligence song
 * (hypothesis #178, dual-model #41, per-finding verification #179): the pass that
 * MOUNTS a UI-touching change and looks at the pixels, so a changeset that breaks
 * layout, contradicts its stated design intent, or ships an inaccessible control no
 * longer sails through every text-reading lens.
 *
 * Two pure, node-free pieces live here; the model I/O (the fresh capable turn that
 * renders and screenshots) and the file/evidence I/O are INJECTED, so this module
 * stays testable with a mock and preserves the dependency arrows (deterministic gate
 * + pure logic in `core`; the harness turn in `adapters`).
 *
 *   ① classifyUiSurface — a deterministic, versioned gate: does the changeset touch
 *      any UI-surface file at all? Zero model spend, decided by file path + extension
 *      exactly like `classifyNonObvious`. No UI file ⇒ `not-ui`, no turn, no noise.
 *   ② runUiVerification — ONE budget-bounded turn per review (deep tier only) opens a
 *      fresh capable session and mounts the change with whatever the project affords,
 *      captures screenshots into the review's evidence directory, runs an a11y check,
 *      and compares against the review's captured design intent. Its observations
 *      become ordinary anchored `FindingElement`s (severity from impact, an evidence
 *      chip); its status rides the review as an additive `UiVerification`.
 *
 * The DISPOSITION is honest and asymmetric (Rule 75/81ak, could-not-check beats a
 * false clear): a turn that mounted returns `ran` with its screenshots; a turn that
 * could NOT mount returns `unavailable` with what it attempted — the inconclusive
 * could-not-mount disclosure, NEVER "no UI problems found". An observation is chipped
 * `reproduced` only when the turn actually EXECUTED something to mount it (issue #259
 * exec observation); a static-review observation is `inconclusive`. Nothing here feeds
 * any gate (Rule Zero): the status and the findings are informational.
 */

import {
  type UiVerificationContract,
  UI_VERIFICATION_CONTRACT,
  type UiVerificationPromptFile,
  renderUiVerificationPrompt,
} from "@rennet/instructions";
import type {
  BudgetGrant,
  FindingElement,
  FindingSeverity,
  Hunk,
  InvocationBudget,
  PatchFile,
  ReviewIntent,
  UiScreenshot,
  UiVerification,
} from "@rennet/types";
import { absentBudgetGrant } from "./invocation-budget";
import type { VerificationTurn } from "./finding-verification";

// ── ① The deterministic UI-surface classifier ────────────────────────────────

/** Bumped when the classifier's rule set changes (A/B-able against verify quality). */
export const UI_SURFACE_CLASSIFIER_VERSION = 1;

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

/** A `.ts`/`.js` file counts as UI only under one of these path segments. */
const UI_PATH_SEGMENTS: readonly string[] = ["renderer", "components", "ui"];
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
 * they live; a `.ts`/`.js` file is UI only under a `renderer/`, `components/`, or
 * `ui/` path segment (a `.d.ts` is never a rendered surface). No UI file ⇒
 * `touchesUi: false`, and the caller records `not-ui` — a distinct status, not a
 * failure and not an all-clear.
 */
export function classifyUiSurface(
  files: readonly Pick<PatchFile, "path">[],
): UiSurfaceClassification {
  const uiFiles = files.map((file) => file.path).filter(isUiSurfacePath);
  return { version: UI_SURFACE_CLASSIFIER_VERSION, touchesUi: uiFiles.length > 0, files: uiFiles };
}

// ── ② The verify-ui pass ──────────────────────────────────────────────────────

const SEVERITY_BY_IMPACT: Record<string, FindingSeverity> = {
  high: "high",
  medium: "medium",
  low: "low",
};

/** The honest could-not-mount / no-verifier reasons (never a fabricated clear). */
const VERIFIER_UNAVAILABLE_REASON = "no verifier was available to mount the UI change";
const BUDGET_REASON = "the review's invocation budget was exhausted before verify-ui could run";
const NO_RESULT_REASON = "the verify-ui turn returned no usable result";
const STATIC_EVIDENCE_FALLBACK =
  "Observed in a static review of the changed markup — not mounted, so treat as inconclusive.";

export interface RunUiVerificationInput {
  /** The changeset's files — the classifier gate reads their paths. */
  readonly files: readonly PatchFile[];
  /** The decomposition hunks — used to anchor each observation to a changed file's hunk. */
  readonly hunks: readonly Hunk[];
  /** The review's captured design intent (PR title/body + spec); absent degrades honestly. */
  readonly intent?: ReviewIntent;
  /** The ABSOLUTE evidence directory the turn writes PNGs into; screenshots are stored relative to it. */
  readonly evidenceDir: string;
  /**
   * The fresh-session verify-ui turn (adapters). ABSENT ⇒ no verifier is available
   * and the status is `unavailable` with that reason (mirrors deep review with no
   * Claude adapter) — never a fabricated clear.
   */
  readonly runTurn?: VerificationTurn;
  /**
   * The shared live invocation budget. Consulted before the ONE turn — a refusal
   * records `unavailable` naming the budget (the pass never silently skips). Optional
   * only as a test ergonomic (absent ⇒ the turn runs ungated, no ceiling).
   */
  readonly budget?: InvocationBudget;
  /** Max verify-ui turns per review; the frozen default is 1. A value < 1 disables the turn. */
  readonly maxTurns?: number;
  readonly contract?: UiVerificationContract;
  /** Deterministic finding-id minter (tests); defaults to a stable per-observation id. */
  readonly mintFindingId?: (index: number) => string;
}

export interface RunUiVerificationResult {
  /** The observations to surface as ordinary findings (empty on any non-`ran` status). */
  readonly observations: FindingElement[];
  /** The additive status that rides the review. */
  readonly status: UiVerification;
}

interface ParsedTurnBody {
  readonly mounted: boolean;
  readonly screenshots: UiScreenshot[];
  readonly observations: ParsedObservation[];
}

interface ParsedObservation {
  readonly file: string;
  readonly line?: number;
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly evidence: string;
}

/**
 * Run the verify-ui pass. Pure orchestration: classify → config-absent → budget →
 * one turn → dispose. Never throws on a turn failure — a dead/failed/malformed turn
 * becomes the honest `unavailable` disclosure, so a broken verifier can never read
 * as an all-clear. Observations become anchored `FindingElement`s; the status is
 * separate and additive.
 */
export async function runUiVerification(
  input: RunUiVerificationInput,
): Promise<RunUiVerificationResult> {
  // 1. The deterministic gate — zero spend. No UI file ⇒ not-ui, done.
  const classification = classifyUiSurface(input.files);
  if (!classification.touchesUi) {
    return { observations: [], status: { status: "not-ui" } };
  }

  // 2. No verifier injected, or the turn is disabled — the honest could-not-run.
  const maxTurns = normalizeTurns(input.maxTurns);
  if (input.runTurn === undefined || maxTurns < 1) {
    return unavailable(VERIFIER_UNAVAILABLE_REASON);
  }

  // 3. The one budget-gated turn. A refusal is disclosed, never silently skipped.
  const grant: BudgetGrant = input.budget?.tryConsume("ui-verification") ?? absentBudgetGrant("ui-verification");
  if (!grant.granted) {
    return unavailable(BUDGET_REASON);
  }

  const contract = input.contract ?? UI_VERIFICATION_CONTRACT;
  const prompt = renderUiVerificationPrompt(contract, {
    files: promptFiles(classification.files, input.hunks),
    designIntent: designIntentText(input.intent),
    evidenceDir: input.evidenceDir,
  });

  const turn = await runTurnSafely(input.runTurn, prompt);
  if (turn.status === "failed") {
    return unavailable(couldNotMount(turn.message));
  }

  const parsed = parseTurnBody(turn.body);
  if (parsed === undefined) {
    return unavailable(NO_RESULT_REASON);
  }

  // The turn EXECUTED something to mount (issue #259 exec observation): a mounted,
  // execution-backed observation is `reproduced`; a static one is `inconclusive`.
  const executionBacked = (turn.execution?.commands.length ?? 0) > 0;
  const grounded = parsed.mounted && executionBacked;
  const anchorForFile = buildFileAnchors(input.hunks);
  const mintId = input.mintFindingId ?? ((index) => `ui-verify:${index + 1}`);

  const observations: FindingElement[] = parsed.observations.map((observation, index) => ({
    findingId: mintId(index),
    anchor: anchorForFile(observation.file),
    summary: observation.summary,
    severity: observation.severity,
    agreement: { kind: "concur", agree: 1, total: 1 },
    verification: {
      verdict: grounded ? "reproduced" : "inconclusive",
      evidence:
        observation.evidence.trim().length > 0
          ? observation.evidence.trim()
          : STATIC_EVIDENCE_FALLBACK,
    },
  }));

  return {
    observations,
    status: {
      status: "ran",
      screenshots: parsed.screenshots,
      observationCount: observations.length,
      mounted: grounded,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function unavailable(reason: string): RunUiVerificationResult {
  return { observations: [], status: { status: "unavailable", reason } };
}

function couldNotMount(why: string): string {
  return `could not mount the UI change: ${why}`;
}

/** Normalize the turn cap, fail-closed on a bad value (Rule 75): NaN/Infinity ⇒ 0 (no turn). */
function normalizeTurns(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/** Run the turn, coercing a thrown turn to a failure (an honest unavailable, never a crash). */
async function runTurnSafely(
  runTurn: VerificationTurn,
  prompt: string,
): ReturnType<VerificationTurn> {
  try {
    return await runTurn(prompt);
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Build the per-file prompt payload: the changed UI files with a bounded hunk excerpt. */
function promptFiles(
  files: readonly string[],
  hunks: readonly Hunk[],
): readonly UiVerificationPromptFile[] {
  const byFile = new Map<string, string[]>();
  for (const hunk of hunks) {
    if (!byFile.has(hunk.filePath)) byFile.set(hunk.filePath, []);
    const lines = byFile.get(hunk.filePath);
    if (lines === undefined) continue;
    for (const line of hunk.deletedLines) lines.push(`- ${line}`);
    for (const line of hunk.addedLines) lines.push(`+ ${line}`);
  }
  return files.map((path) => ({
    path,
    // Bound the excerpt so one large file cannot blow the prompt.
    hunk: (byFile.get(path) ?? []).slice(0, 200).join("\n"),
  }));
}

/** Render the review's captured intent as the design-intent text; nothing new is ingested. */
function designIntentText(intent: ReviewIntent | undefined): string {
  if (intent === undefined) return "";
  const parts: string[] = [];
  if (intent.prTitle && intent.prTitle.trim().length > 0) parts.push(`Title: ${intent.prTitle}`);
  if (intent.prBody && intent.prBody.trim().length > 0) parts.push(`Description:\n${intent.prBody}`);
  if (intent.spec && intent.spec.trim().length > 0) parts.push(`Spec:\n${intent.spec}`);
  return parts.join("\n\n");
}

/**
 * Map each changed file to a jump anchor (issue #183): the first hunk in that file,
 * `rennet:hunk/<id>`, so the row jumps to the changed code. A file with no hunk (a
 * rename with no body, say) falls back to a plain `rennet:file/<path>` anchor — it
 * still renders and identifies the file, it just does not jump. Anchoring is Rennet's
 * job, not the model's, so the turn only ever names a file.
 */
function buildFileAnchors(hunks: readonly Hunk[]): (file: string) => string {
  const firstHunkByFile = new Map<string, string>();
  for (const hunk of hunks) {
    if (!firstHunkByFile.has(hunk.filePath)) firstHunkByFile.set(hunk.filePath, hunk.id);
  }
  return (file) => {
    const hunkId = firstHunkByFile.get(file);
    return hunkId !== undefined ? `rennet:hunk/${hunkId}` : `rennet:file/${file}`;
  };
}

/**
 * Parse the verify-ui turn's emitted body defensively. A garbled/empty emission
 * returns `undefined`, so the pass falls to the honest `unavailable` disclosure
 * rather than fabricating a clear. Only well-formed observations survive.
 */
function parseTurnBody(body: unknown): ParsedTurnBody | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const mounted = record.mounted === true;
  const screenshots = parseScreenshots(record.screenshots);
  const observations = parseObservations(record.observations);
  // A body with neither a mount claim, a screenshot, nor an observation is not usable.
  if (!mounted && screenshots.length === 0 && observations.length === 0) return undefined;
  return { mounted, screenshots, observations };
}

function parseScreenshots(value: unknown): UiScreenshot[] {
  if (!Array.isArray(value)) return [];
  const screenshots: UiScreenshot[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || record.path.length === 0) continue;
    screenshots.push({ path: record.path, label: typeof record.label === "string" ? record.label : "" });
  }
  return screenshots;
}

function parseObservations(value: unknown): ParsedObservation[] {
  if (!Array.isArray(value)) return [];
  const observations: ParsedObservation[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.file !== "string" || record.file.length === 0) continue;
    if (typeof record.summary !== "string" || record.summary.length === 0) continue;
    const severity = SEVERITY_BY_IMPACT[String(record.impact)];
    if (severity === undefined) continue;
    observations.push({
      file: record.file,
      ...(typeof record.line === "number" && Number.isFinite(record.line)
        ? { line: record.line }
        : {}),
      severity,
      summary: record.summary,
      evidence: typeof record.evidence === "string" ? record.evidence : "",
    });
  }
  return observations;
}
