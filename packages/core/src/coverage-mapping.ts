/**
 * The requirement→hunk COVERAGE MAPPING producer (Rai, wireframes #9 / R53).
 *
 * The Spec view shows, per requirement, "covered by N hunks · M tests" (a jump to
 * the claiming hunk) or an honest "unimplemented". That mapping is a MODEL JUDGEMENT
 * — a requirement is prose, a hunk is a file change, and only reading both together
 * says which implements which — so this is a real review-intelligence turn, sibling
 * to the finding runner (#32) and the per-finding verification (#179).
 *
 * Coverage is a DERIVED, display-time signal, NOT a stored RSP document, so (like
 * verification) it does not mint an RSP envelope or run the RSP validator. Instead it
 * takes the SAME anti-hallucination discipline the finding runner applies with
 * `cullFindings`: the model's output is GROUNDED against the offered hunk set, and any
 * hunk it names that was not offered is dropped. Two more honesty rules make the three
 * chip states truthful:
 *
 *   1. The REQUIREMENTS are the authority, never the model. The runner iterates the
 *      change's real requirements and attaches the model's mapping to each — so the
 *      model can neither invent a requirement nor silently drop one. A requirement the
 *      model returned no mapping for (within a real mappings array) is an honest
 *      computed ZERO (`unimplemented`).
 *   2. "Ran" and "did not run" never blur. A completed turn whose body carries a real
 *      `mappings` array yields `ok` (every requirement covered-or-zero). A budget
 *      refusal, a turn failure, or a body with NO usable mappings array yields
 *      `failed` with an empty edge set — so the Spec view renders NO chips rather than
 *      a fabricated all-unimplemented, keeping "not computed" distinct from a real
 *      zero. Fail-closed on the money circuit (Rule 75): an ABSENT budget is a refusal.
 */

import type { InvocationBudget, OpenSpecCoverageEdge } from "@rennet/types";
import type { HarnessTurnResult } from "./harness-run-turn";
import { budgetAbsentRefusal } from "./invocation-budget";

/** One requirement the mapping is produced for (the AUTHORITY the runner iterates). */
export interface CoverageRequirementInput {
  readonly capability: string;
  readonly name: string;
  readonly statement: string;
  /** The requirement's scenario names — extra signal for the model, never required. */
  readonly scenarios: readonly string[];
}

/** One offered hunk the model may cite, with the file + lines that carry the signal. */
export interface CoverageHunkInput {
  readonly id: string;
  readonly filePath: string;
  readonly addedLines: readonly string[];
  readonly deletedLines: readonly string[];
}

export interface RunCoverageMappingInput {
  /** The patchset the offered hunks belong to (echoed into the prompt for the model). */
  readonly patchsetId: string;
  /** The change's requirements — the authority the runner iterates and completes. */
  readonly requirements: readonly CoverageRequirementInput[];
  /** The offered hunks the model may map to; grounding keeps only these ids. */
  readonly hunks: readonly CoverageHunkInput[];
  /** Runs one turn against the assembled prompt; the caller owns the session wiring. */
  readonly runTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>;
  /**
   * The shared live invocation budget (Rule 75, vital money circuit). Consulted
   * before EVERY turn — a turn over the ceiling, or an ABSENT budget, is refused
   * fail-closed. A refusal is terminal: the runner resolves to `failed` (no chips),
   * never a fabricated coverage. Optional only as a test ergonomic.
   */
  readonly budget?: InvocationBudget;
  /** Retries after the first attempt. Default 1 (two attempts total). */
  readonly maxRetries?: number;
}

export interface RunCoverageMappingResult {
  /** `ok` — the mapping ran (every requirement has an edge). `failed` — it did not. */
  readonly status: "ok" | "failed";
  /** One edge per requirement on `ok`; empty on `failed`. */
  readonly edges: OpenSpecCoverageEdge[];
  /** The reason for a `failed` status, for logging (never surfaced as a fake edge). */
  readonly failureReason?: string;
}

/** The model's per-requirement mapping item, before grounding. */
interface RawMappingItem {
  readonly capability: string;
  readonly requirement: string;
  readonly hunks: readonly string[];
  readonly tests: number;
}

/** A stable join key for a (capability, requirement) pair, matching the model echo. */
function joinKey(capability: string, requirement: string): string {
  return `${capability}\u0000${requirement}`;
}

/** A compact, model-facing serialisation of the requirements being mapped. */
function renderRequirements(requirements: readonly CoverageRequirementInput[]): string {
  return JSON.stringify(
    {
      requirements: requirements.map((requirement) => ({
        capability: requirement.capability,
        requirement: requirement.name,
        statement: requirement.statement,
        scenarios: requirement.scenarios,
      })),
    },
    null,
    2,
  );
}

/** A compact, model-facing serialisation of the offered hunks (id + file + lines). */
function renderHunks(hunks: readonly CoverageHunkInput[]): string {
  return JSON.stringify(
    {
      hunks: hunks.map((hunk) => ({
        id: hunk.id,
        filePath: hunk.filePath,
        addedLines: hunk.addedLines,
        deletedLines: hunk.deletedLines,
      })),
    },
    null,
    2,
  );
}

