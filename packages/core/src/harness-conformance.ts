/**
 * The cross-adapter conformance suite (#25's core ask).
 *
 * One catalogue of named checks runs identically against every `HarnessPort`.
 * Each check maps to exactly ONE `CapabilityName` and drives a session through
 * the port, watching the normalized event stream for the evidence that capability
 * would leave. A run's output is `CapabilityEvidence` naming only the checks that
 * passed — fed to `buildCapabilities`, so a descriptor's `true` flags are exactly
 * the passing set and nothing can DECLARE a flag (absence of evidence is absence
 * of capability).
 *
 * Pure `@rennet/core`: no `node:*`, no filesystem, no process at module scope, so
 * the suite imports anywhere the port does. The real binaries are reached only by
 * the gated `.real` tests in `@rennet/adapters`, which pass a real adapter here.
 *
 * Layer attribution: a fake-transport run caps at `implementedByAdapter` (the
 * mapping code exists and works); only a real run against the installed binary
 * earns `advertisedByHarness` / `availableInSession`.
 */

import {
  buildCapabilities,
  type CapabilityEvidence,
  type CapabilityName,
  createSeqCounter,
  envelope,
  type HarnessDescriptor,
  type HarnessEvent,
  type HarnessPort,
  type HarnessSession,
  type SessionOutcome,
} from "./harness";

/** A single conformance check, bound to exactly one capability. */
export interface ConformanceCheck {
  readonly capability: CapabilityName;
  /** Drive one session through the port; resolve true iff the capability shows. */
  run(port: HarnessPort): Promise<boolean>;
}

/** The result of a suite run. `evidence` is ready for `buildCapabilities`. */
export interface ConformanceReport {
  readonly passed: readonly CapabilityName[];
  readonly failed: readonly CapabilityName[];
  /** The positive control fired (a deliberately broken transport failed a check). */
  readonly controlDemonstrated: boolean;
  readonly evidence: CapabilityEvidence;
}

export interface ConformanceOptions {
  /**
   * A real run against an installed binary earns the outer layers
   * (`advertisedByHarness` + `availableInSession`); the default hermetic run
   * caps at `implementedByAdapter`.
   */
  readonly real?: boolean;
  /**
   * The positive-control port. Defaults to a deliberately broken transport that
   * completes WITHOUT structured output, so the `structuredOutput` check must
   * fail against it. Injectable so a test can prove the refuse-to-certify path
   * (a control that cannot be shown to fail is a suite that cannot certify).
   */
  readonly controlPort?: HarnessPort;
}

const PROBE_CWD = "/rennet-conformance";
const PROBE_PROMPT = "Conformance probe: return a minimal structured result.";
const PROBE_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
} as const;

interface Drained {
  readonly outcome: SessionOutcome | null;
  readonly events: readonly HarnessEvent[];
}

async function drain(session: HarnessSession): Promise<Drained> {
  const events: HarnessEvent[] = [];
  let outcome: SessionOutcome | null = null;
  for await (const event of session.events) {
    events.push(event);
    if (event.kind === "session.ended") outcome = event.outcome;
  }
  return { outcome, events };
}

