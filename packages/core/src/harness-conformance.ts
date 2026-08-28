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
  /** Drive one session through the port in `cwd`; resolve true iff the capability shows. */
  run(port: HarnessPort, cwd: string): Promise<boolean>;
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
  readonly controlPorts?: Readonly<Partial<Record<CapabilityName, HarnessPort>>>;
  /**
   * The cwd every check's session runs in. Defaults to a placeholder; a REAL run
   * against the installed binary MUST pass a real git repo (codex `-C` into it
   * with no repo-check skip). Fake transports ignore it.
   */
  readonly cwd?: string;
}

const PROBE_CWD = "/rennet-conformance";
const PROBE_PROMPT = "Conformance probe: return a minimal structured result.";
const INTERRUPT_PROBE_PROMPT = "Conformance probe: remain active until interrupted.";
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

async function drain(session: HarnessSession, onFirstEvent?: () => void): Promise<Drained> {
  const events: HarnessEvent[] = [];
  let outcome: SessionOutcome | null = null;
  for await (const event of session.events) {
    if (events.length === 0) onFirstEvent?.();
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
    run: async (port, cwd) => {
      const session = await port.createSession({
        cwd,
        outputSchema: PROBE_SCHEMA,
        ephemeral: true,
      });
      await session.send({ prompt: PROBE_PROMPT });
      const { outcome } = await drain(session);
      return outcome?.status === "completed" && outcome.structuredOutput !== undefined;
    },
  },
  {
    capability: "interrupt",
    run: async (port, cwd) => {
      const session = await port.createSession({ cwd, ephemeral: true });
      let markReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      const draining = drain(session, markReady);
      await session.send({ prompt: INTERRUPT_PROBE_PROMPT });
      await ready;
      await session.interrupt();
      const { outcome } = await draining;
      return outcome?.status === "cancelled";
    },
  },
  {
    capability: "textDeltas",
    run: async (port, cwd) => {
      const session = await port.createSession({ cwd, ephemeral: true });
      await session.send({ prompt: PROBE_PROMPT });
      const { events } = await drain(session);
      return events.some((event) => event.kind === "text.delta");
    },
  },
  {
    capability: "reportsContextWindow",
    run: async (port, cwd) => {
      const session = await port.createSession({ cwd, ephemeral: true });
      await session.send({ prompt: PROBE_PROMPT });
      const { outcome } = await drain(session);
      return (
        outcome?.status === "completed" &&
        typeof outcome.contextWindowTokens === "number" &&
        Number.isFinite(outcome.contextWindowTokens) &&
        outcome.contextWindowTokens > 0
      );
    },
  },
  {
    capability: "costUsd",
    run: async (port, cwd) => {
      const session = await port.createSession({ cwd, ephemeral: true });
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
function makeBrokenControlPort(capability: CapabilityName): HarnessPort {
  const descriptor = {
    id: "codex",
    displayName: `broken-${capability}-control`,
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
              kind: "session.started",
              model: "control",
              cwd: PROBE_CWD,
              tools: [],
              apiKeySource: null,
            };
            if (capability !== "textDeltas") {
              yield { ...envelope(context, {}), kind: "text.delta", text: "{" };
            }
            const structuredOutput =
              capability === "structuredOutput" ? {} : { structuredOutput: { ok: true } };
            const contextWindowTokens =
              capability === "reportsContextWindow" ? {} : { contextWindowTokens: 1 };
            const native = capability === "costUsd" ? {} : { total_cost_usd: 0 };
            yield {
              ...envelope(context, native),
              kind: "session.ended",
              outcome:
                capability === "interrupt"
                  ? { status: "completed", finalText: "" }
                  : {
                      status: "completed",
                      finalText: "",
                      ...structuredOutput,
                      ...contextWindowTokens,
                    },
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

/**
 * Run the whole suite against `port`. Every check first runs against its own
 * refuting control port. If any check cannot reject its deliberately broken
 * variant, the suite refuses to certify.
 */
export async function runConformance(
  port: HarnessPort,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const cwd = options.cwd ?? PROBE_CWD;
  for (const check of CONFORMANCE_CHECKS) {
    const controlPort =
      options.controlPorts?.[check.capability] ?? makeBrokenControlPort(check.capability);
    if (await check.run(controlPort, cwd)) {
      throw new Error(
        `conformance positive control did not fail for ${check.capability}: the suite refuses to certify`,
      );
    }
  }
  const controlDemonstrated = true;

  const passed: CapabilityName[] = [];
  const failed: CapabilityName[] = [];
  for (const check of CONFORMANCE_CHECKS) {
    const ok = await check.run(port, cwd);
    (ok ? passed : failed).push(check.capability);
  }

  const evidence: CapabilityEvidence = options.real
    ? { advertisedByHarness: passed, availableInSession: passed }
    : { implementedByAdapter: passed };

  return { passed, failed, controlDemonstrated, evidence };
}
