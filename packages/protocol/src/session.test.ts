import { describe, expect, it } from "vitest";
import {
  askStreamEventFrameSchema,
  checkProtocolCompatibility,
  helloFrameSchema,
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  parseSessionFrame,
  progressEventFrameSchema,
  requestFrameSchema,
  responseFrameSchema,
  rpcErrorFrameSchema,
  serverInfoFrameSchema,
} from "./index";

// A real command name, so the `request` frame's `isCommandName` refinement passes.
const REAL_COMMAND = "canvas.disposition";

const hello = { type: "hello", clientId: "c1", clientType: "desktop", protocolVersion: 1 } as const;
const serverInfo = {
  type: "serverInfo",
  version: "0.1.4",
  protocolVersion: 1,
  minCompatibleProtocolVersion: 1,
  features: { askStream: true, remoteProjection: false },
} as const;
const request = {
  type: "request",
  requestId: "r1",
  command: REAL_COMMAND,
  input: { patchsetId: "ps", disposition: "approve" },
} as const;
const response = { type: "response", requestId: "r1", output: { ok: true, count: 3 } } as const;
const rpcError = {
  type: "rpcError",
  requestId: "r1",
  code: "command_failed",
  message: "the command failed",
} as const;
const progressEvent = {
  type: "progressEvent",
  commandId: "cmd1",
  event: { kind: "done", repos: [] },
} as const;
const askStreamEvent = {
  type: "askStreamEvent",
  reviewId: "rev1",
  event: { kind: "ask-delta", threadId: "t1", turnId: "u1", channel: "orchestrator", delta: "hi" },
} as const;

// Just the surface the red-proof uses: a `.strict()` clone whose parse we probe.
// Structural, so every heterogeneous frame schema satisfies it without `any`.
type StrictCheckable = { strict(): { safeParse(value: unknown): { success: boolean } } };

const frames: [string, StrictCheckable, Record<string, unknown>][] = [
  ["hello", helloFrameSchema, hello],
  ["serverInfo", serverInfoFrameSchema, serverInfo],
  ["request", requestFrameSchema, request],
  ["response", responseFrameSchema, response],
  ["rpcError", rpcErrorFrameSchema, rpcError],
  ["progressEvent", progressEventFrameSchema, progressEvent],
  ["askStreamEvent", askStreamEventFrameSchema, askStreamEvent],
];

describe("session frames", () => {
  // 2.1
  it.each(frames)("%s round-trips through JSON and the frame parser", (_label, _schema, frame) => {
    const roundTripped = parseSessionFrame(JSON.parse(JSON.stringify(frame)));
    expect(roundTripped).toEqual(frame);
  });

  // 2.2 — tolerance is a property of the NON-strict schema. Red-proof: a `.strict()`
  // clone of the same frame schema MUST reject the extra field (prediction named
  // before the assertion runs); the real tolerant schema accepts and strips it.
  it.each(frames)("%s strips an unknown field a strict clone would reject", (_l, schema, frame) => {
    const withExtra = { ...frame, fieldFromANewerPeer: "surprise" };

    // Prediction: strict rejects the unknown key.
    expect(schema.strict().safeParse(withExtra).success).toBe(false);

    // Reality: the tolerant frame parses and the unknown key is gone.
    const parsed = parseSessionFrame(withExtra);
    expect(parsed).not.toHaveProperty("fieldFromANewerPeer");
    expect(parsed).toEqual(frame);
  });

  // 2.4
  it("rejects a request whose command is not in the registry", () => {
    expect(() => parseSessionFrame({ ...request, command: "not.a.real.command" })).toThrow();
    expect(parseSessionFrame(request)).toEqual(request);
  });

  it("rejects malformed push-event payloads", () => {
    expect(() =>
      parseSessionFrame({ type: "progressEvent", commandId: "c", event: { kind: "not-a-real-kind" } }),
    ).toThrow();
    expect(() =>
      parseSessionFrame({
        type: "askStreamEvent",
        reviewId: "r",
        event: { kind: "not-a-real-kind" },
      }),
    ).toThrow();
  });

  // 2.5
  it("accepts both a known rpcError code and a novel string code", () => {
    expect(parseSessionFrame({ ...rpcError, code: "incompatible_protocol" })).toMatchObject({
      code: "incompatible_protocol",
    });
    expect(parseSessionFrame({ ...rpcError, code: "some_future_code" })).toMatchObject({
      code: "some_future_code",
    });
  });
});

describe("checkProtocolCompatibility", () => {
  // 2.3
  it("reports compatible when both peers are the same version", () => {
    expect(
      checkProtocolCompatibility(
        { version: 1, minCompatible: 1 },
        { version: 1, minCompatible: 1 },
      ),
    ).toEqual({
      compatible: true,
    });
  });

  it("reports compatible when a newer peer stays within the older peer's window", () => {
    // mine is newer (v2) but still supports v1; theirs is v1 and supports v1.
    expect(
      checkProtocolCompatibility(
        { version: 2, minCompatible: 1 },
        { version: 1, minCompatible: 1 },
      ),
    ).toEqual({
      compatible: true,
    });
    expect(
      checkProtocolCompatibility(
        { version: 1, minCompatible: 1 },
        { version: 2, minCompatible: 1 },
      ),
    ).toEqual({
      compatible: true,
    });
  });

  it("reports incompatible with a reason when the local peer is too old", () => {
    // local v1 is below the remote's minimum compatible v2.
    const result = checkProtocolCompatibility(
      { version: 1, minCompatible: 1 },
      { version: 3, minCompatible: 2 },
    );
    expect(result.compatible).toBe(false);
    if (result.compatible) throw new Error("unreachable");
    expect(result.reason).toContain("local");
    expect(result.reason).toContain("1");
    expect(result.reason).toContain("2");
  });

  it("reports incompatible with a reason when the remote peer is too old", () => {
    // remote v1 is below the local's minimum compatible v2.
    const result = checkProtocolCompatibility(
      { version: 3, minCompatible: 2 },
      { version: 1, minCompatible: 1 },
    );
    expect(result.compatible).toBe(false);
    if (result.compatible) throw new Error("unreachable");
    expect(result.reason).toContain("remote");
    expect(result.reason).toContain("1");
    expect(result.reason).toContain("2");
  });
});

describe("version constants", () => {
  it("exports the version-window constants at their initial values", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MIN_COMPATIBLE_PROTOCOL_VERSION).toBe(1);
  });
});
