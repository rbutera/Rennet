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
import { isCommandName, projectProgressEventSchema, reviewAskStreamEventSchema } from "./index";

/** The protocol version this build speaks. One integer, bumped append-only. */
export const PROTOCOL_VERSION = 1;
/** The oldest protocol version this build can still talk to. */
export const MIN_COMPATIBLE_PROTOCOL_VERSION = 1;

/**
 * The `serverInfo.features` key a daemon sets when it consumes client presence and plans
 * attention (issue #383 M1). A client transmits its `presence` frame and registers a push
 * token ONLY when this flag is advertised; a daemon that predates it never sees either, and
 * the client treats the seam as a no-op (protocol-compatibility: capability-gated, once).
 */
export const ATTENTION_FEATURE = "attention";

/**
 * COMPAT (handshake feature, additive, #382 M2). The `serverInfo.features` key a daemon sets
 * when it wires the M2 acting seams — `review.interrupt` (client Stop) and `publish.compose`
 * (daemon-composed publish preview). A client reads it to render those affordances TRUTHFULLY:
 * against a daemon that predates M2 (never advertises it), the phone shows Stop as visibly
 * disabled and the publish surface as "this daemon needs updating" rather than a control that
 * silently no-ops. Absent ⇒ pre-M2 daemon; the acting commands would be refused as unknown.
 */
export const ACT_FEATURE = "act";

// ── Handshake ────────────────────────────────────────────────────────────────

/** Client → server: who is connecting and which protocol version it speaks. */
export const helloFrameSchema = z.object({
  type: z.literal("hello"),
  clientId: z.string().min(1),
  clientType: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  /**
   * A paired device's long-lived bearer token (issue #380). Optional and
   * append-only: a loopback client omits it (loopback needs no token), and an
   * older decoder that predates this field strips it harmlessly. A non-loopback
   * connection presents it so the listener can classify the connection `projected`.
   */
  deviceToken: z.string().min(1).optional(),
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
 * existing command registry (`commands`); the `input` payload stays validated by
 * `commands[command].args` (single authority), not re-modeled here.
 */
export const requestFrameSchema = z.object({
  type: z.literal("request"),
  requestId: z.string().min(1),
  // Closure (not a bare reference): `session` and `commands` sit in an import cycle
  // through the root seam, so the registry binding resolves at parse time, not here.
  command: z.string().refine((value) => isCommandName(value), { message: "unknown command" }),
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
  event: z.lazy(() => projectProgressEventSchema),
});

/** Server → client: a conversation's token stream, keyed by `reviewId`. */
export const askStreamEventFrameSchema = z.object({
  type: z.literal("askStreamEvent"),
  reviewId: z.string().min(1),
  event: z.lazy(() => reviewAskStreamEventSchema),
});

// ── Server-initiated requests (wire support only, issue #380) ────────────────

// Server→client request/response/cleanup frames, advertised via
// `serverInfo.features.serverRequests`. NO product flow consumes them this phase
// (proposal §4): they pin the wire contract a future client's turn-asks build
// against, so the shapes are additive-append-only from day one. The listener owns
// correlation by `serverRequestId`; the client bridge answers with `serverResponse`;
// `serverRequestResolved` tells a client to drop a still-pending prompt (turn ended
// or the asker disconnected) so no client shows a stale question.

/** Server → client: ask this connection something, correlated by `serverRequestId`. */
export const serverRequestFrameSchema = z.object({
  type: z.literal("serverRequest"),
  serverRequestId: z.string().min(1),
  kind: z.string().min(1),
  payload: z.unknown(),
});

/** Client → server: the answer to a `serverRequest`, correlated by `serverRequestId`. */
export const serverResponseFrameSchema = z.object({
  type: z.literal("serverResponse"),
  serverRequestId: z.string().min(1),
  payload: z.unknown(),
});

/** Server → client: drop a still-pending `serverRequest` (resolved or asker gone). */
export const serverRequestResolvedFrameSchema = z.object({
  type: z.literal("serverRequestResolved"),
  serverRequestId: z.string().min(1),
});

// ── Presence (client → server, issue #383 M1) ────────────────────────────────

// A shell reports focus/visibility/device-class so the daemon's attention planner
// decides in-app-vs-push per client (mobile plan; ideation notification taxonomy). It
// is additive-append-only: a client sends it ONLY when the daemon advertised the
// `attention` feature (protocol-compatibility gating), and a daemon that predates the
// feature strips it harmlessly (non-strict decoder). `focusedReviewId` is the review the
// shell is looking at right now, so a review that finishes while its viewer is focused
// gets the live event and no push; absent means no review is in focus.
/** Client → server: this client's presence for delivery planning. */
export const presenceFrameSchema = z.object({
  type: z.literal("presence"),
  focused: z.boolean(),
  visible: z.boolean(),
  deviceClass: z.string().min(1),
  /** The review the shell is focused on, if any (drives focused-client push suppression). */
  focusedReviewId: z.string().min(1).optional(),
});

// ── Attention (server → client, issue #383 M1) ───────────────────────────────

// The daemon broadcasts an attention RAISE or CLEAR to every authorized socket so a
// focused client gets the live in-app event (the push planner suppresses its push) and,
// on acknowledgment, every client's needs-you badge clears together (attention-notifications
// spec: "handled once, quiet everywhere"). Additive-append-only and feature-gated on
// `attention`: a daemon that predates the feature never sends it, and an older client
// strips it. The taxonomy families and deep-link paths are the planner's; the frame is
// their wire form. Deltas/asks keep their own frames — this is the attention layer only.
/** The closed six-family attention taxonomy (exported so command inputs reuse the exact enum). */
export const attentionFamilySchema = z.enum([
  "ask-pending",
  "review-finished",
  "turn-failed",
  "handoff-completed",
  "publish-ready",
  "processing-finished",
]);
export type AttentionFamily = z.infer<typeof attentionFamilySchema>;

/**
 * A shade answer action carried on an ask-pending attention (issue #382 M2, additive). Each is
 * one answer chip the app renders and the OS notification registers as an action: `id` is the
 * stable action identifier, `label` is the chip text AND the seed of the composed `review.ask`
 * reply (the app composes `label` + newline + optional free-text direction into one reply — the
 * "decision plus direction" shape). Populated at the raise site when a turn surfaces answer
 * options; absent ⇒ the ask is answered by free-text alone (still one reply, spec-compliant).
 */
export const attentionActionSchema = z.object({
  // Bounded (#382 M2 finding 11): an id/label that is unbounded could bloat a push payload or a
  // notification button. 64/60 chars are comfortably above any real chip and cheap to enforce.
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(60),
});
export type AttentionAction = z.infer<typeof attentionActionSchema>;

/** The most answer actions a single ask push carries (#382 M2 finding 11) — a shade with more
 *  buttons than this is malformed, not a richer ask. */
export const MAX_ATTENTION_ACTIONS = 4;

/** One active attention item, as the client pins and later clears it. */
export const attentionItemSchema = z
  .object({
    id: z.string().min(1),
    family: attentionFamilySchema,
    reviewId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    /** Daemon-relative `rennet://…` deep-link the client lands on. */
    deepLink: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    /**
     * COMPAT (attention, additive, #382 M2): answer chips for an ask-pending item — the shade
     * actions the app registers so a lock-screen ask is answerable WITHOUT opening the app. Absent
     * on every non-ask family and on any daemon that predates this field (stripped harmlessly by the
     * non-strict decoder). A high-priority ask always reaches every client; the actions only add the
     * quick-answer affordance on top.
     */
    actions: z.array(attentionActionSchema).max(MAX_ATTENTION_ACTIONS).optional(),
  })
  // Refined attention item (#382 M2 finding 11): `actions` belong ONLY to an ask-pending item (a
  // publish-ready or review-finished push has nothing to quick-answer), and their ids must be
  // unique so a tapped action resolves to exactly one chip. A malformed item is rejected at parse,
  // so the app never renders a fabricated or ambiguous chip.
  .superRefine((item, ctx) => {
    if (item.actions === undefined) return;
    if (item.family !== "ask-pending") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "actions are only valid on an ask-pending attention item",
        path: ["actions"],
      });
    }
    const ids = item.actions.map((action) => action.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "answer action ids must be unique",
        path: ["actions"],
      });
    }
  });
