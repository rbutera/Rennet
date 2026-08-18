// The loopback WebSocket transport (issue #378, app server wave phase 2). The
// server speaks the phase-0 session envelope (protocol/session.ts) as JSON text
// frames over `127.0.0.1` on an ephemeral port. The layer is deliberately dumb:
// parse a frame → route a `request` to the SAME in-process `dispatch` → serialize
// the result. All behaviour lives in the server; the transport adds only requestId
// correlation, the hello/serverInfo handshake, and progress/ask-stream fan-out.
//
// This replaces the bespoke `ipcMain.handle("rennet:invoke")` path: from this phase
// the Electron renderer is client #1 of the real wire (see WsRennetBridge in
// @rennet/client), so a transport bug is a desktop bug, caught immediately.

import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
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
}

/** The daemon identity `GET /healthz` returns and a launcher probes before connecting (#379). */
export const daemonIdentitySchema = z.object({
  pid: z.number().int().positive(),
  wsPort: z.number().int().positive(),
  version: z.string(),
  protocolVersion: z.number().int().nonnegative(),
  minCompatibleProtocolVersion: z.number().int().nonnegative(),
});

export type DaemonIdentity = z.infer<typeof daemonIdentitySchema>;

export interface WsListener {
  /** The ephemeral loopback port the listener bound; the desktop injects it into the renderer. */
  readonly port: number;
  /** Fan a rehydration/background progress event out to every connected socket (today's all-windows broadcast). */
  broadcastProgress(commandId: string, event: ProjectProcessEvent): void;
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

/** Start the loopback WS listener bound to `127.0.0.1:0`; resolves once it is `listening`. */
export async function startWsListener(deps: WsListenerDeps): Promise<WsListener> {
  const { dispatch, serverVersion } = deps;
  const sockets = new Set<WebSocket>();
  // `boundPort` is filled after `listen`; the healthz handler only runs once requests
  // arrive (post-listen), so the closure always reads the real port.
  let boundPort = 0;
  // `GET /healthz` answers the launcher's liveness + protocol probe (#379). Non-upgrade
  // HTTP requests land here; WS upgrades go to the WebSocketServer instead.
  const httpServer: HttpServer = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/healthz" || req.url?.startsWith("/healthz?"))) {
      const identity: DaemonIdentity = {
        pid: process.pid,
        wsPort: boundPort,
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
  const wss = new WebSocketServer({ server: httpServer });

  const send = (socket: WebSocket, frame: SessionFrame): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  wss.on("connection", (socket: WebSocket) => {
    // Stable per-connection identity: the progress-replay dedup in createDispatch keys
    // sinks on this id, so a socket that re-invokes replaces its own sink rather than
    // stacking a second sender for the same live run.
    const connectionId = randomUUID();
    let helloReceived = false;
    sockets.add(socket);

    const runRequest = async (
      requestId: string,
      command: CommandName,
      input: unknown,
    ): Promise<void> => {
      // A command carrying a `commandId` streams live progress to THIS socket; a
      // `reviewId` streams its conversation tokens. Same extraction the deleted IPC
      // handler did — the transport binds the sinks, dispatch owns the behaviour.
      const commandId = inputString(input, "commandId");
      const reviewId = inputString(input, "reviewId");
      const emitProgress = commandId
        ? (event: ProjectProcessEvent): void =>
            send(socket, { type: "progressEvent", commandId, event })
        : undefined;
      const emitAskStream = reviewId
        ? (event: ReviewAskStreamEvent): void =>
            send(socket, { type: "askStreamEvent", reviewId, event })
        : undefined;
      try {
        const output = await dispatch(command, input, {
          emitProgress,
          progressRecipientId: connectionId,
          emitAskStream,
        });
        send(socket, { type: "response", requestId, output });
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
          helloReceived = true;
          send(socket, {
            type: "serverInfo",
            version: serverVersion,
            protocolVersion: PROTOCOL_VERSION,
            minCompatibleProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
            features: {},
          });
          return;
        }
        case "request": {
          if (!helloReceived) {
            send(socket, {
              type: "rpcError",
              requestId: frame.requestId,
              code: "invalid_input",
              message: "hello handshake required before a request",
            });
            return;
          }
          // `command` passed the isCommandName refine in parseSessionFrame; the cast
          // only narrows the branded type dispatch expects.
          void runRequest(frame.requestId, frame.command as CommandName, frame.input);
          return;
        }
        // response/rpcError/progressEvent/askStreamEvent are server→client frames; a
        // client sending one is protocol misuse — ignore, keep the connection open.
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

    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("WS listener bound without a numeric port");
  }
  const port = address.port;
  boundPort = port;

  const broadcastProgress = (commandId: string, event: ProjectProcessEvent): void => {
    const payload = JSON.stringify({
      type: "progressEvent",
      commandId,
      event,
    } satisfies SessionFrame);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  };

  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.close();
      wss.close(() => httpServer.close(() => resolve()));
    });

  return { port, broadcastProgress, close };
}
