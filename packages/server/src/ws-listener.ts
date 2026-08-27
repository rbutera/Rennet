// The WebSocket transport (issue #378, extended for the remote surface #380). The
// server speaks the phase-0 session envelope (protocol/session.ts) as JSON text
// frames. Loopback connections keep the PRIVATE contract byte-for-byte — parse a
// frame → route a `request` to the SAME in-process `dispatch` → serialize the result.
//
// #380 adds three things, all confined to NON-loopback connections so the existing
// desktop app is untouched:
//   • Connection classes, decided once at `hello` (design D1): `private` (loopback,
//     no token), `projected` (non-loopback + a valid device token — every frame runs
//     through the R19 projection codec), or `pairing-only` (non-loopback, no/invalid
//     token — may invoke ONLY `pairing.exchange`).
//   • Opt-in bind beyond loopback (`daemon.listen`) with a Host-header allowlist
//     (DNS-rebinding guard) that refuses a foreign Host before the WS upgrade.
//   • Server-initiated request frames (wire support only): `askConnection()` asks one
//     connection and cleans up on resolution or disconnect. No product flow uses it yet.

import { randomUUID } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { extname, normalize, resolve, sep } from "node:path";
import type {
  AttentionItem,
  BoardEventFrame,
  CommandName,
  ProjectProcessEvent,
  ProjectProgressEvent,
  ReviewAskStreamEvent,
  SessionFrame,
} from "@rennet/protocol";
import {
  ACT_FEATURE,
  ATTENTION_FEATURE,
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  parseSessionFrame,
} from "@rennet/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import {
  AttentionRegistry,
  type ConnectedClient,
  type PresenceState,
  planDelivery,
  type RaisedAttention,
} from "./attention-planner";
import {
  type ExpoPushMessage,
  type ExpoReceiptHandle,
  pollExpoReceipts,
  sendExpoPushes,
} from "./expo-push";
import {
  buildProjectionContext,
  type ProjectionContext,
  ProjectionResolveError,
  projectBoardEvent,
  projectCommandOutput,
  projectProgressEvent,
  redactAbsolutePaths,
  redactAbsolutePathsDeep,
  resolveCommandInput,
  scrubProjectedValue,
  scrubRoots,
} from "./projection";
import type { PushRegistration } from "./push-token-store";

/** The dispatch surface the transport routes to — the exact shape createDispatch returns. */
type Dispatch = (
  name: CommandName,
  input: unknown,
  ctx?: {
    emitProgress?(event: ProjectProgressEvent): void;
    progressRecipientId?: string | number;
    emitAskStream?(event: ReviewAskStreamEvent): void;
    /** The authenticated device id for a projected connection (#383 M1: `device.registerPush`). */
    deviceId?: string;
  },
) => Promise<unknown>;

export interface WsListenerDeps {
  /** The command router; a `request` frame becomes exactly this call. */
  readonly dispatch: Dispatch;
  /** The server application's own version, surfaced in the `serverInfo` handshake frame. */
  readonly serverVersion: string;
  /**
   * Verify a presented device token → truthy for a paired device, null otherwise
   * (issue #380). Absent ⇒ no device is ever paired, so every non-loopback
   * connection is `pairing-only`. Loopback ignores it entirely.
   */
  readonly verifyDeviceToken?: (rawToken: string) => unknown;
  /**
   * Build the current R19 projection context (repo roots + home dir). Called per
   * request/broadcast so a newly-added project is referenceable immediately. Absent
   * ⇒ an empty context (only meaningful when nothing binds beyond loopback).
   */
  readonly projectionContext?: () => ProjectionContext;
  /** Opt-in bind beyond loopback (design D6). Default: `127.0.0.1` on an ephemeral port. */
  readonly listen?: { readonly host: string; readonly port?: number };
  /**
   * Directory of a built browser UI to serve over the HTTP port (issue #381, design D2).
   * Absent ⇒ the daemon runs headless (serving is a capability, not a requirement). Every
   * asset is served with a path-traversal guard; `/` maps to `index.html`.
   */
  readonly uiDist?: string;
  /**
   * The attention system (issue #383 M1). Present ⇒ the daemon advertises the `attention`
   * feature, accepts client `presence` frames, and delivers attention events presence-aware
   * (a focused client gets the live in-app frame; every other registered device gets a push).
   * Absent ⇒ M0 behaviour unchanged: no `attention` flag, presence frames ignored, no pushes.
   */
  readonly attention?: AttentionDeps;
  /**
   * Whether this daemon wires the M2 acting seams (`review.interrupt`, `publish.compose`).
   * Present ⇒ the daemon advertises the `act` feature so a client renders Stop and the publish
   * surface truthfully; absent ⇒ pre-M2, and those affordances show disabled / needs-updating
   * rather than silently no-opping (issue #382 M2, Finding A + Finding C).
   */
  readonly act?: boolean;
}