export type AttentionItem = z.infer<typeof attentionItemSchema>;

/** Server → client: an attention item was raised, or one/more were cleared. */
export const attentionEventFrameSchema = z
  .object({
    type: z.literal("attentionEvent"),
    /** `raised` carries `item`; `cleared` carries the ids that are no longer demanding attention. */
    event: z.enum(["raised", "cleared"]),
    item: attentionItemSchema.optional(),
    clearedIds: z.array(z.string().min(1)).optional(),
  })
  // A `raised` frame MUST carry its item and a `cleared` frame MUST carry a non-empty id list —
  // the payload each arm reads. Guards a malformed peer from a half-formed attention update.
  .refine(
    (f) =>
      f.event === "raised"
        ? f.item !== undefined && f.clearedIds === undefined
        : f.clearedIds !== undefined && f.clearedIds.length > 0 && f.item === undefined,
    {
      message:
        "attentionEvent: `raised` requires `item`; `cleared` requires non-empty `clearedIds`",
    },
  );

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
  serverRequestFrameSchema,
  serverResponseFrameSchema,
  serverRequestResolvedFrameSchema,
  presenceFrameSchema,
  attentionEventFrameSchema,
]);

export type HelloFrame = z.infer<typeof helloFrameSchema>;
export type ServerInfoFrame = z.infer<typeof serverInfoFrameSchema>;
export type RequestFrame = z.infer<typeof requestFrameSchema>;
export type ResponseFrame = z.infer<typeof responseFrameSchema>;
export type RpcErrorFrame = z.infer<typeof rpcErrorFrameSchema>;
export type ProgressEventFrame = z.infer<typeof progressEventFrameSchema>;
export type AskStreamEventFrame = z.infer<typeof askStreamEventFrameSchema>;
export type ServerRequestFrame = z.infer<typeof serverRequestFrameSchema>;
export type ServerResponseFrame = z.infer<typeof serverResponseFrameSchema>;
export type ServerRequestResolvedFrame = z.infer<typeof serverRequestResolvedFrameSchema>;
export type PresenceFrame = z.infer<typeof presenceFrameSchema>;
export type AttentionEventFrame = z.infer<typeof attentionEventFrameSchema>;
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
