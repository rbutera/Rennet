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
 * hunk it names that was not offered is dropped. The test COUNT is grounded the same
 * way — derived from the distinct offered test FILES the model cited, never a free
 * scalar it could inflate. Two more honesty rules make the three chip states truthful:
 *
 *   1. The REQUIREMENTS are the authority, never the model. The runner iterates the
 *      change's real requirements and attaches the model's mapping to each — so the
 *      model can neither invent a requirement nor silently drop one. A requirement the
 *      model returned no mapping for (within a genuine set of mappings) is an honest
 *      computed ZERO (`unimplemented`).
 *   2. "Ran" and "did not run" never blur. A run is genuine only if at least one model
 *      mapping JOINS a real requirement; an empty `mappings` array, an all-malformed
 *      one, or one whose entries name no real requirement all reduce to ZERO usable
 *      mappings — the model said nothing about any requirement, so (like a budget
 *      refusal or a turn failure) the runner yields `failed` with an empty edge set,
 *      and the Spec view renders NO chips rather than a fabricated all-unimplemented.
 *      A genuine all-unimplemented (entries that DO join real requirements, with empty
 *      hunk lists) passes the gate and yields `ok`. Money circuit (#260): a turn over a
 *      configured ceiling is refused; an ABSENT budget runs ungated (no ceiling, not no spend).
 */

import type { InvocationBudget, OpenSpecCoverageEdge } from "@rennet/types";
import type { HarnessTurnResult } from "./harness-run-turn";
import { absentBudgetGrant } from "./invocation-budget";
import { classifyTestGlob } from "./novelty-ledger";

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
   * The shared live invocation budget (#260). Consulted before EVERY turn — a
   * turn over a CONFIGURED ceiling is refused; an ABSENT budget runs UNGATED (no
   * ceiling, not no spend). A refusal is terminal: the runner resolves to `failed`
   * (no chips), never a fabricated coverage. Optional only as a test ergonomic.
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
  /**
   * The offered hunk ids the model judges to be TESTS covering this requirement. The
   * count shown to the user is DERIVED from the grounded subset of these (distinct
   * test files) — never a free scalar the model could inflate past the offered set.
   */
  readonly testHunks: readonly string[];
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
    "which offered hunks are TESTS that exercise it.",
    "Return a mapping per requirement:",
    "  - `capability` and `requirement`: echo the requirement's identity EXACTLY.",
    "  - `hunks`: the ids of the offered hunks that implement it (an empty array when",
    "    the change does NOT implement it — an honest 'unimplemented', never a guess).",
    "  - `testHunks`: the ids of the offered hunks in TEST files that cover it (empty",
    "    when none). The test count shown is derived from these, so cite real ids only.",
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
    const testHunks = Array.isArray(candidate.testHunks)
      ? candidate.testHunks.filter((h): h is string => typeof h === "string")
      : [];
    items.push({
      capability: candidate.capability,
      requirement: candidate.requirement,
      hunks,
      testHunks,
    });
  }
  return items;
}

/**
 * The count of DISTINCT test FILES among the model's test-hunk ids, GROUNDED two ways:
 *   1. the id must be an OFFERED hunk (a ghost id the model invented is dropped), and
 *   2. its file must be a real TEST file by the deterministic convention classifier
 *      (`classifyTestGlob`) — so the model cannot inflate the count by citing an
 *      IMPLEMENTATION hunk as a test.
 * Multiple hunks in one test file count once. So the displayed "N tests" can never
 * exceed the real offered TEST surface — derived from grounded evidence, never a free
 * scalar the model could pad.
 */
function groundedTestCount(
  testHunkIds: readonly string[],
  hunkFileById: ReadonlyMap<string, string>,
): number {
  const files = new Set<string>();
  for (const id of testHunkIds) {
    const filePath = hunkFileById.get(id);
    if (filePath === undefined) continue; // not offered — a hallucinated id
    if (classifyTestGlob(filePath) === null) continue; // not a test file — impl inflation
    files.add(filePath);
  }
  return files.size;
}

/**
 * Ground the model's mappings against the REAL requirements + offered hunks. Every
 * requirement gets exactly one edge: the model's mapping for it (hunks culled to the
 * offered set and shaped into `rennet:hunk/<id>` anchors, deduped, in offered order;
 * the test count derived from the grounded test-hunk files), or an honest zero when
 * the model returned none for it.
 */
function groundEdges(
  requirements: readonly CoverageRequirementInput[],
  hunkFileById: ReadonlyMap<string, string>,
  raw: readonly RawMappingItem[],
): OpenSpecCoverageEdge[] {
  const byKey = new Map<string, RawMappingItem>();
  for (const item of raw) byKey.set(joinKey(item.capability, item.requirement), item);

  return requirements.map((requirement) => {
    const mapping = byKey.get(joinKey(requirement.capability, requirement.name));
    const seen = new Set<string>();
    const hunks: string[] = [];
    for (const id of mapping?.hunks ?? []) {
      if (!hunkFileById.has(id) || seen.has(id)) continue;
      seen.add(id);
      hunks.push(`rennet:hunk/${id}`);
    }
    return {
      capability: requirement.capability,
      requirement: requirement.name,
      hunks,
      tests: mapping ? groundedTestCount(mapping.testHunks, hunkFileById) : 0,
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
  const hunkFileById = new Map(input.hunks.map((hunk) => [hunk.id, hunk.filePath] as const));
  // The authoritative requirement identities: a model mapping is "usable" only if it
  // joins one of these. Zero usable mappings ⇒ the model told us nothing about any
  // real requirement (an empty array, all-malformed, or all-unknown identities).
  const authoritativeKeys = new Set(
    input.requirements.map((requirement) => joinKey(requirement.capability, requirement.name)),
  );
  const prompt = renderPrompt(input);
  let lastFailure = "the coverage mapping runner did not complete";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // Money circuit (#260): a turn over a configured ceiling is refused; an
    // absent budget runs ungated (no budget means no ceiling, not no spend).
    const purpose = `coverage:attempt-${attempt}`;
    const grant = input.budget?.tryConsume(purpose) ?? absentBudgetGrant(purpose);
    if (!grant.granted) {
      return { status: "failed", edges: [], failureReason: grant.reason };
    }

    const turn = await input.runTurn(prompt, attempt);
    if (turn.status === "failed") {
      lastFailure = turn.message;
      continue;
    }

    const mappings = readMappings(turn.body);
    // A run is genuine only if at least one mapping JOINS a real requirement. An empty
    // `mappings` array, an all-malformed one, or one whose entries name no real
    // requirement all reduce to zero usable mappings — the model said nothing about
    // any requirement, indistinguishable from a refusal, so it must NOT paint a
    // confident all-unimplemented. Retry, then fail (no chips). A GENUINE
    // all-unimplemented comes from entries that DO join real requirements with empty
    // hunk lists — those pass this gate and yield `ok`.
    const usable = mappings?.filter((mapping) =>
      authoritativeKeys.has(joinKey(mapping.capability, mapping.requirement)),
    );
    if (!usable || usable.length === 0) {
      lastFailure = "the coverage turn returned no mapping for any requirement";
      continue;
    }

    return { status: "ok", edges: groundEdges(input.requirements, hunkFileById, usable) };
  }

  return { status: "failed", edges: [], failureReason: lastFailure };
}