/** Default delay before the single post-send receipt poll (#383 batch). */
const RECEIPT_POLL_DELAY_MS = 15_000;

/** The attention wiring the listener needs to plan and post pushes (issue #383 M1). */
export interface AttentionDeps {
  /** The registered push tokens (planner input) and dead-token cleanup. */
  readonly pushTokens: {
    list(): PushRegistration[];
    delete(deviceId: string): void;
  };
  /** Post pushes (default: the real Expo egress). Injected as a stub in tests. */
  readonly sendPush?: typeof sendExpoPushes;
  /** Poll delivery receipts (default: the real Expo poll). Injected as a stub in tests. */
  readonly pollReceipts?: typeof pollExpoReceipts;
  /**
   * Delay before the single post-send receipt poll (#383 batch). Default ~15s (receipts settle
   * after the service tries the device); tests pass 0 for an immediate poll.
   */
  readonly receiptPollDelayMs?: number;
  /** Non-fatal egress error sink (logging only). */
  readonly onEgressError?: (error: unknown) => void;
}

/** Content types for the assets a Vite browser bundle emits; anything else is octet-stream. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Serve one static asset from `uiDist` (design D2). GET/HEAD only; `/` → `index.html`. The
 * traversal guard is the desktop app-protocol handler's, ported: resolve the request under
 * the root and refuse anything that escapes it. Returns true once it has written a response
 * (found or a 404), false when the caller should fall through (never — this always answers).
 */
async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  const notFound = (): void => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  };
  const rawPath = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const requested = rawPath === "/" ? "/index.html" : rawPath;
  const target = resolve(root, `.${normalize(requested)}`);
  if (target !== root && !target.startsWith(root + sep)) return notFound();
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(target);
  } catch {
    return notFound();
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return notFound();
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(realTarget);
  } catch {
    return notFound();
  }
  if (!fileStat.isFile()) return notFound();
  const contentType =
    CONTENT_TYPES[extname(realTarget).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = { "content-type": contentType };
  // The entry document must never be cached: a redeploy changes the hashed asset names it
  // points at, and a stale index.html would reference assets that no longer exist.
  if (requested === "/index.html") headers["cache-control"] = "no-cache";
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  createReadStream(realTarget).pipe(res);
}

/** The daemon identity `GET /healthz` returns and a launcher probes before connecting (#379). */
export const daemonIdentitySchema = z.object({
  pid: z.number().int().positive(),
  wsPort: z.number().int().positive(),
  /** The bound host (#380). Optional/append-only: absent ⇒ loopback `127.0.0.1`. */
  host: z.string().optional(),
  version: z.string(),
  protocolVersion: z.number().int().nonnegative(),
  minCompatibleProtocolVersion: z.number().int().nonnegative(),
});

export type DaemonIdentity = z.infer<typeof daemonIdentitySchema>;

