import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  buildCapabilities,
  type HarnessEvent,
  type HarnessPort,
  type HarnessSession,
  type SessionOutcome,
  type SessionSpec,
  type TurnId,
  type TurnInput,
} from "@rennet/core";
import { z } from "zod";

const relativeRepoPath = z
  .string()
  .min(1)
  .refine(
    (path) => !isAbsolute(path) && !path.split(/[\\/]/).includes(".."),
    "edit paths must stay inside SessionSpec.cwd",
  );

const match = {
  id: z.string().min(1),
  promptIncludes: z.string().min(1),
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

const coverageStepSchema = z.object({
  ...match,
  kind: z.literal("coverage"),
  implementationPath: relativeRepoPath,
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
  invocationLog: z.string().refine(isAbsolute, "invocationLog must be an absolute path"),
  steps: z
    .array(
      z.discriminatedUnion("kind", [
        structuredStepSchema,
        echoBoardStepSchema,
        coverageStepSchema,
        editStepSchema,
      ]),
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
}

function parsePlan(path: string): ScriptedHarnessPlan {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid scripted harness plan at ${path}: ${error instanceof Error ? error.message : String(error)}`,
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
        kind: z.enum(["structured", "echo-board", "coverage", "edit"]),
        cwd: z.string(),
        promptDigest: z.string(),
        resumed: z.boolean(),
        recovered: z.boolean(),
      })
      .safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(`Invalid scripted harness invocation record at ${path}:${index + 1}`);
    }
    return parsed.data;
  });
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

function findCandidateId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("candidates" in value && Array.isArray(value.candidates)) {
    const first = value.candidates[0];
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
    const found = findCandidateId(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}

function substitutePlanValues(
  value: unknown,
  values: { readonly patchsetId: string; readonly candidateId?: string },
): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll("${patchsetId}", values.patchsetId)
      .replaceAll("${candidateId}", values.candidateId ?? "${candidateId}");
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

function coverageSection(
  prompt: string,
  heading: string,
  nextHeading: string,
): Record<string, unknown> {
  const start = prompt.indexOf(heading);
  const end = prompt.indexOf(nextHeading, start + heading.length);
  if (start < 0 || end < 0) {
    throw new Error(`scripted harness coverage prompt is missing ${heading.trim()}`);
  }
  const parsed: unknown = JSON.parse(prompt.slice(start + heading.length, end).trim());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`scripted harness coverage section ${heading.trim()} is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function coverageOutput(
  step: Extract<ScriptedHarnessStep, { kind: "coverage" }>,
  prompt: string,
): unknown {
  const requirementSection = coverageSection(prompt, "REQUIREMENTS:\n", "\n\nOFFERED HUNKS:");
  const hunkSection = coverageSection(
    `${prompt}\nSCRIPTED COVERAGE END`,
    "OFFERED HUNKS:\n",
    "\nSCRIPTED COVERAGE END",
  );
  const requirements = Array.isArray(requirementSection.requirements)
    ? requirementSection.requirements
    : [];
  const hunks = Array.isArray(hunkSection.hunks) ? hunkSection.hunks : [];
  const implementationHunks = hunks.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const hunk = value as Record<string, unknown>;
    return hunk.filePath === step.implementationPath && typeof hunk.id === "string"
      ? [hunk.id]
      : [];
  });
  return {
    mappings: requirements.flatMap((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
      const requirement = value as Record<string, unknown>;
      if (
        typeof requirement.capability !== "string" ||
        typeof requirement.requirement !== "string"
      ) {
        return [];
      }
      return [
        {
          capability: requirement.capability,
          requirement: requirement.requirement,
          hunks: implementationHunks,
          testHunks: [],
        },
      ];
    }),
  };
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
  if (step.kind === "coverage") {
    return {
      outcome: {
        status: "completed",
        finalText: "",
        structuredOutput: coverageOutput(step, prompt),
      },
      recovered: false,
    };
  }
  const needsPatchset = containsPlanValue(step.output, "${patchsetId}");
  const needsCandidate = containsPlanValue(step.output, "${candidateId}");
  const context = needsPatchset || needsCandidate ? jsonLayer(prompt, CONTEXT_PREFIX) : undefined;
  const patchsetId = context === undefined ? "" : findPatchsetId(context);
  if (needsPatchset && patchsetId === undefined) {
    throw new Error(`scripted harness step ${step.id} could not resolve the current patchset id`);
  }
  const candidateId = context === undefined ? undefined : findCandidateId(context);
  if (needsCandidate && candidateId === undefined) {
    throw new Error(`scripted harness step ${step.id} could not resolve the current candidate id`);
  }
  return {
    outcome: {
      status: "completed",
      finalText: "",
      structuredOutput: substitutePlanValues(step.output, {
        patchsetId: patchsetId ?? "",
        ...(candidateId === undefined ? {} : { candidateId }),
      }),
    },
    recovered: false,
  };
}

class ScriptedHarnessSession implements HarnessSession {
  readonly id = randomUUID();
  readonly harness: HarnessSession["harness"] = "claude-code";
  readonly #turnId = randomUUID();
  readonly #outcome: Promise<SessionOutcome>;
  readonly #resolveOutcome: (outcome: SessionOutcome) => void;
  #sent = false;

  constructor(private readonly run: (prompt: string) => SessionOutcome) {
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
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
        const terminal = await outcome;
        yield {
          seq: 1,
          harness: "claude-code",
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
    try {
      this.#resolveOutcome(this.run(input.prompt));
      return this.#turnId;
    } catch (error) {
      throw error;
    }
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export function loadScriptedHarnessPlan(path: string): HarnessPort {
  const plan = parsePlan(path);
  const consumedEdits = new Set(
    readInvocationRecords(plan.invocationLog)
      .filter((record) => record.lane === plan.lane && record.kind === "edit")
      .map((record) => record.stepId),
  );

  return {
    descriptor: {
      id: "claude-code",
      displayName: `Scripted harness (${plan.lane})`,
      version: "685-scripted-v1",
      binaryPath: path,
      capabilities: buildCapabilities({
        implementedByAdapter: ["resume", "structuredOutput"],
        advertisedByHarness: ["resume", "structuredOutput"],
        availableInSession: ["resume", "structuredOutput"],
      }),
    },
    health: async () => ({ state: "ready", version: "685-scripted-v1" }),
    createSession: async (spec) =>
      new ScriptedHarnessSession((prompt) => {
        const matching = plan.steps.filter((step) => {
          const exclusions =
            step.promptExcludes === undefined
              ? []
              : typeof step.promptExcludes === "string"
                ? [step.promptExcludes]
                : step.promptExcludes;
          return (
            prompt.includes(step.promptIncludes) &&
            exclusions.every((excluded) => !prompt.includes(excluded)) &&
            (spec.outputSchema === undefined ? step.kind === "edit" : step.kind !== "edit")
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
        if (step.kind === "edit" && consumedEdits.has(step.id)) {
          throw new Error(`scripted harness edit step ${step.id} was already consumed`);
        }
        const completed = completedOutcome(step, spec, prompt);
        if (step.kind === "edit") consumedEdits.add(step.id);
        const invocation: InvocationRecord = {
          schemaVersion: 1,
          lane: plan.lane,
          invocationId: randomUUID(),
          stepId: step.id,
          kind: step.kind,
          cwd: spec.cwd,
          promptDigest: createHash("sha256").update(prompt).digest("hex"),
          resumed: spec.resume !== undefined,
          recovered: completed.recovered,
        };
        appendFileSync(plan.invocationLog, `${JSON.stringify(invocation)}\n`);
        return {
          ...completed.outcome,
          ...(completed.outcome.status === "completed"
            ? { harnessSessionId: `${plan.lane}:${step.id}` }
            : {}),
        };
      }),
  };
}
