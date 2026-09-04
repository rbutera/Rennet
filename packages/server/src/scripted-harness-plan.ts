import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { T3SeatSeam, T3SettledTurn } from "@rennet/adapters";
import {
  buildCapabilities,
  type CodexExecutor,
  type HarnessEvent,
  type HarnessPort,
  type HarnessSession,
  type SessionOutcome,
  type SessionSpec,
  type TurnId,
  type TurnInput,
} from "@rennet/core";
import { z } from "zod";
import type { T3SeatRuntime } from "./runtime/rounds";

/** The version every scripted seat reports — the marker the bundle-boundary check greps. */
const SCRIPTED_HARNESS_VERSION = "685-scripted-v1";

/** The two providers a scripted plan can present as (`HarnessId` minus `omp`). */
type ScriptedProvider = "claude-code" | "codex";

const PATCHSET_PLAN_VALUE = `\${patchsetId}`;
const ASK_PLAN_VALUE = `\${askId}`;
/** Whole-string placeholder: becomes the round's ACTUAL evidence-manifest ids (#727).
 *  The ids are content-derived from the coding turn's diff, so a scripted plan cannot
 *  hard-code them — it asks for whatever the host measured. */
const EVIDENCE_IDS_PLAN_VALUE = `\${evidenceIds}`;
/** Whole-string placeholder: becomes every note id in `compose/asks.json` (3.7). The
 *  handoff compose turn must return a TOTAL COVER of exactly those ids, and they are
 *  minted per staged disposition, so a scripted plan cannot hard-code them either. */
const ASK_IDS_PLAN_VALUE = `\${askIds}`;

const relativeRepoPath = z
  .string()
  .min(1)
  .refine(
    (path) => !isAbsolute(path) && !path.split(/[\\/]/).includes(".."),
    "edit paths must stay inside SessionSpec.cwd",
  );

const match = {
  id: z.string().min(1),
  promptIncludes: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  promptExcludes: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
};

const structuredStepSchema = z.object({
  ...match,
  kind: z.literal("structured"),
  output: z.unknown(),
});

const echoBoardStepSchema = z.object({
  ...match,
  kind: z.literal("echo-board"),
});

const editStepSchema = z.object({
  ...match,
  kind: z.literal("edit"),
  edits: z
    .array(
      z.object({
        path: relativeRepoPath,
        from: z.string().min(1),
        to: z.string(),
      }),
    )
    .min(1),
  finalText: z.string(),
});

export const ScriptedHarnessPlanSchema = z.object({
  schemaVersion: z.literal(1),
  lane: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /**
   * The provider this plan presents as (#681 proof). The composition root routes the
   * test port BY DESCRIPTOR, so a `codex` plan makes a hermetic run a Codex-resolved
   * host with Claude Code genuinely absent — the only way the Codex leg of round
   * dispatch gets a launched proof. Absent ⇒ `claude-code`, the original behaviour.
   */
  harness: z.enum(["claude-code", "codex"]).optional(),
  invocationLog: z.string().refine(isAbsolute, "invocationLog must be an absolute path"),
  steps: z
    .array(
      z.discriminatedUnion("kind", [structuredStepSchema, echoBoardStepSchema, editStepSchema]),
    )
    .min(1),
});

export type ScriptedHarnessPlan = z.infer<typeof ScriptedHarnessPlanSchema>;
type ScriptedHarnessStep = ScriptedHarnessPlan["steps"][number];

const CONTEXT_PREFIX = "<<<rennet:layer context>>>\n";
const PAYLOAD_PREFIX = "<<<rennet:layer payload>>>\n";

interface InvocationRecord {
  readonly schemaVersion: 1;
  readonly lane: string;
  readonly invocationId: string;
  readonly stepId: string;
  readonly kind: ScriptedHarnessStep["kind"];
  readonly cwd: string;
  readonly promptDigest: string;
  readonly resumed: boolean;
  readonly recovered: boolean;
  /**
   * The EXECUTING seat's own provider (#681 / C14 D3) — read off the session that ran
   * this turn (`HarnessSession.harness`), never off the plan or the port descriptor.
   * The receipt the app displays comes from the RESOLVER's stamp, so it stays green if
   * the seat underneath silently executes as something else; this is the independent
   * half that does not. Stamping it from `plan.harness` here would re-close the same
   * loop, which is why the session hands its own value down.
   */
  readonly harness: ScriptedProvider;
}