export interface WsListener {
  /** The port the listener bound; the desktop injects it into the renderer. */
  readonly port: number;
  /** The host the listener bound (`127.0.0.1` by default, or the configured `daemon.listen.host`). */
  readonly host: string;
  /** Fan a rehydration/background progress event out to every connected socket (projected per connection class). */
  broadcastProgress(commandId: string, event: ProjectProcessEvent): void;
  /**
   * Fan newly appended board events out to every authorized socket (B4 broadcast).
   * `private` (loopback) sockets receive the raw events; `projected` sockets receive
   * the privacy-wrapped variant (`projectBoardEvent`); `pairing-only` is excluded.
   */
  broadcastBoardEvent(boardId: string, events: BoardEventFrame["events"]): void;
  /**
   * Ask ONE connection a question and resolve with its answer (issue #380, wire only).
   * Rejects if the connection is unknown or drops before answering. A `serverRequestResolved`
   * frame is sent to the connection on resolution or rejection so it never shows a stale prompt.
   */
  askConnection(connectionId: string, kind: string, payload: unknown): Promise<unknown>;
  /**
   * Raise an attention event (issue #383 M1). Registers it, broadcasts the live in-app frame
   * to every authorized socket, and posts a push to every registered device NOT connected-and-
   * focused on the affected review. A no-op if the attention system is not wired. Returns the
   * stored item (with its id) or null when attention is off.
   */
  raiseAttention(event: RaisedAttention): AttentionItem | null;
  /**
   * Acknowledge (clear) attention on view (issue #383 M1). Clears matching items and broadcasts
   * the clear to every authorized socket so a handled item goes quiet everywhere. Returns the
   * number cleared (0 when attention is off or nothing matched).
   */
  acknowledgeAttention(selector: { reviewId?: string; attentionId?: string }): number;
  /** The attention items still active (a fresh client hydrates its needs-you set from these). */
  activeAttention(): AttentionItem[];
  /**
   * Drop every live connection authenticated as this device (#383 batch): revoking a device's
   * pairing must sever its in-flight sockets, not just future handshakes — a live projected
   * socket cannot outlive the pairing it was authorized by. Returns how many were closed.
   */
  disconnectDevice(deviceId: string): number;
  /** Close every socket and the HTTP listener. Resolves once the listener is fully down. */
  close(): Promise<void>;
}

