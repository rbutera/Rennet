// The transport-neutral session layer (issue #376, app server wave phase 0).
//
// This is the vocabulary any future transport serializes and nothing else: a
// handshake that exchanges identity and capability, an envelope that correlates
// requests with responses and carries typed errors, and typed server-push event
// frames for the two existing push channels. No transport, server, or dispatch
// change lives here — nothing executes these frames yet.
//
// Wire discipline (see docs `developing/reference/protocol-compatibility`):
// every inbound frame schema is a DEFAULT (non-strict) Zod object, so it strips
// unknown keys rather than rejecting them. A newer peer that adds an optional
// field never breaks an older decoder. This deliberately diverges from the
// `.strict()` habit used for intra-process shapes elsewhere in this package.

import { z } from "zod";
import { isCommandName, projectProcessEventSchema, reviewAskStreamEventSchema } from "./index";

/** The protocol version this build speaks. One integer, bumped append-only. */
export const PROTOCOL_VERSION = 1;
/** The oldest protocol version this build can still talk to. */
export const MIN_COMPATIBLE_PROTOCOL_VERSION = 1;

// ── Handshake ────────────────────────────────────────────────────────────────

/** Client → server: who is connecting and which protocol version it speaks. */
export const helloFrameSchema = z.object({
  type: z.literal("hello"),
  clientId: z.string().min(1),
  clientType: z.string().min(1),
  protocolVersion: z.number().int().positive(),
});

/** Server → client: the server's identity, protocol window, and feature flags. */
export const serverInfoFrameSchema = z.object({
  type: z.literal("serverInfo"),
  /** The server application's own version (e.g. the package semver). */
  version: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  minCompatibleProtocolVersion: z.number().int().positive(),
  /**
   * Open record of capability flags. Free string keys, documented on the
   * protocol-compatibility page as they are added; an enum would make adding a
   * feature a breaking schema change, defeating the point.
   */
  features: z.record(z.string(), z.boolean()),
});

// ── Envelope ─────────────────────────────────────────────────────────────────

/**
 * Client → server: invoke a command. `command` is validated against the
 * existing `commandDefinitions` registry; the `input` payload stays validated by
 * `commandDefinitions[command].input` (single authority), not re-modeled here.
 */
export const requestFrameSchema = z.object({
  type: z.literal("request"),
  requestId: z.string().min(1),
  command: z.string().refine(isCommandName, { message: "unknown command" }),
  input: z.unknown(),
});

/** Server → client: the result for a `request`, correlated by `requestId`. */
export const responseFrameSchema = z.object({
  type: z.literal("response"),
  requestId: z.string().min(1),
  output: z.unknown(),
});

/** The known error codes; the `z.string()` union arm keeps `code` append-only. */
const rpcErrorCodeSchema = z.union([
  z.enum(["invalid_input", "command_failed", "incompatible_protocol", "unknown_command"]),
  z.string(),
]);

/** Server → client: a typed failure for a `request`, correlated by `requestId`. */
export const rpcErrorFrameSchema = z.object({
  type: z.literal("rpcError"),
  requestId: z.string().min(1),
  code: rpcErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});

// ── Server-push events (reuse existing payload types by reference) ────────────

// The payload schemas live in `./index`, which re-exports this module — a cycle.
// `z.lazy` defers reading those bindings until parse time, after `index` has
// finished initializing them, instead of at this module's eval time (when they
// are still in their temporal dead zone and would read as `undefined`).

/** Server → client: live progress for a long-running command, keyed by `commandId`. */
export const progressEventFrameSchema = z.object({
  type: z.literal("progressEvent"),
  commandId: z.string().min(1),
  event: z.lazy(() => projectProcessEventSchema),
});

/** Server → client: a conversation's token stream, keyed by `reviewId`. */
export const askStreamEventFrameSchema = z.object({
  type: z.literal("askStreamEvent"),
  reviewId: z.string().min(1),
  event: z.lazy(() => reviewAskStreamEventSchema),
});

// ── The union + parser ───────────────────────────────────────────────────────

/** Every session frame, discriminated on `type`. */
export const sessionFrameSchema = z.discriminatedUnion("type", [
  helloFrameSchema,
  serverInfoFrameSchema,
  requestFrameSchema,
  responseFrameSchema,
  rpcErrorFrameSchema,
  progressEventFrameSchema,
  askStreamEventFrameSchema,
]);

export type HelloFrame = z.infer<typeof helloFrameSchema>;
export type ServerInfoFrame = z.infer<typeof serverInfoFrameSchema>;
export type RequestFrame = z.infer<typeof requestFrameSchema>;
export type ResponseFrame = z.infer<typeof responseFrameSchema>;
export type RpcErrorFrame = z.infer<typeof rpcErrorFrameSchema>;
export type ProgressEventFrame = z.infer<typeof progressEventFrameSchema>;
export type AskStreamEventFrame = z.infer<typeof askStreamEventFrameSchema>;
export type SessionFrame = z.infer<typeof sessionFrameSchema>;

/** Parse an untrusted value into a `SessionFrame`, throwing on an invalid frame. */
export function parseSessionFrame(value: unknown): SessionFrame {
  return sessionFrameSchema.parse(value);
}

// ── Version window ───────────────────────────────────────────────────────────

/** A peer's protocol version and the oldest version it can still talk to. */
export interface ProtocolVersionPair {
  version: number;
  minCompatible: number;
}

/** The result of a compatibility check: compatible, or a reason it is not. */
export type ProtocolCompatibility = { compatible: true } | { compatible: false; reason: string };

/**
 * Two peers are compatible iff each side's version is at or above the other's
 * minimum compatible version (Orca's version-window model). Symmetric in
 * `mine`/`theirs`; returns a reason naming which side is too old, not a bare
 * boolean, so a caller can surface an honest message.
 */
export function checkProtocolCompatibility(
  mine: ProtocolVersionPair,
  theirs: ProtocolVersionPair,
): ProtocolCompatibility {
  if (mine.version < theirs.minCompatible) {
    return {
      compatible: false,
      reason: `local protocol version ${mine.version} is below the remote minimum compatible version ${theirs.minCompatible}`,
    };
  }
  if (theirs.version < mine.minCompatible) {
    return {
      compatible: false,
      reason: `remote protocol version ${theirs.version} is below the local minimum compatible version ${mine.minCompatible}`,
    };
  }
  return { compatible: true };
}
