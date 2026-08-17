import type { RspTokenUsage } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  buildCapabilities,
  type CapabilityName,
  type HarnessDescriptor,
  type HarnessEvent,
  type HarnessHealth,
  type HarnessPort,
  type HarnessSession,
  type SessionOutcome,
  type SessionSpec,
  type TurnInput,
} from "./harness";
import {
  CONFORMANCE_CHECKS,
  type ConformanceReport,
  runConformance,
} from "./harness-conformance";

// ── A scripted fake HarnessPort (no adapters, no SDK, no process) ────────────
//
// The suite is pure over HarnessPort, so its tests drive it against inline fakes
// shaped like each adapter. A fake either honours a capability (emits the event /
// outcome the check looks for) or omits it (the check sees nothing → false flag).

interface FakeShape {
  /** Emit a completed outcome carrying structured output. */
  readonly structuredOutput?: boolean;
  /** Emit at least one text.delta. */
  readonly textDeltas?: boolean;
  /** Attach token usage to the completed outcome. */
  readonly usage?: RspTokenUsage;
  /** Put a cost number on the terminal frame's native. */
  readonly costUsd?: number;
  /** Honour signal abort with a cancelled outcome. */
  readonly interruptible?: boolean;
}

const USAGE: RspTokenUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: null,
  total: 15,
};

function base(): Omit<HarnessEvent, "kind"> & Record<string, unknown> {
  return {
    seq: 1,
    harness: "codex",
    sessionId: "s1",
    turnId: "t1",
    receivedAt: 0,
    native: {},
  };
}

function fakePort(shape: FakeShape): HarnessPort {
  const descriptor = { id: "codex" } as unknown as HarnessDescriptor;
  return {
    descriptor,
    health(): Promise<HarnessHealth> {
      return Promise.resolve({ state: "ready", version: "0.146.0" });
    },
    createSession(spec: SessionSpec): Promise<HarnessSession> {
      const events: HarnessEvent[] = [];
      if (shape.textDeltas) {
        events.push({ ...base(), kind: "text.delta", text: "hi" } as HarnessEvent);
      }
      const buildTerminal = (): HarnessEvent => {
        if (spec.signal?.aborted && shape.interruptible) {
          return {
            ...base(),
            kind: "session.ended",
            outcome: { status: "cancelled", partial: true },
          } as HarnessEvent;
        }
        const outcome: SessionOutcome = {
          status: "completed",
          finalText: "done",
          ...(shape.structuredOutput ? { structuredOutput: { ok: true } } : {}),
          ...(shape.usage ? { usage: shape.usage } : {}),
        };
        const native = shape.costUsd === undefined ? {} : { total_cost_usd: shape.costUsd };
        return { ...base(), native, kind: "session.ended", outcome } as HarnessEvent;
      };
      const session: HarnessSession = {
        id: "s1",
        harness: "codex",
        events: {
          async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
            for (const event of events) yield event;
            // The terminal is produced lazily, so a signal aborted after send()
            // but before draining is observed here (the check aborts then drains).
            yield buildTerminal();
          },
        },
        send(_input: TurnInput): Promise<string> {
          return Promise.resolve("t1");
        },
        interrupt(): Promise<void> {
          return Promise.resolve();
        },
        close(): Promise<void> {
          return Promise.resolve();
        },
      };
      return Promise.resolve(session);
    },
  };
}

/** A Claude-shaped fake: everything, plus cost USD. */
const CLAUDE_SHAPE: FakeShape = {
  structuredOutput: true,
  textDeltas: true,
  usage: USAGE,
  costUsd: 0.0123,
  interruptible: true,
};

/** A codex-shaped fake: everything the checks probe EXCEPT cost USD. */
const CODEX_SHAPE: FakeShape = {
  structuredOutput: true,
  textDeltas: true,
  usage: USAGE,
  interruptible: true,
};

function passingNames(report: ConformanceReport): Set<CapabilityName> {
  return new Set(report.passed);
}

describe("harness conformance suite", () => {
  it("maps each check to exactly one capability name", () => {
    const seen = new Set<CapabilityName>();
    for (const check of CONFORMANCE_CHECKS) {
      expect(seen.has(check.capability)).toBe(false);
      seen.add(check.capability);
    }
    // The five capabilities this change exercises.
    expect([...seen].sort()).toEqual(
      ["costUsd", "interrupt", "reportsContextWindow", "structuredOutput", "textDeltas"].sort(),
    );
  });

  it("derives two honest descriptors from one suite", async () => {
    const claude = await runConformance(fakePort(CLAUDE_SHAPE));
    const codex = await runConformance(fakePort(CODEX_SHAPE));

    // Both pass structuredOutput and interrupt.
    for (const cap of ["structuredOutput", "interrupt"] as const) {
      expect(passingNames(claude).has(cap)).toBe(true);
      expect(passingNames(codex).has(cap)).toBe(true);
    }
    // costUsd is the one honest divergence.
    expect(passingNames(claude).has("costUsd")).toBe(true);
    expect(passingNames(codex).has("costUsd")).toBe(false);

    // Fed to buildCapabilities, the descriptor's true flags are EXACTLY the
    // passing set, and every unexercised capability stays false in every layer.
    const caps = buildCapabilities(codex.evidence);
    expect(caps.costUsd.implementedByAdapter).toBe(false);
    expect(caps.structuredOutput.implementedByAdapter).toBe(true);
    // resume/fork/toolGating are never exercised → false everywhere.
    for (const cap of ["resume", "fork", "toolGating"] as const) {
      expect(caps[cap].implementedByAdapter).toBe(false);
      expect(caps[cap].advertisedByHarness).toBe(false);
      expect(caps[cap].availableInSession).toBe(false);
    }
  });

  it("caps fake-transport runs at implementedByAdapter", async () => {
    const report = await runConformance(fakePort(CODEX_SHAPE));
    const caps = buildCapabilities(report.evidence);
    // The outer layers are never earned by a fake run.
    expect(caps.structuredOutput.implementedByAdapter).toBe(true);
    expect(caps.structuredOutput.advertisedByHarness).toBe(false);
    expect(caps.structuredOutput.availableInSession).toBe(false);
  });

  it("earns the outer layers on a real run", async () => {
    const report = await runConformance(fakePort(CODEX_SHAPE), { real: true });
    const caps = buildCapabilities(report.evidence);
    expect(caps.structuredOutput.advertisedByHarness).toBe(true);
    expect(caps.structuredOutput.availableInSession).toBe(true);
  });

  it("leaves a skipped/failed check's flag false — absence is absence", async () => {
    // A fake with no structured output: the check fails, the flag is false, and
    // it is indistinguishable from a check that never ran.
    const report = await runConformance(fakePort({ interruptible: true }));
    expect(passingNames(report).has("structuredOutput")).toBe(false);
    const caps = buildCapabilities(report.evidence);
    expect(caps.structuredOutput.implementedByAdapter).toBe(false);
  });

  describe("positive control — the suite is proven able to fail", () => {
    it("the default broken control transport fails its structuredOutput check", async () => {
      const report = await runConformance(fakePort(CODEX_SHAPE));
      expect(report.controlDemonstrated).toBe(true);
    });

    it("refuses to certify when the control cannot be shown to fail", async () => {
      // A control port that DOES produce structured output means the machinery
      // cannot demonstrate a failing check — the run must refuse to certify.
      const goodControl = fakePort(CODEX_SHAPE);
      await expect(
        runConformance(fakePort(CODEX_SHAPE), { controlPort: goodControl }),
      ).rejects.toThrow(/control/i);
    });
  });
});