/** Scan a terminal native frame for a cost-in-USD number, tolerantly. */
function extractCostUsd(native: unknown): number | null {
  if (native === null || typeof native !== "object") return null;
  const record = native as Record<string, unknown>;
  for (const key of ["total_cost_usd", "cost_usd", "costUsd", "cost"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * The check catalogue. Each entry maps to exactly one capability. `resume`,
 * `fork`, and `toolGating` have NO check in this change, so they are structurally
 * false everywhere — not stubbed as passing.
 */
export const CONFORMANCE_CHECKS: readonly ConformanceCheck[] = [
  {
    capability: "structuredOutput",
    run: async (port) => {
      const session = await port.createSession({ cwd: PROBE_CWD, outputSchema: PROBE_SCHEMA });
      await session.send({ prompt: PROBE_PROMPT });
      const { outcome } = await drain(session);
      return outcome?.status === "completed" && outcome.structuredOutput !== undefined;
    },
  },
  {
    capability: "interrupt",
    run: async (port) => {
      const abort = new AbortController();
      const session = await port.createSession({ cwd: PROBE_CWD, signal: abort.signal });
      await session.send({ prompt: PROBE_PROMPT });
      abort.abort();
      await session.interrupt();
      const { outcome } = await drain(session);
      return outcome?.status === "cancelled";
    },
  },
  {
    capability: "textDeltas",
    run: async (port) => {
      const session = await port.createSession({ cwd: PROBE_CWD });
      await session.send({ prompt: PROBE_PROMPT });
      const { events } = await drain(session);
      return events.some((event) => event.kind === "text.delta");
    },
  },
  {
    capability: "reportsContextWindow",
    run: async (port) => {
      const session = await port.createSession({ cwd: PROBE_CWD });
      await session.send({ prompt: PROBE_PROMPT });
      const { outcome } = await drain(session);
      return outcome?.status === "completed" && outcome.usage !== undefined;
    },
  },
  {
    capability: "costUsd",
    run: async (port) => {
      const session = await port.createSession({ cwd: PROBE_CWD });
      await session.send({ prompt: PROBE_PROMPT });
      const { events } = await drain(session);
      const ended = events.find((event) => event.kind === "session.ended");
      return ended !== undefined && extractCostUsd(ended.native) !== null;
    },
  },
];

/**
 * A deliberately broken port: one session that completes with NO structured
 * output. The `structuredOutput` check MUST fail against it — the suite's proof
 * that a check can distinguish pass from fail.
 */
function makeBrokenControlPort(): HarnessPort {
  const descriptor = {
    id: "codex",
    displayName: "broken-control",
    version: "0",
    binaryPath: "",
    capabilities: buildCapabilities(),
    testedRange: { min: "0", maxTested: "0" },
  } satisfies HarnessDescriptor;
  return {
    descriptor,
    health: () => Promise.resolve({ state: "ready", version: "0" }),
    createSession: () => {
      const context = {
        harness: "codex" as const,
        sessionId: "control",
        turnId: "control",
        seq: createSeqCounter(),
        now: () => 0,
      };
      const session: HarnessSession = {
        id: "control",
        harness: "codex",
        events: {
          async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
            yield {
              ...envelope(context, {}),
              kind: "session.ended",
              outcome: { status: "completed", finalText: "" },
            };
          },
        },
        send: () => Promise.resolve("control"),
        interrupt: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      return Promise.resolve(session);
    },
  };
}

const STRUCTURED_OUTPUT_CHECK = CONFORMANCE_CHECKS.find(
  (check) => check.capability === "structuredOutput",
);

/**
 * Run the whole suite against `port`. Always runs the positive control first: if
 * the control's `structuredOutput` check does NOT fail, the machinery cannot
 * demonstrate a failing check and the run REFUSES to certify (throws). Otherwise
 * it runs every check and returns the passing set as `CapabilityEvidence` in the
 * layer the run earns.
 */
export async function runConformance(
  port: HarnessPort,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  if (!STRUCTURED_OUTPUT_CHECK) {
    throw new Error("conformance suite is missing its structuredOutput control check");
  }
  const controlPort = options.controlPort ?? makeBrokenControlPort();
  const controlPassed = await STRUCTURED_OUTPUT_CHECK.run(controlPort);
  const controlDemonstrated = !controlPassed;
  if (!controlDemonstrated) {
    throw new Error(
      "conformance positive control did not fail: the suite cannot demonstrate a failing check, so it refuses to certify",
    );
  }

  const passed: CapabilityName[] = [];
  const failed: CapabilityName[] = [];
  for (const check of CONFORMANCE_CHECKS) {
    const ok = await check.run(port);
    (ok ? passed : failed).push(check.capability);
  }

  const evidence: CapabilityEvidence = options.real
    ? { advertisedByHarness: passed, availableInSession: passed }
    : { implementedByAdapter: passed };

  return { passed, failed, controlDemonstrated, evidence };
}