/** The prompt: map each requirement to the offered hunks that implement it + a test count. */
function renderPrompt(input: RunCoverageMappingInput): string {
  return [
    "You are mapping OpenSpec requirements to the code changes that implement them.",
    "",
    "For EACH requirement below, decide which of the offered hunks implement it and",
    "how many of those hunks are TEST files (a test that exercises the requirement).",
    "Return a mapping per requirement:",
    "  - `capability` and `requirement`: echo the requirement's identity EXACTLY.",
    "  - `hunks`: the ids of the offered hunks that implement it (an empty array when",
    "    the change does NOT implement it — an honest 'unimplemented', never a guess).",
    "  - `tests`: how many DISTINCT test files among those hunks cover it (0 when none).",
    "Only cite hunk ids from the offered set. Do not invent hunks or requirements.",
    "",
    `patchsetId: ${input.patchsetId}`,
    "",
    "REQUIREMENTS:",
    renderRequirements(input.requirements),
    "",
    "OFFERED HUNKS:",
    renderHunks(input.hunks),
  ].join("\n");
}

/** Parse the emitted body's `mappings` array defensively; null when it is not one. */
function readMappings(body: unknown): RawMappingItem[] | null {
  if (typeof body !== "object" || body === null) return null;
  const mappings = (body as { mappings?: unknown }).mappings;
  if (!Array.isArray(mappings)) return null;
  const items: RawMappingItem[] = [];
  for (const raw of mappings) {
    if (typeof raw !== "object" || raw === null) continue;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.capability !== "string" || typeof candidate.requirement !== "string") {
      continue;
    }
    const hunks = Array.isArray(candidate.hunks)
      ? candidate.hunks.filter((h): h is string => typeof h === "string")
      : [];
    const tests = typeof candidate.tests === "number" ? candidate.tests : 0;
    items.push({
      capability: candidate.capability,
      requirement: candidate.requirement,
      hunks,
      tests,
    });
  }
  return items;
}

/** A non-negative integer test count from a possibly-fractional/negative model value. */
function safeTestCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * Ground the model's mappings against the REAL requirements + offered hunks. Every
 * requirement gets exactly one edge: the model's mapping for it (hunks culled to the
 * offered set and shaped into `rennet:hunk/<id>` anchors, deduped, in offered order),
 * or an honest zero when the model returned none for it.
 */
function groundEdges(
  requirements: readonly CoverageRequirementInput[],
  offeredHunkIds: ReadonlySet<string>,
  raw: readonly RawMappingItem[],
): OpenSpecCoverageEdge[] {
  const byKey = new Map<string, RawMappingItem>();
  for (const item of raw) byKey.set(joinKey(item.capability, item.requirement), item);

  return requirements.map((requirement) => {
    const mapping = byKey.get(joinKey(requirement.capability, requirement.name));
    const seen = new Set<string>();
    const hunks: string[] = [];
    for (const id of mapping?.hunks ?? []) {
      if (!offeredHunkIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      hunks.push(`rennet:hunk/${id}`);
    }
    return {
      capability: requirement.capability,
      requirement: requirement.name,
      hunks,
      tests: mapping ? safeTestCount(mapping.tests) : 0,
    };
  });
}

/**
 * Produce the requirement→hunk coverage for a change. Runs one budget-gated model
 * turn (retried on a turn failure or a body with no usable mappings), grounds the
 * result against the offered hunks, and completes it against the real requirements —
 * so a completed run yields an edge per requirement (covered or an honest zero) and a
 * failed run yields an empty set (the Spec view then shows NO chips). A pure function
 * of its injected turn + budget.
 */
export async function runCoverageMapping(
  input: RunCoverageMappingInput,
): Promise<RunCoverageMappingResult> {
  // Nothing to map is not a failure: an `ok` empty set (no requirements, no chips).
  if (input.requirements.length === 0) return { status: "ok", edges: [] };

  const maxRetries = input.maxRetries ?? 1;
  const offeredHunkIds = new Set(input.hunks.map((hunk) => hunk.id));
  const prompt = renderPrompt(input);
  let lastFailure = "the coverage mapping runner did not complete";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // Fail-closed money circuit (Rule 75): an absent budget is a refusal, terminal.
    const purpose = `coverage:attempt-${attempt}`;
    const grant = input.budget?.tryConsume(purpose) ?? budgetAbsentRefusal(purpose);
    if (!grant.granted) {
      return { status: "failed", edges: [], failureReason: grant.reason };
    }

    const turn = await input.runTurn(prompt, attempt);
    if (turn.status === "failed") {
      lastFailure = turn.message;
      continue;
    }

    const mappings = readMappings(turn.body);
    if (mappings === null) {
      // Completed, but no usable mappings array: NOT an all-unimplemented result —
      // retry, then fail (a garbled body never masquerades as a set of real zeros).
      lastFailure = "the coverage turn returned no usable mappings";
      continue;
    }

    return { status: "ok", edges: groundEdges(input.requirements, offeredHunkIds, mappings) };
  }

  return { status: "failed", edges: [], failureReason: lastFailure };
}
