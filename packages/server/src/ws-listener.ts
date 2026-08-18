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
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import type {
  CommandName,
  ProjectProcessEvent,
  ReviewAskStreamEvent,
  SessionFrame,
} from "@rennet/protocol";
import {
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  parseSessionFrame,
} from "@rennet/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import {
  buildProjectionContext,
  type ProjectionContext,
  ProjectionResolveError,
  projectCommandOutput,
  projectProgressEvent,
  resolveCommandInput,
} from "./projection";

/** The dispatch surface the transport routes to — the exact shape createDispatch returns. */
type Dispatch = (
  name: CommandName,
  input: unknown,
  ctx?: {
    emitProgress?(event: ProjectProcessEvent): void;
    progressRecipientId?: string | number;
    emitAskStream?(event: ReviewAskStreamEvent): void;
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
   * Ask ONE connection a question and resolve with its answer (issue #380, wire only).
   * Rejects if the connection is unknown or drops before answering. A `serverRequestResolved`
   * frame is sent to the connection on resolution or rejection so it never shows a stale prompt.
   */
  askConnection(connectionId: string, kind: string, payload: unknown): Promise<unknown>;
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

/** Best-effort requestId salvage from a frame that failed schema validation, for a correlated error. */
function salvageRequestId(raw: unknown): string {
  if (raw && typeof raw === "object") {
    const value = (raw as Record<string, unknown>).requestId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "unknown";
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
  /** Pending server→client asks on THIS connection, keyed by `serverRequestId`. */
  readonly serverRequests: Map<string, ServerRequestPending>;
}

/** Start the WS listener. Binds `127.0.0.1:0` by default, or `deps.listen` when set; resolves once listening. */
export async function startWsListener(deps: WsListenerDeps): Promise<WsListener> {
  const { dispatch, serverVersion } = deps;
  const listenHost = deps.listen?.host ?? "127.0.0.1";
  const listenPort = deps.listen?.port ?? 0;
  const nonLoopbackBind = !isLoopbackAddress(listenHost) && listenHost !== "localhost";
  const home = homedir();
  const contextOf = (): ProjectionContext =>
    deps.projectionContext?.() ?? buildProjectionContext([], home);

  const connections = new Set<Connection>();
  const byId = new Map<string, Connection>();
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
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  const wss = new WebSocketServer({
    server: httpServer,
    // Refuse a foreign Host at the WS upgrade too (only enforced for a non-loopback bind).
    verifyClient: nonLoopbackBind
      ? (info: { req: IncomingMessage }) => isHostAllowed(info.req.headers.host, listenHost)
      : undefined,
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
          send(socket, {
            type: "rpcError",
            requestId,
            code: "invalid_input",
            message: error instanceof ProjectionResolveError ? error.message : String(error),
          });
          return;
        }
      }
      const commandId = inputString(effectiveInput, "commandId");
      const reviewId = inputString(effectiveInput, "reviewId");
      const emitProgress = commandId
        ? (event: ProjectProcessEvent): void =>
            send(socket, {
              type: "progressEvent",
              commandId,
              event: ctx ? projectProgressEvent(event, ctx) : event,
            })
        : undefined;
      // Ask-stream deltas are model-authored prose — NOT projected (R31/R32 honesty).
      const emitAskStream = reviewId
        ? (event: ReviewAskStreamEvent): void =>
            send(socket, { type: "askStreamEvent", reviewId, event })
        : undefined;
      try {
        const output = await dispatch(command, effectiveInput, {
          emitProgress,
          progressRecipientId: connectionId,
          emitAskStream,
        });
        send(socket, {
          type: "response",
          requestId,
          output: ctx ? projectCommandOutput(command, output, ctx) : output,
        });
      } catch (error) {
        send(socket, {
          type: "rpcError",
          requestId,
          code: "command_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const handleFrame = (frame: SessionFrame): void => {
      switch (frame.type) {
        case "hello": {
          if (frame.protocolVersion < MIN_COMPATIBLE_PROTOCOL_VERSION) {
            send(socket, {
              type: "rpcError",
              requestId: frame.clientId,
              code: "incompatible_protocol",
              message: `client protocol version ${frame.protocolVersion} is below the server minimum ${MIN_COMPATIBLE_PROTOCOL_VERSION}`,
            });
            return;
          }
          // Classify ONCE (design D1): loopback → private; else a valid token → projected;
          // else pairing-only (may invoke only `pairing.exchange`, so a revoked/absent
          // token can still re-pair — pairing stays available).
          if (loopback) {
            connection.connectionClass = "private";
          } else if (frame.deviceToken && deps.verifyDeviceToken?.(frame.deviceToken)) {
            connection.connectionClass = "projected";
          } else {
            connection.connectionClass = "pairing-only";
          }
          connection.helloReceived = true;
          send(socket, {
            type: "serverInfo",
            version: serverVersion,
            protocolVersion: PROTOCOL_VERSION,
            minCompatibleProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
            features: { serverRequests: true },
          });
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
        // response/rpcError/progress/askStream/serverRequest/resolved are server→client; ignore inbound.
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
      if (connection.connectionClass === "projected") {
        if (projectedPayload === null) {
          projectedPayload = JSON.stringify({
            type: "progressEvent",
            commandId,
            event: projectProgressEvent(event, contextOf()),
          } satisfies SessionFrame);
        }
        connection.socket.send(projectedPayload);
      } else {
        connection.socket.send(rawPayload);
      }
    }
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
      send(connection.socket, { type: "serverRequest", serverRequestId, kind, payload });
    });
  };

  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      for (const connection of connections) connection.socket.close();
      wss.close(() => httpServer.close(() => resolve()));
    });

  return { port: boundPort, host: listenHost, broadcastProgress, askConnection, close };
}