function parsePlan(path: string): ScriptedHarnessPlan {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid scripted harness plan at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = ScriptedHarnessPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid scripted harness plan at ${path}: ${z.prettifyError(parsed.error)}`);
  }
  const ids = new Set<string>();
  for (const step of parsed.data.steps) {
    if (ids.has(step.id)) {
      throw new Error(`Invalid scripted harness plan at ${path}: duplicate step id ${step.id}`);
    }
    ids.add(step.id);
  }
  return parsed.data;
}

function readInvocationRecords(path: string): InvocationRecord[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (text === "") return [];
  return text.split("\n").map((line, index) => {
    const parsed = z
      .object({
        schemaVersion: z.literal(1),
        lane: z.string(),
        invocationId: z.string(),
        stepId: z.string(),
        kind: z.enum(["structured", "echo-board", "edit"]),
        cwd: z.string(),
        promptDigest: z.string(),
        resumed: z.boolean(),
        recovered: z.boolean(),
        harness: z.enum(["claude-code", "codex"]),
      })
      .safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(`Invalid scripted harness invocation record at ${path}:${index + 1}`);
    }
    return parsed.data;
  });
}

/**
 * The session-context files this turn was told about, read from the seat's own cwd.
 *
 * Since session-context-files a prompt carries no data: it names
 * `.rennet/context/<sessionId>/` under the working directory and the agent reads what it
 * decides it needs. A scripted seat reads the same files, so a plan step still matches on
 * the material the turn actually has, and `${askId}` / `${evidenceIds}` still resolve
 * against what the host wrote rather than against a payload nobody sends any more.
 *
 * Never throws: a turn with no context directory simply sees nothing extra.
 */
function sessionContextFiles(prompt: string, cwd: string): readonly string[] {
  const dir = /`(\.rennet\/context\/[^`/]+)\//.exec(prompt)?.[1];
  if (dir === undefined || cwd === "") return [];
  const root = resolve(cwd, dir);
  let entries: readonly Dirent[];
  try {
    // RECURSIVE: the writer nests (`boards/<lens>.json`, `compose/asks.json`,
    // `opener/`, `pr-body/`), and a flat read would make a step blind to exactly the
    // files the prompts that nest were rewritten to name.
    entries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.isFile() || entry.name === "README.md") return [];
    try {
      return [readFileSync(join(entry.parentPath, entry.name), "utf8")];
    } catch {
      return []; // unreadable for this turn; never fatal to step selection
    }
  });
}

/** Everything the turn can see: its prompt and the context files it names. */
function visibleToTurn(prompt: string, cwd: string): string {
  return [prompt, ...sessionContextFiles(prompt, cwd)].join("\n");
}

function jsonLayer(prompt: string, prefix: string, until?: string): unknown {
  const start = prompt.indexOf(prefix);
  if (start < 0) throw new Error(`scripted harness prompt is missing ${prefix.trim()}`);
  const bodyStart = start + prefix.length;
  const end = until === undefined ? prompt.length : prompt.indexOf(until, bodyStart);
  const body = prompt.slice(bodyStart, end < 0 ? prompt.length : end).trim();
  return JSON.parse(body);
}

function findPatchsetId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPatchsetId(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if ("patchsetId" in value && typeof value.patchsetId === "string") return value.patchsetId;
  if ("patchset" in value) {
    const patchset = value.patchset;
    if (typeof patchset === "object" && patchset !== null && "id" in patchset) {
      if (typeof patchset.id === "string") return patchset.id;
    }
  }
  for (const nested of Object.values(value)) {
    const found = findPatchsetId(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findDispatchedAskId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("dispatchedAsks" in value && Array.isArray(value.dispatchedAsks)) {
    const first = value.dispatchedAsks[0];
    if (
      typeof first === "object" &&
      first !== null &&
      "id" in first &&
      typeof first.id === "string"
    ) {
      return first.id;
    }
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = findDispatchedAskId(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The classifier context's evidence manifest ids, in canonical order. */
function findEvidenceIds(value: unknown): readonly string[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("evidence" in value && Array.isArray(value.evidence)) {
    const ids = value.evidence.flatMap((unit) =>
      typeof unit === "object" && unit !== null && "id" in unit && typeof unit.id === "string"
        ? [unit.id]
        : [],
    );
    if (ids.length > 0) return ids;
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = findEvidenceIds(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The note ids in `compose/asks.json` — the array of `{id, kind, path, anchor, note}` the
 * handoff compose turn is pointed at. Matched on the SHAPE rather than on a key name: the
 * turn sees every context file the writer left, and the entries carrying a `note` beside
 * an `id` are the reviewer's staged asks and nothing else. Every entry must have both, so
 * a partly-matching array (a boards file, the round evidence) is skipped rather than
 * half-read.
 */
function findComposeAskIds(value: unknown): readonly string[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (Array.isArray(value)) {
    const ids = value.flatMap((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "note" in entry &&
      "id" in entry &&
      typeof entry.id === "string"
        ? [entry.id]
        : [],
    );
    if (ids.length > 0 && ids.length === value.length) return ids;
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = findComposeAskIds(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}

function substitutePlanValues(
  value: unknown,
  values: {
    readonly patchsetId: string;
    readonly askId?: string;
    readonly evidenceIds?: readonly string[];
    readonly askIds?: readonly string[];
  },
): unknown {
  if (value === EVIDENCE_IDS_PLAN_VALUE && values.evidenceIds !== undefined) {
    return [...values.evidenceIds];
  }
  if (value === ASK_IDS_PLAN_VALUE && values.askIds !== undefined) {
    return [...values.askIds];
  }
  if (typeof value === "string") {
    return value
      .replaceAll(PATCHSET_PLAN_VALUE, values.patchsetId)
      .replaceAll(ASK_PLAN_VALUE, values.askId ?? ASK_PLAN_VALUE);
  }
  if (Array.isArray(value)) return value.map((item) => substitutePlanValues(item, values));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, substitutePlanValues(nested, values)]),
  );
}

function containsPlanValue(value: unknown, placeholder: string): boolean {
  if (typeof value === "string") return value.includes(placeholder);
  if (Array.isArray(value)) return value.some((item) => containsPlanValue(item, placeholder));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((nested) => containsPlanValue(nested, placeholder));
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + needle.length;
  }
}

function applyEdits(step: Extract<ScriptedHarnessStep, { kind: "edit" }>, cwd: string): boolean {
  let recovered = true;
  for (const edit of step.edits) {
    const target = resolve(cwd, edit.path);
    const targetRelative = relative(cwd, target);
    if (targetRelative.startsWith("..") || isAbsolute(targetRelative)) {
      throw new Error(`scripted harness edit escaped SessionSpec.cwd: ${edit.path}`);
    }
    const before = readFileSync(target, "utf8");
    const fromCount = countOccurrences(before, edit.from);
    if (fromCount === 1) {
      writeFileSync(target, before.replace(edit.from, edit.to));
      recovered = false;
      continue;
    }
    if (fromCount === 0 && countOccurrences(before, edit.to) === 1) continue;
    throw new Error(
      `scripted harness edit ${step.id} expected one exact match for ${edit.path}, found ${fromCount}`,
    );
  }
  return recovered;
}

function completedOutcome(
  step: ScriptedHarnessStep,
  spec: SessionSpec,
  prompt: string,
): {
  readonly outcome: SessionOutcome;
  readonly recovered: boolean;
} {
  if (step.kind === "edit") {
    return {
      outcome: { status: "completed", finalText: step.finalText },
      recovered: applyEdits(step, spec.cwd),
    };
  }
  if (spec.outputSchema === undefined) {
    throw new Error(`scripted harness step ${step.id} expected a structured-output session`);
  }
  if (step.kind === "echo-board") {
    const context = jsonLayer(prompt, CONTEXT_PREFIX, `\n\n${PAYLOAD_PREFIX}`);
    if (typeof context !== "object" || context === null || !("board" in context)) {
      throw new Error(`scripted harness step ${step.id} received no board context`);
    }
    return {
      outcome: { status: "completed", finalText: "", structuredOutput: context.board },
      recovered: false,
    };
  }
  const needsPatchset = containsPlanValue(step.output, PATCHSET_PLAN_VALUE);
  const needsAsk = containsPlanValue(step.output, ASK_PLAN_VALUE);
  const needsEvidence = containsPlanValue(step.output, EVIDENCE_IDS_PLAN_VALUE);
  const needsAskIds = containsPlanValue(step.output, ASK_IDS_PLAN_VALUE);
  // The values live in the session-context FILES since session-context-files: the prompt
  // names a directory and the seat opens it. A turn that still carries a JSON context
  // layer (the post-process turn, and the direct-call shapes the unit tests drive) is read
  // the old way, so both shapes resolve from whatever the turn can actually see.
  const needsValue = needsPatchset || needsAsk || needsEvidence || needsAskIds;
  const contextFileBodies = needsValue ? sessionContextFiles(prompt, spec.cwd) : [];
  const context = !needsValue
    ? undefined
    : contextFileBodies.length > 0
      ? contextFileBodies.flatMap((body) => {
          try {
            return [JSON.parse(body) as unknown];
          } catch {
            return []; // a non-JSON context file (a `.md` the prompt also names)
          }
        })
      : jsonLayer(prompt, CONTEXT_PREFIX);
  const patchsetId = context === undefined ? "" : findPatchsetId(context);
  if (needsPatchset && patchsetId === undefined) {
    throw new Error(`scripted harness step ${step.id} could not resolve the current patchset id`);
  }
  const askId = context === undefined ? undefined : findDispatchedAskId(context);
  if (needsAsk && askId === undefined) {
    throw new Error(`scripted harness step ${step.id} could not resolve the dispatched ask id`);
  }
  const evidenceIds = context === undefined ? undefined : findEvidenceIds(context);
  if (needsEvidence && evidenceIds === undefined) {
    throw new Error(`scripted harness step ${step.id} could not resolve the round evidence ids`);
  }
  const askIds = context === undefined ? undefined : findComposeAskIds(context);
  if (needsAskIds && askIds === undefined) {
    throw new Error(`scripted harness step ${step.id} could not resolve the composable ask ids`);
  }
  return {
    outcome: {
      status: "completed",
      finalText: "",
      structuredOutput: substitutePlanValues(step.output, {
        patchsetId: patchsetId ?? "",
        ...(askId === undefined ? {} : { askId }),
        ...(evidenceIds === undefined ? {} : { evidenceIds }),
        ...(askIds === undefined ? {} : { askIds }),
      }),
    },
    recovered: false,
  };
}

class ScriptedHarnessSession implements HarnessSession {
  readonly id = randomUUID();
  readonly #turnId = randomUUID();
  readonly #outcome: Promise<SessionOutcome>;
  readonly #resolveOutcome: (outcome: SessionOutcome) => void;
  #sent = false;

  constructor(
    readonly harness: ScriptedProvider,
    // The run callback is handed the session's OWN provider so the ledger it writes
    // records who executed, not what the plan declared (#681 / C14 D3).
    private readonly run: (prompt: string, harness: ScriptedProvider) => SessionOutcome,
  ) {
    let resolveOutcome: (outcome: SessionOutcome) => void = () => undefined;
    this.#outcome = new Promise((resolvePromise) => {
      resolveOutcome = resolvePromise;
    });
    this.#resolveOutcome = resolveOutcome;
  }

  get events(): AsyncIterable<HarnessEvent> {
    const outcome = this.#outcome;
    const sessionId = this.id;
    const turnId = this.#turnId;
    const harness = this.harness;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
        const terminal = await outcome;
        yield {
          seq: 1,
          harness,
          sessionId,
          turnId,
          receivedAt: Date.now(),
          native: { kind: "scripted-harness" },
          kind: "session.ended",
          outcome: terminal,
        };
      },
    };
  }

  async send(input: TurnInput): Promise<TurnId> {
    if (this.#sent) throw new Error("scripted harness sessions accept exactly one turn");
    this.#sent = true;
    this.#resolveOutcome(this.run(input.prompt, this.harness));
    return this.#turnId;
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** The one step whose prompt match is unique for this turn; ambiguity is a plan bug. */
function selectStep(
  plan: ScriptedHarnessPlan,
  /** The prompt PLUS the session-context files it names — what the turn can actually see. */
  prompt: string,
  wantsEdit: boolean,
): ScriptedHarnessStep {
  const matching = plan.steps.filter((step) => {
    const inclusions =
      typeof step.promptIncludes === "string" ? [step.promptIncludes] : step.promptIncludes;
    const exclusions =
      step.promptExcludes === undefined
        ? []
        : typeof step.promptExcludes === "string"
          ? [step.promptExcludes]
          : step.promptExcludes;
    return (
      inclusions.every((included) => prompt.includes(included)) &&
      exclusions.every((excluded) => !prompt.includes(excluded)) &&
      (wantsEdit ? step.kind === "edit" : step.kind !== "edit")
    );
  });
  if (matching.length === 0) {
    throw new Error(`scripted harness plan ${plan.lane} has no step for this prompt`);
  }
  if (matching.length > 1) {
    throw new Error(
      `scripted harness plan ${plan.lane} matched multiple steps: ${matching.map((step) => step.id).join(", ")}`,
    );
  }
  const step = matching[0];
  if (step === undefined) throw new Error("scripted harness step disappeared");
  return step;
}

function recordInvocation(
  plan: ScriptedHarnessPlan,
  step: ScriptedHarnessStep,
  fields: {
    readonly cwd: string;
    readonly prompt: string;
    readonly resumed: boolean;
    readonly recovered: boolean;
    readonly harness: ScriptedProvider;
  },
): void {
  const invocation: InvocationRecord = {
    schemaVersion: 1,
    lane: plan.lane,
    invocationId: randomUUID(),
    stepId: step.id,
    kind: step.kind,
    cwd: fields.cwd,
    promptDigest: createHash("sha256").update(fields.prompt).digest("hex"),
    resumed: fields.resumed,
    recovered: fields.recovered,
    harness: fields.harness,
  };
  appendFileSync(plan.invocationLog, `${JSON.stringify(invocation)}\n`);
}

/**
 * The plan as a Codex utility executor — the council's Codex seats (#681 proof). Read-only
 * by construction: `edit` steps belong to the agentic coding turn, so a utility seat that
 * matched one would be running a write turn on the read-only path, and this refuses instead.
 */
export function loadScriptedCodexExecutor(path: string): CodexExecutor {
  const plan = parsePlan(path);
  return async (request) => {
    const cwd = request.cwd ?? "";
    const step = selectStep(plan, visibleToTurn(request.prompt, cwd), false);
    const completed = completedOutcome(
      step,
      { cwd, outputSchema: request.outputSchema } as SessionSpec,
      request.prompt,
    );
    // A CodexExecutor IS the Codex utility seat — there is no other provider it could be.
    recordInvocation(plan, step, {
      cwd,
      prompt: request.prompt,
      resumed: false,
      recovered: false,
      harness: "codex",
    });
    if (completed.outcome.status !== "completed") {
      throw new Error(`scripted codex step ${step.id} did not complete`);
    }
    return {
      output: completed.outcome.structuredOutput,
      model: request.model,
      harnessVersion: SCRIPTED_HARNESS_VERSION,
    };
  };
}

export function loadScriptedHarnessPlan(path: string): HarnessPort {
  const plan = parsePlan(path);
  const harness = plan.harness ?? "claude-code";
  const consumedEdits = new Set(
    readInvocationRecords(plan.invocationLog)
      .filter((record) => record.lane === plan.lane && record.kind === "edit")
      .map((record) => record.stepId),
  );

  return {
    descriptor: {
      id: harness,
      displayName: `Scripted harness (${plan.lane})`,
      version: SCRIPTED_HARNESS_VERSION,
      binaryPath: path,
      capabilities: buildCapabilities({
        implementedByAdapter: ["resume", "structuredOutput"],
        advertisedByHarness: ["resume", "structuredOutput"],
        availableInSession: ["resume", "structuredOutput"],
      }),
    },
    health: async () => ({ state: "ready", version: SCRIPTED_HARNESS_VERSION }),
    createSession: async (spec) =>
      new ScriptedHarnessSession(harness, (prompt, executingHarness) => {
        const step = selectStep(
          plan,
          visibleToTurn(prompt, spec.cwd),
          spec.outputSchema === undefined,
        );
        if (step.kind === "edit" && consumedEdits.has(step.id)) {
          throw new Error(`scripted harness edit step ${step.id} was already consumed`);
        }
        const completed = completedOutcome(step, spec, prompt);
        if (step.kind === "edit") consumedEdits.add(step.id);
        recordInvocation(plan, step, {
          cwd: spec.cwd,
          prompt,
          resumed: spec.resume !== undefined,
          recovered: completed.recovered,
          // `executingHarness` is the SESSION's own field, not `harness` from this
          // closure — a session constructed as a different provider than the plan
          // declared writes what it really is, and the e2e ledger assertion reddens.
          harness: executingHarness,
        });
        return {
          ...completed.outcome,
          ...(completed.outcome.status === "completed"
            ? {
                harnessSessionId: `${plan.lane}:${step.id}`,
                lastAssistantMessageAnchor: step.id,
              }
            : {}),
        };
      }),
  };
}

// ── The plan as a T3 sidecar (session-bound-workspace 5.7) ───────────────────

/** One seat thread the scripted sidecar opened, and every turn that ran on it. */
export interface ScriptedSeatThread {
  readonly threadId: string;
  readonly seat: string;
  /** EXACTLY what `threadFor` was called with — provider, model, effort, and whatever
   *  binding fields the seam grows (the bound `worktreePath`). Recorded whole so a proof
   *  asserting on a field this file has never heard of still sees it. */
  readonly created: Readonly<Record<string, unknown>>;
  /** Each turn's prompt, in order: `[0]` is the drafting turn, the rest are repairs. */
  readonly prompts: string[];
}

/**
 * The scripted plan as the daemon's T3 seat runtime.
 *
 * Board seats run ONLY on sidecar threads (session-bound-workspace 5.7), so a launched
 * proof that used to answer them through the scripted `HarnessPort` answers them here
 * instead: one thread per seat, every attempt a turn on it. The step is selected from
 * everything the THREAD has been sent, not from this turn's text alone, which is what lets
 * a repair be answered at all: a repair turn carries pointers and no prompt file, so a
 * cold `selectStep` over it matches nothing (found by PR #800). Matching over the
 * conversation re-answers with the drafting step, exactly as a thread that still remembers
 * its own board would.
 *
 * The invocation ledger is written exactly as the port writes it, so the proofs' existing
 * assertions over `invocationLog` see seat turns whichever backend ran them.
 */
export function loadScriptedT3Seats(path: string): {
  /** The `resolveT3Seats` dep, bound to this plan. */
  readonly resolve: (input: {
    readonly repoRoot: string;
    /** The bound workspace the turn actually runs in (session-bound-workspace 5.2). */
    readonly worktreePath?: string;
    readonly generationId: string;
    readonly branch: string;
    readonly sessionId: string;
  }) => Promise<T3SeatRuntime>;
  /** Every thread opened so far, newest last. */
  readonly threads: readonly ScriptedSeatThread[];
} {
  const plan = parsePlan(path);
  const threads: ScriptedSeatThread[] = [];
  return {
    threads,
    resolve: async (input) => {
      // The turn's CWD, exactly as `resolveT3SeatRuntime` computes it: `repoRoot` names the
      // repository (one T3 project per repository, however many worktrees of it exist) and
      // `worktreePath` names the bound workspace the thread runs in. A session-context file
      // is written under that workspace and a prompt names it relatively, so a scripted seat
      // reading the repository root instead sees an empty context directory and silently
      // matches no step (#805 + 5.7).
      const workspace = input.worktreePath ?? input.repoRoot;
      const byThread = new Map<string, ScriptedSeatThread>();
      const settled = new Map<string, T3SettledTurn>();
      const seam: T3SeatSeam = {
        client: async () => ({
          startTurn: async ({ threadId, text, outputSchema }) => {
            const thread = byThread.get(threadId);
            if (thread === undefined)
              throw new Error(`scripted sidecar: unknown thread ${threadId}`);
            thread.prompts.push(text);
            // The whole conversation, because that is what the thread holds.
            const conversation = thread.prompts.join("\n");
            const step = selectStep(plan, visibleToTurn(conversation, workspace), false);
            const completed = completedOutcome(
              step,
              { cwd: workspace, outputSchema } as SessionSpec,
              conversation,
            );
            recordInvocation(plan, step, {
              cwd: workspace,
              prompt: text,
              resumed: thread.prompts.length > 1,
              recovered: completed.recovered,
              harness: thread.created.provider === "codex" ? "codex" : "claude-code",
            });
            settled.set(threadId, {
              turnId: `${threadId}:${thread.prompts.length}`,
              state: completed.outcome.status === "completed" ? "completed" : "error",
              ...(completed.outcome.status === "completed" &&
              completed.outcome.structuredOutput !== undefined
                ? { structuredOutput: completed.outcome.structuredOutput }
                : {}),
              thread: { messages: [], session: null },
            });
            return { previousTurnId: null, requestedAt: new Date().toISOString() };
          },
          waitForTurnSettled: async (threadId) => {
            const turn = settled.get(threadId);
            if (turn === undefined) throw new Error(`scripted sidecar: no turn on ${threadId}`);
            return turn;
          },
          interruptTurn: async () => undefined,
        }),
        threadFor: async (created) => {
          const threadId = `${plan.lane}:${input.generationId}:${created.seat}`;
          const existing = byThread.get(threadId);
          if (existing !== undefined) return { threadId, projectId: plan.lane };
          const thread: ScriptedSeatThread = {
            threadId,
            seat: created.seat,
            created: { ...created } as Record<string, unknown>,
            prompts: [],
          };
          byThread.set(threadId, thread);
          threads.push(thread);
          return { threadId, projectId: plan.lane };
        },
      };
      return {
        seam,
        environmentId: `scripted:${plan.lane}`,
        watch: () => ({ stop: () => undefined }),
      };
    },
  };
}
