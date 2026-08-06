import { describe, expect, it } from "vitest";
import {
  buildCapabilities,
  CAPABILITY_NAMES,
  type CapabilityName,
  createSeqCounter,
  type EnvelopeContext,
  envelope,
} from "./harness";

describe("buildCapabilities", () => {
  it("defaults every layer of every capability to false", () => {
    const capabilities = buildCapabilities();
    for (const name of CAPABILITY_NAMES) {
      expect(capabilities[name]).toEqual({
        implementedByAdapter: false,
        advertisedByHarness: false,
        availableInSession: false,
      });
    }
  });

  it("derives flags from passing checks, not declaration", () => {
    const implemented: CapabilityName[] = ["structuredOutput", "interrupt"];
    const capabilities = buildCapabilities({
      implementedByAdapter: implemented,
      advertisedByHarness: ["structuredOutput"],
    });
    // Only the named capabilities are implemented; the rest stay false.
    expect(capabilities.structuredOutput.implementedByAdapter).toBe(true);
    expect(capabilities.interrupt.implementedByAdapter).toBe(true);
    expect(capabilities.resume.implementedByAdapter).toBe(false);
    expect(capabilities.fork.implementedByAdapter).toBe(false);
    // Advertised is a separate layer: structuredOutput is advertised, interrupt is not.
    expect(capabilities.structuredOutput.advertisedByHarness).toBe(true);
    expect(capabilities.interrupt.advertisedByHarness).toBe(false);
    // Nothing was exercised in a session, so availableInSession is false everywhere.
    expect(capabilities.structuredOutput.availableInSession).toBe(false);
  });

  it("keeps the three layers independent", () => {
    const capabilities = buildCapabilities({
      implementedByAdapter: ["fork"],
      advertisedByHarness: ["resume"],
      availableInSession: ["interrupt"],
    });
    expect(capabilities.fork).toEqual({
      implementedByAdapter: true,
      advertisedByHarness: false,
      availableInSession: false,
    });
    expect(capabilities.resume).toEqual({
      implementedByAdapter: false,
      advertisedByHarness: true,
      availableInSession: false,
    });
    expect(capabilities.interrupt).toEqual({
      implementedByAdapter: false,
      advertisedByHarness: false,
      availableInSession: true,
    });
  });
});

describe("createSeqCounter", () => {
  it("is monotonic and starts at one", () => {
    const counter = createSeqCounter();
    expect(counter.next()).toBe(1);
    expect(counter.next()).toBe(2);
    expect(counter.next()).toBe(3);
  });

  it("respects an explicit start", () => {
    const counter = createSeqCounter(10);
    expect(counter.next()).toBe(11);
  });
});

describe("envelope", () => {
  it("stamps a monotonic seq and the fixed session fields", () => {
    let clock = 100;
    const context: EnvelopeContext = {
      harness: "claude-code",
      sessionId: "session-1",
      turnId: null,
      seq: createSeqCounter(),
      now: () => (clock += 1),
    };
    const first = envelope(context, { raw: 1 });
    const second = envelope(context, { raw: 2 });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.harness).toBe("claude-code");
    expect(first.sessionId).toBe("session-1");
    expect(first.turnId).toBeNull();
    expect(first.native).toEqual({ raw: 1 });
    expect(second.receivedAt).toBeGreaterThan(first.receivedAt);
  });
});