/** Read a string field off an unknown command input without trusting its shape. */
function inputString(input: unknown, key: string): string | undefined {
  if (input && typeof input === "object") {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Read a `deviceId` off whatever `verifyDeviceToken` returned (a `PairedDevice`), if present. */
function readDeviceId(device: unknown): string | undefined {
  if (device && typeof device === "object") {
    const value = (device as Record<string, unknown>).deviceId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Best-effort requestId salvage from a frame that failed schema validation, for a correlated error. */
function salvageRequestId(raw: unknown): string {
  if (raw && typeof raw === "object") {
    const value = (raw as Record<string, unknown>).requestId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "unknown";
}

function errorDetails(error: unknown): unknown {
  if (error && typeof error === "object" && "details" in error) {
    return (error as { details?: unknown }).details;
  }
  return undefined;
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Is a socket's remote address the loopback interface? Loopback connections stay on the private contract. */
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return LOOPBACK_ADDRESSES.has(address) || address.startsWith("127.");
}

/** A bare IPv4/IPv6 literal (not a DNS name). Loose but sufficient: it only needs to reject hostnames. */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/**
 * The Host-header allowlist for a non-loopback bind (design D6, DNS-rebinding guard).
 * A DNS-rebinding attack always presents a hostNAME (the attacker's domain), never a
 * raw IP, so allowing IP-literal Host headers is safe and is what lets a remote client
 * reach a `0.0.0.0` / specific-IP bind by address. A hostname is allowed only when it
 * exactly matches the configured host, or is localhost.
 */
function isHostAllowed(hostHeader: string | undefined, listenHost: string): boolean {
  if (!hostHeader) return false;
  // Strip the port; IPv6 literals arrive bracketed as `[::1]:port`.
  const host = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : (hostHeader.split(":")[0] ?? "");
  if (host === "localhost" || host === listenHost) return true;
  return isIpLiteral(host);
}

type ConnectionClass = "private" | "projected" | "pairing-only";

interface ServerRequestPending {
  readonly resolve: (payload: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface Connection {
  readonly socket: WebSocket;
  readonly connectionId: string;
  helloReceived: boolean;
  connectionClass: ConnectionClass;
  /** The authenticated device id (projected connections only) — the push-token key (#383 M1). */
  deviceId?: string;
  /** The last presence this connection reported, or undefined until it does (⇒ away for delivery). */
  presence?: PresenceState;
  /** Pending server→client asks on THIS connection, keyed by `serverRequestId`. */
  readonly serverRequests: Map<string, ServerRequestPending>;
}

/** Start the WS listener. Binds `127.0.0.1:0` by default, or `deps.listen` when set; resolves once listening. */
export async function startWsListener(deps: WsListenerDeps): Promise<WsListener> {
  const { dispatch, serverVersion } = deps;
  const listenHost = deps.listen?.host ?? "127.0.0.1";
  const listenPort = deps.listen?.port ?? 0;
  const root = deps.uiDist ? resolve(deps.uiDist) : undefined;
  const nonLoopbackBind = !isLoopbackAddress(listenHost) && listenHost !== "localhost";
  const home = homedir();
  const attentionRegistry = new AttentionRegistry();
  // Pending receipt-poll timers (#383 batch), cleared on close so a poll never fires after
  // shutdown against a closed store.
  const receiptTimers = new Set<ReturnType<typeof setTimeout>>();
  const contextOf = (): ProjectionContext => {
    const base = deps.projectionContext?.() ?? buildProjectionContext([], home);
    // COMPAT (#383): a daemon that runs the attention system advertises the summary on projected
    // reviews; one that does not omits it, so old clients and pre-attention daemons interoperate.
    return deps.attention
      ? { ...base, reviewNeedsYou: (reviewId) => attentionRegistry.needsYou(reviewId) }
      : base;
  };

  const connections = new Set<Connection>();
  const byId = new Map<string, Connection>();
  // Per-review monotonic ask-stream seq (#382 M2 finding 5): the last seq broadcast for a review,
  // stamped on every outgoing ask-stream event so the client reducer can reject a re-delivered one.
  const askSeqByReview = new Map<string, number>();
  let boundPort = 0;

  const httpServer: HttpServer = createServer((req, res) => {
    // For a non-loopback bind, refuse a foreign Host before doing anything (DNS-rebinding guard).
    if (nonLoopbackBind && !isHostAllowed(req.headers.host, listenHost)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden host");
      return;
    }
    if (req.method === "GET" && (req.url === "/healthz" || req.url?.startsWith("/healthz?"))) {
      const identity: DaemonIdentity = {
        pid: process.pid,
        wsPort: boundPort,
        host: listenHost,
        version: serverVersion,
        protocolVersion: PROTOCOL_VERSION,
        minCompatibleProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(identity));
      return;
    }
    // The served browser UI (design D2), slotted before the 404. GET/HEAD only; a missing
    // asset answers 404 from within. Absent uiDist ⇒ the daemon is headless and falls through.
    if (root && (req.method === "GET" || req.method === "HEAD")) {
      void serveStatic(req, res, root).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("internal error");
        }
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  const verifyClient: WebSocket.VerifyClientCallbackAsync | undefined = nonLoopbackBind
    ? (info, callback) => {
        if (isHostAllowed(info.req.headers.host, listenHost)) callback(true);
        else callback(false, 403, "Forbidden");
      }
    : undefined;
  const wss = new WebSocketServer({
    server: httpServer,
    // Refuse a foreign Host at the WS upgrade too (only enforced for a non-loopback bind).
    verifyClient,
  });

  const send = (socket: WebSocket, frame: SessionFrame): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    const connectionId = randomUUID();
    const loopback = isLoopbackAddress(req.socket.remoteAddress ?? undefined);
    const connection: Connection = {
      socket,
      connectionId,
      helloReceived: false,
      connectionClass: "private",
      serverRequests: new Map(),
    };
    connections.add(connection);
    byId.set(connectionId, connection);

    const runRequest = async (
      requestId: string,
      command: CommandName,
      input: unknown,
    ): Promise<void> => {
      const projected = connection.connectionClass === "projected";
      const ctx = projected ? contextOf() : null;
      let effectiveInput = input;
      if (ctx) {
        try {
          effectiveInput = resolveCommandInput(command, input, ctx);
        } catch (error) {
          const message = error instanceof ProjectionResolveError ? error.message : String(error);
          const details = errorDetails(error);
          send(socket, {
            type: "rpcError",
            requestId,
            code: "invalid_input",
            message: scrubRoots(message, ctx),
            ...(details === undefined ? {} : { details: scrubProjectedValue(details, ctx) }),
          });
          return;
        }
      }
      const commandId = inputString(effectiveInput, "commandId");
      const reviewId = inputString(effectiveInput, "reviewId");
      const emitProgress = commandId
        ? (event: ProjectProgressEvent): void =>
            send(socket, {
              type: "progressEvent",
              commandId,
              event: ctx ? projectProgressEvent(event, ctx) : event,
            })
        : undefined;
      // Ask-stream deltas BROADCAST to every live authorized socket by `reviewId`
      // (issue #389 server half), mirroring `broadcastProgress`. Closing over the
      // invoking socket dropped the live stream after a mid-turn reconnect — the turn
      // survives in main, but its deltas kept firing at the dead socket. Broadcasting
      // means the reconnected socket (a fresh connection) receives them, and the client
      // filters by its `onAskStream(reviewId)` listener exactly as it filters progress.
      // Deltas are model-authored prose — NOT projected (R31/R32 honesty) — so the raw
      // event goes to private and projected connections alike.
      const emitAskStream = reviewId
        ? (event: ReviewAskStreamEvent): void => broadcastAskStream(reviewId, event)
        : undefined;
      try {
        const output = await dispatch(command, effectiveInput, {
          emitProgress,
          progressRecipientId: connectionId,
          emitAskStream,
          deviceId: connection.deviceId,
        });
        send(socket, {
          type: "response",
          requestId,
          output: ctx ? projectCommandOutput(command, output, ctx) : output,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const details = errorDetails(error);
        send(socket, {
          type: "rpcError",
          requestId,
          code: "command_failed",
          // Projected errors: scrub known roots/home, THEN redact any absolute path the
          // substitution missed (a `/var/…` / `C:\…` outside every known root), so a raw host
          // path never reaches a projected client (#382 M2 finding 8).
          message: ctx ? redactAbsolutePaths(scrubRoots(message, ctx)) : message,
          ...(details === undefined
            ? {}
            : { details: ctx ? redactAbsolutePathsDeep(details, ctx) : details }),
        });
      }
    };

    const handleFrame = (frame: SessionFrame): void => {
      switch (frame.type) {
        case "hello": {
          if (connection.helloReceived) {
            send(socket, {
              type: "rpcError",
              requestId: frame.clientId,
              code: "invalid_input",
              message: "hello handshake already completed",
            });
            return;
          }
          if (frame.protocolVersion < MIN_COMPATIBLE_PROTOCOL_VERSION) {
            send(socket, {
              type: "rpcError",
              requestId: frame.clientId,
              code: "incompatible_protocol",
              message: `client protocol version ${frame.protocolVersion} is below the server minimum ${MIN_COMPATIBLE_PROTOCOL_VERSION}`,
            });
            return;
          }
          // Classify ONCE (design D1): loopback → private; else a PRESENTED token is verified
          // (valid → projected; invalid → terminal auth rejection, below); else no token →
          // pairing-only (may invoke only `pairing.exchange`, so a device with no token can
          // pair). The present-but-REJECTED case (issue #383) must NOT silently fall to
          // pairing-only and complete the handshake: that reads to the client as `online`,
          // hiding a bad/revoked token behind a healthy-looking connection. Instead we send an
          // `unauthorized` rpcError correlated to the hello and close — the client surfaces a
          // terminal `error`. To re-pair, a device reconnects WITHOUT the rejected token.
          if (loopback) {
            connection.connectionClass = "private";
          } else if (frame.deviceToken) {
            const device = deps.verifyDeviceToken?.(frame.deviceToken);
            if (device) {
              connection.connectionClass = "projected";
              // Capture the authenticated device id so `device.registerPush` keys its token by
              // it and the planner can suppress a focused device's push (#383 M1).
              connection.deviceId = readDeviceId(device);
            } else {
              send(socket, {
                type: "rpcError",
                requestId: frame.clientId,
                code: "unauthorized",
                message: "device token rejected",
              });
              socket.close();
              return;
            }
          } else {
            connection.connectionClass = "pairing-only";
          }
          connection.helloReceived = true;
          send(socket, {
            type: "serverInfo",
            version: serverVersion,
            protocolVersion: PROTOCOL_VERSION,
            minCompatibleProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
            // `attention` advertised only when the daemon wires the attention system, so an
            // M0-era build never advertises it and no client sends presence / registers a push.
            features: {
              serverRequests: true,
              ...(deps.attention ? { [ATTENTION_FEATURE]: true } : {}),
              ...(deps.act ? { [ACT_FEATURE]: true } : {}),
            },
          });
          // Connect-time replay (#383 batch): hand THIS newly authorized socket the outstanding
          // attention set as live `raised` frames, so a cold-open client's needs-you badges are
          // truthful from the first paint — an ask pending since before the client launched pins
          // without waiting for a new event. Live frames only; no pushes, presence untouched.
          if (deps.attention && connection.connectionClass !== "pairing-only") {
            for (const item of attentionRegistry.active())
              send(socket, { type: "attentionEvent", event: "raised", item });
          }
          return;
        }
        case "request": {
          if (!connection.helloReceived) {
            send(socket, {
              type: "rpcError",
              requestId: frame.requestId,
              code: "invalid_input",
              message: "hello handshake required before a request",
            });
            return;
          }
          // A pairing-only connection may invoke exactly one command: the pairing exchange.
          if (
            connection.connectionClass === "pairing-only" &&
            frame.command !== "pairing.exchange"
          ) {
            send(socket, {
              type: "rpcError",
              requestId: frame.requestId,
              code: "invalid_input",
              message: "this connection must pair first: only pairing.exchange is available",
            });
            return;
          }
          void runRequest(frame.requestId, frame.command as CommandName, frame.input);
          return;
        }
        case "serverResponse": {
          // The answer to a server→client ask (wire support only). Resolve + clean up.
          const pending = connection.serverRequests.get(frame.serverRequestId);
          if (pending) {
            connection.serverRequests.delete(frame.serverRequestId);
            send(socket, {
              type: "serverRequestResolved",
              serverRequestId: frame.serverRequestId,
            });
            pending.resolve(frame.payload);
          }
          return;
        }
        case "presence": {
          // Accepted ONLY when the daemon advertised `attention` (spec: capability-gated).
          // A client that never sends it is treated as away by the planner (undefined presence).
          if (!deps.attention) return;
          connection.presence = {
            focused: frame.focused,
            visible: frame.visible,
            deviceClass: frame.deviceClass,
            ...(frame.focusedReviewId ? { focusedReviewId: frame.focusedReviewId } : {}),
          };
          return;
        }
        // response/rpcError/progress/askStream/serverRequest/resolved/attentionEvent are
        // server→client; ignore them inbound.
        default:
          return;
      }
    };

    socket.on("message", (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(typeof data === "string" ? data : data.toString());
      } catch {
        send(socket, {
          type: "rpcError",
          requestId: "unknown",
          code: "invalid_input",
          message: "malformed JSON frame",
        });
        return;
      }
      let frame: SessionFrame;
      try {
        frame = parseSessionFrame(raw);
      } catch {
        send(socket, {
          type: "rpcError",
          requestId: salvageRequestId(raw),
          code: "invalid_input",
          message: "frame failed session-envelope validation",
        });
        return;
      }
      handleFrame(frame);
    });

    const drop = (): void => {
      connections.delete(connection);
      byId.delete(connectionId);
      // Reject any pending server→client asks — the connection is gone.
      for (const [, pending] of connection.serverRequests) {
        pending.reject(new Error("connection closed before answering"));
      }
      connection.serverRequests.clear();
    };
    socket.on("close", drop);
    socket.on("error", drop);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(listenPort, listenHost, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("WS listener bound without a numeric port");
  }
  boundPort = address.port;

  const broadcastProgress = (commandId: string, event: ProjectProcessEvent): void => {
    // Serialize once per class: private sockets get the raw event, projected sockets the projection.
    const rawPayload = JSON.stringify({
      type: "progressEvent",
      commandId,
      event,
    } satisfies SessionFrame);
    let projectedPayload: string | null = null;
    for (const connection of connections) {
      if (connection.socket.readyState !== WebSocket.OPEN) continue;
      if (!connection.helloReceived || connection.connectionClass === "pairing-only") continue;
      if (connection.connectionClass === "projected") {
        if (projectedPayload === null) {
          projectedPayload = JSON.stringify({
            type: "progressEvent",
            commandId,
            event: projectProgressEvent(event, contextOf()),
          } satisfies SessionFrame);
        }
        connection.socket.send(projectedPayload);
      } else if (connection.connectionClass === "private") {
        connection.socket.send(rawPayload);
      }
    }
  };

  // B4 broadcast: newly appended board events ride the same fan-out as `broadcastProgress` —
  // serialize once per class, raw to private (loopback) sockets, `projectBoardEvent`-wrapped
  // to projected ones, `pairing-only` excluded. Fed by the boards runtime's append hook
  // (the store is the single write choke point), so every accepted op reaches live clients.
  const broadcastBoardEvent = (boardId: string, events: BoardEventFrame["events"]): void => {
    if (events.length === 0) return;
    const rawPayload = JSON.stringify({
      type: "boardEvent",
      boardId,
      events,
    } satisfies SessionFrame);
    let projectedPayload: string | null = null;
    for (const connection of connections) {
      if (connection.socket.readyState !== WebSocket.OPEN) continue;
      if (!connection.helloReceived || connection.connectionClass === "pairing-only") continue;
      if (connection.connectionClass === "projected") {
        if (projectedPayload === null) {
          const ctx = contextOf();
          projectedPayload = JSON.stringify({
            type: "boardEvent",
            boardId,
            events: events.map(
              (event) => projectBoardEvent(event, ctx) as BoardEventFrame["events"][number],
            ),
          } satisfies SessionFrame);
        }
        connection.socket.send(projectedPayload);
      } else if (connection.connectionClass === "private") {
        connection.socket.send(rawPayload);
      }
    }
  };

  // Broadcast a review's ask-stream delta to every live authorized socket by `reviewId`
  // (issue #389 server half). This is the read-side twin of `broadcastProgress`, and it is
  // what lets a mid-turn reconnect keep the live stream flowing to the fresh socket.
  //
  // Why broadcasting to all authorized sockets is correct here, NOT a cross-client leak
  // (reviewed, #383): Rennet is single-user — every authorized socket is the same person's
  // paired device, and a device token is a full peer within its locus (Rule Zero), so a
  // phone watching a turn the desktop started is the phase-6 feature, not a leak.
  // `ReviewAskStreamEvent` carries NO structural path fields (verified against the schema:
  // ids, an anchor string, channel, model, and prose — nothing R19 would project), and the
  // pre-fix path already sent the raw event to a projected invoker, so shapes are unchanged.
  // `pairing-only` (no valid token) is excluded, exactly as `broadcastProgress` excludes it.
  // Per-review subscription routing and bandwidth filtering arrive with the presence phase.
  const broadcastAskStream = (reviewId: string, event: ReviewAskStreamEvent): void => {
    // Stamp a per-review MONOTONIC seq (#382 M2 finding 5) at this single choke point so every
    // emitted event carries one, regardless of which socket triggered the turn. The reducer
    // rejects an already-applied seq, making the append-not-idempotent `ask-delta` safe under a
    // reconnect that re-delivers. A never-shrinking counter per review; process-lifetime memory.
    const seq = (askSeqByReview.get(reviewId) ?? 0) + 1;
    askSeqByReview.set(reviewId, seq);
    const payload = JSON.stringify({
      type: "askStreamEvent",
      reviewId,
      event: { ...event, seq },
    } satisfies SessionFrame);
    for (const connection of connections) {
      if (connection.socket.readyState !== WebSocket.OPEN) continue;
      if (!connection.helloReceived || connection.connectionClass === "pairing-only") continue;
      connection.socket.send(payload);
    }
  };

  /** Send an attention frame to every authorized (helloReceived, non-pairing-only) socket. */
  const broadcastAttention = (frame: SessionFrame): void => {
    const payload = JSON.stringify(frame);
    for (const connection of connections) {
      if (connection.socket.readyState !== WebSocket.OPEN) continue;
      if (!connection.helloReceived || connection.connectionClass === "pairing-only") continue;
      connection.socket.send(payload);
    }
  };

  /** The current authorized connections as planner inputs (connectionId + device + presence). */
  const connectedClients = (): ConnectedClient[] => {
    const clients: ConnectedClient[] = [];
    for (const connection of connections) {
      if (!connection.helloReceived || connection.connectionClass === "pairing-only") continue;
      clients.push({
        connectionId: connection.connectionId,
        ...(connection.deviceId ? { deviceId: connection.deviceId } : {}),
        ...(connection.presence ? { presence: connection.presence } : {}),
      });
    }
    return clients;
  };

  const raiseAttention = (event: RaisedAttention): AttentionItem | null => {
    const attention = deps.attention;
    if (!attention) return null;
    const { item, changed } = attentionRegistry.raiseIfChanged(event);
    // Suppress a redundant refresh (#382 M2 finding 10): an identical item is already active (e.g.
    // publish.compose re-raising publish-ready on every preview re-render), so re-broadcasting and
    // re-pushing would re-buzz a device for a state it already holds. Nothing changed ⇒ nothing to
    // deliver; the item stays active for a fresh client to hydrate.
    if (!changed) return item;
    // Live in-app: every authorized socket gets the raised frame (its needs-you badge appears).
    broadcastAttention({ type: "attentionEvent", event: "raised", item });
    // Push: every registered device NOT connected-and-focused on this review (planner decision).
    const registrations = attention.pushTokens.list();
    const plan = planDelivery(item, connectedClients(), registrations);
    if (plan.push.length > 0) {
      // The ask category id must match the app's `askCategoryId(reviewId)` = `ask:${reviewId}`, so
      // the shade renders the chips this push carries as notification actions (#382 M2).
      const categoryId =
        item.family === "ask-pending" && item.actions && item.reviewId
          ? `ask:${item.reviewId}`
          : undefined;
      const messages: ExpoPushMessage[] = plan.push.map((registration) => ({
        to: registration.token,
        title: item.title,
        body: item.body,
        // The app maps `deviceId` back to the delivering daemon and resolves `deepLink` under it.
        // `actions` (ask-pending only, #382 M2) rides the payload so the shade can register answer
        // chips as notification actions; absent on every other family (undefined is dropped by JSON).
        data: {
          deviceId: registration.deviceId,
          deepLink: item.deepLink,
          family: item.family,
          // The attention id (#382 M2 finding 3): a shade answer invokes `review.ask` with it so
          // the daemon consumes exactly this ask atomically (dedup + forgery guard).
          attentionId: item.id,
          ...(item.actions ? { actions: item.actions } : {}),
        },
        priority: plan.priority === "high" ? "high" : "normal",
        ...(categoryId ? { categoryId } : {}),
      }));
      // Map token → device once; both the synchronous dead-token prune and the async receipt
      // poll below drop by device id.
      const deviceByToken = new Map(plan.push.map((r) => [r.token, r.deviceId]));
      const dropDeadToken = (token: string): void => {
        const deviceId = deviceByToken.get(token);
        if (deviceId) attention.pushTokens.delete(deviceId);
      };
      const post = attention.sendPush ?? sendExpoPushes;
      const receipts: ExpoReceiptHandle[] = [];
      // Fire-and-forget: push is best-effort, the in-app frame above is authoritative.
      void post(messages, {
        onDeadToken: dropDeadToken,
        onReceipt: (handle) => receipts.push(handle),
        onError: (error) => attention.onEgressError?.(error),
      }).then(() => {
        // One delayed receipt poll (#383 batch): a token the send accepted can still be reported
        // dead at receipt time. Pruned by device id, non-fatal, timer cleared on close.
        if (receipts.length === 0) return;
        const poll = attention.pollReceipts ?? pollExpoReceipts;
        const timer = setTimeout(() => {
          receiptTimers.delete(timer);
          void poll(receipts, {
            onDeadToken: dropDeadToken,
            onError: (error) => attention.onEgressError?.(error),
          });
        }, attention.receiptPollDelayMs ?? RECEIPT_POLL_DELAY_MS);
        timer.unref?.();
        receiptTimers.add(timer);
      });
    }
    return item;
  };

  const acknowledgeAttention = (selector: { reviewId?: string; attentionId?: string }): number => {
    if (!deps.attention) return 0;
    const cleared = attentionRegistry.clear(selector);
    if (cleared.length > 0) {
      // Quiet everywhere: broadcast the cleared ids so every client drops the needs-you badge.
      broadcastAttention({
        type: "attentionEvent",
        event: "cleared",
        clearedIds: cleared.map((item) => item.id),
      });
    }
    return cleared.length;
  };

  const activeAttention = (): AttentionItem[] => attentionRegistry.active();

  const disconnectDevice = (deviceId: string): number => {
    let closed = 0;
    for (const connection of connections) {
      if (connection.deviceId === deviceId) {
        connection.socket.close();
        closed += 1;
      }
    }
    return closed;
  };

  const askConnection = (
    connectionId: string,
    kind: string,
    payload: unknown,
  ): Promise<unknown> => {
    const connection = byId.get(connectionId);
    if (!connection) return Promise.reject(new Error(`no connection ${connectionId}`));
    const serverRequestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      connection.serverRequests.set(serverRequestId, { resolve, reject });
      const projectedPayload =
        connection.connectionClass === "projected"
          ? scrubProjectedValue(payload, contextOf())
          : payload;
      send(connection.socket, {
        type: "serverRequest",
        serverRequestId,
        kind,
        payload: projectedPayload,
      });
    });
  };

  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      for (const timer of receiptTimers) clearTimeout(timer);
      receiptTimers.clear();
      for (const connection of connections) connection.socket.close();
      wss.close(() => httpServer.close(() => resolve()));
    });

  return {
    port: boundPort,
    host: listenHost,
    broadcastProgress,
    broadcastBoardEvent,
    askConnection,
    raiseAttention,
    acknowledgeAttention,
    activeAttention,
    disconnectDevice,
    close,
  };
}
