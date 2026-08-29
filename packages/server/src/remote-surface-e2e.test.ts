// Remote-surface contract e2e (issue #380, design D10). A NODE-level test (no
// Playwright): bind the listener beyond loopback, pair a device, drive a review flow
// over the PROJECTED connection, and sweep every serialized frame for a host-absolute
// path (the home dir or the fixture repo root). If any crosses, the test fails.
//
// Positive control: the sweep is proven able to go RED — a deliberately-leaked path in
// a frame makes it report a leak — so a green main assertion means the projection
// worked, not that the sweep is vacuous.
//
// Hermetic by construction: dispatch is a controlled stand-in that returns realistic
// review/project/progress shapes carrying real host paths, so the boundary — pairing,
// connection classes, and the R19 projection over a real non-loopback socket — is what
// is under test, with no model harness or network.

import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { PROTOCOL_VERSION } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { PairingStore } from "./pairing-store";
import { buildProjectionContext } from "./projection";
import { startWsListener, type WsListener, type WsListenerDeps } from "./ws-listener";

/** The first non-internal IPv4 address, or null when the environment offers none (CI sandboxes). */
function nonLoopbackIpv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

/** Every needle (home dir / repo root) found anywhere in the captured frames — empty means clean. */
function findLeaks(frames: string[], needles: string[]): string[] {
  const found: string[] = [];
  for (const needle of needles)
    if (frames.some((frame) => frame.includes(needle))) found.push(needle);
  return found;
}

describe("remote-surface e2e (#380)", () => {
  const REPO_ROOT = mkdtempSync(join(tmpdir(), "rennet-remote-repo-"));
  const HOME = mkdtempSync(join(tmpdir(), "rennet-remote-home-"));
  const ASK_STREAM_ANCHOR = "src/app.ts";
  // An absolute path under NEITHER the fixture repo root NOR the home dir — the shape the
  // blanket root/home scrub cannot see, so only the transcript's own redaction catches it.
  const STRAY_PATH = "/etc/hosts/passwd";
  const listeners: WsListener[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const listener of listeners.splice(0)) await listener.close();
  });

  /** A review carrying host paths at every structural field the projection must scrub. */
  function reviewFixture() {
    return {
      id: "rev-1",
      repositoryRoot: REPO_ROOT,
      activePatchsetId: "ps-1",
      dispositions: [{ path: "src/app.ts", disposition: null, body: "" }],
      status: "current",
      patchsets: [
        {
          id: "ps-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          repository: {
            id: "prov-1",
            root: REPO_ROOT,
            commonDir: `${REPO_ROOT}/.git`,
            baseRef: "main",
            baseOid: "a".repeat(40),
            headOid: "b".repeat(40),
          },
          files: [{ path: "src/app.ts", status: "modified", additions: 1, deletions: 0 }],
        },
      ],
    };
  }

  interface DispatchState {
    connectionId?: string;
    projectsAddInput?: {
      discovery: { path: string; repos: { path: string }[] };
    };
  }

  /** Controlled dispatch: routes pairing.exchange to the store, returns host-path-bearing shapes. */
  function makeDispatch(pairing: PairingStore, state: DispatchState): WsListenerDeps["dispatch"] {
    return (async (name, input, ctx) => {
      if (ctx?.progressRecipientId !== undefined) {
        state.connectionId = String(ctx.progressRecipientId);
      }
      switch (name) {
        case "pairing.exchange": {
          const { code, deviceName } = input as { code: string; deviceName: string };
          return pairing.exchange(code, deviceName);
        }
        case "device.registerPush": {
          // A token-bearing connection registers; the stub just needs the auth binding to hold.
          if (!ctx?.deviceId) throw new Error("device.registerPush requires a paired connection");
          return { registered: true };
        }
        case "review.capture": {
          // Also push a progress event carrying the repo root (exercises progress projection).
          ctx?.emitProgress?.({
            kind: "repo-done",
            repo: "repo",
            summary: { repo: "repo", path: REPO_ROOT, ok: true, files: 3 },
          });
          return { review: reviewFixture() };
        }
        case "project.discover":
          return {
            discovery: {
              path: REPO_ROOT,
              kind: "workspace",
              repos: [
                {
                  name: "nested",
                  path: `${REPO_ROOT}/nested`,
                  branches: 1,
                },
              ],
              primaryBranch: "main",
            },
          };
        case "projects.add": {
          state.projectsAddInput = input as DispatchState["projectsAddInput"];
          const project = {
            id: "p1",
            name: "repo",
            path: REPO_ROOT,
            kind: "workspace",
            repoCount: 1,
            branchCount: 1,
            primaryBranch: "main",
            openPath: `${REPO_ROOT}/nested`,
            includedRepoPaths: [`${REPO_ROOT}/nested`],
            addedAt: "2026-01-01T00:00:00.000Z",
          };
          return { project, projects: [project] };
        }
        case "projects.list":
          return {
            projects: [
              {
                id: "p1",
                name: "repo",
                path: REPO_ROOT,
                kind: "repo",
                repoCount: 1,
                branchCount: 1,
                primaryBranch: "main",
                openPath: REPO_ROOT,
                includedRepoPaths: [REPO_ROOT],
                addedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          };
        case "review.setDisposition":
          return { review: reviewFixture() };
        case "session.transcript":
          // The display transcript as the capture sink now STORES it: raw harness text, host
          // paths intact. Nothing between this and the socket except `projectCommandOutput`.
          return {
            trail: { title: "feat/seam" },
            rows: [
              {
                kind: "turn",
                id: "turn-1",
                speaker: "orchestrator",
                status: "complete",
                paragraphs: [`wrote ${REPO_ROOT}/src/app.ts`],
                preface: [
                  {
                    kind: "action",
                    id: "act-1",
                    label: "Bash",
                    detail: `cat ${REPO_ROOT}/src/app.ts ${HOME}/.zshrc ${STRAY_PATH}`,
                    status: "complete",
                    toolKind: "exec",
                  },
                ],
              },
            ],
          };
        case "review.ask":
          ctx?.emitAskStream?.({ kind: "ask-focus", anchor: ASK_STREAM_ANCHOR });
          return {};
        case "harness.detect": {
          const error = new Error(`failed to inspect ${REPO_ROOT}/broken`);
          Object.assign(error, { details: { path: `${REPO_ROOT}/details` } });
          throw error;
        }
        default:
          return {};
      }
    }) as WsListenerDeps["dispatch"];
  }

  async function startRemoteListener(
    pairing: PairingStore,
    host: string,
    state: DispatchState = {},
  ): Promise<WsListener> {
    const listener = await startWsListener({
      dispatch: makeDispatch(pairing, state),
      serverVersion: "e2e",
      verifyDeviceToken: (token) => pairing.verifyToken(token),
      projectionContext: () => buildProjectionContext([REPO_ROOT], HOME),
      listen: { host },
    });
    listeners.push(listener);
    return listener;
  }

  /** Open a socket, complete the handshake with an optional token, and collect every inbound frame. */
  async function connect(
    url: string,
    deviceToken?: string,
  ): Promise<{
    socket: WebSocket;
    frames: string[];
    send: (frame: unknown) => void;
    request: (command: string, input: unknown) => Promise<Record<string, unknown>>;
  }> {
    const socket = new WebSocket(url);
    sockets.push(socket);
    const frames: string[] = [];
    await once(socket, "open");
    const serverInfo = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "e2e",
        clientType: "rennet-client",
        protocolVersion: PROTOCOL_VERSION,
        ...(deviceToken ? { deviceToken } : {}),
      }),
    );
    frames.push(String((await serverInfo)[0]));
    socket.on("message", (data) => frames.push(String(data)));
    const send = (frame: unknown): void => socket.send(JSON.stringify(frame));
    const request = (command: string, input: unknown): Promise<Record<string, unknown>> => {
      const requestId = `req-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve, reject) => {
        const onMessage = (data: unknown): void => {
          const frame = JSON.parse(String(data));
          if (frame.type === "response" && frame.requestId === requestId) {
            socket.off("message", onMessage);
            resolve(frame.output);
          } else if (frame.type === "rpcError" && frame.requestId === requestId) {
            socket.off("message", onMessage);
            reject(Object.assign(new Error(frame.message), { frame }));
          }
        };
        socket.on("message", onMessage);
        send({ type: "request", requestId, command, input });
      });
    };
    return { socket, frames, send, request };
  }

  it("pairs, drives a projected review flow, and leaks no host path (with a red-provable sweep)", async () => {
    const ip = nonLoopbackIpv4();
    if (!ip) {
      // Honest skip: this environment exposes no non-loopback interface to bind/connect.
      console.warn("remote-surface e2e skipped: no non-loopback IPv4 interface available");
      return;
    }
    const pairing = new PairingStore(
      join(mkdtempSync(join(tmpdir(), "rennet-remote-pair-")), "devices.json"),
    );
    const state: DispatchState = {};
    const listener = await startRemoteListener(pairing, "0.0.0.0", state);
    const url = `ws://${ip}:${listener.port}`;

    const requestFailure = async (
      client: Awaited<ReturnType<typeof connect>>,
      command: string,
      input: unknown,
    ): Promise<Record<string, unknown>> => {
      try {
        await client.request(command, input);
      } catch (error) {
        return (error as { frame: Record<string, unknown> }).frame;
      }
      throw new Error(`expected ${command} to fail`);
    };

    // 1. Unpaired remote: a non-pairing request is refused (only pairing.exchange is allowed).
    const unpaired = await connect(url);
    await expect(
      unpaired.request("review.capture", { commandId: "c", repoPath: "anything" }),
    ).rejects.toThrow(/pair first/);

    // A second hello cannot upgrade the already-classified pairing-only connection.
    const existingCode = pairing.mint().code;
    const existingToken = pairing.exchange(existingCode, "existing phone").deviceToken;
    const secondHelloReply = once(unpaired.socket, "message");
    unpaired.send({
      type: "hello",
      clientId: "second-hello",
      clientType: "rennet-client",
      protocolVersion: PROTOCOL_VERSION,
      deviceToken: existingToken,
    });
    expect(JSON.parse(String((await secondHelloReply)[0]))).toMatchObject({
      type: "rpcError",
      code: "invalid_input",
    });
    await expect(unpaired.request("projects.list", {})).rejects.toThrow(/pair first/);

    // 2. Mint a code daemon-side, then exchange it over the (pairing-only) connection.
    const { code } = pairing.mint();
    const exchanged = (await unpaired.request("pairing.exchange", {
      code,
      deviceName: "phone",
    })) as {
      deviceToken: string;
    };
    expect(exchanged.deviceToken).toBeTruthy();
    unpaired.socket.close();

    // 3. Reconnect WITH the token → projected. Discover the repoKey, then drive the review flow.
    const paired = await connect(url, exchanged.deviceToken);
    const list = (await paired.request("projects.list", {})) as {
      projects: { path: { repoKey: string } }[];
    };
    const repoKey = list.projects[0]?.path.repoKey;
    expect(repoKey).toBeTruthy();

    const discovered = (await paired.request("project.discover", {
      commandId: "discover",
      path: repoKey,
      kind: "workspace",
    })) as {
      discovery: {
        path: { repoKey: string };
        repos: { name: string; path: { repoKey: string; relativePath?: string } }[];
        primaryBranch: string;
      };
    };
    expect(discovered.discovery.repos[0]?.path.relativePath).toBe("nested");
    await paired.request("projects.add", {
      commandId: "add",
      discovery: discovered.discovery,
      includedRepos: ["nested"],
      primaryBranch: discovered.discovery.primaryBranch,
    });
    expect(state.projectsAddInput?.discovery.path).toBe(REPO_ROOT);
    expect(state.projectsAddInput?.discovery.repos[0]?.path).toBe(`${REPO_ROOT}/nested`);

    const rawAddError = await requestFailure(paired, "projects.add", {
      commandId: "raw-add",
      discovery: {
        path: discovered.discovery.path,
        kind: "repo",
        repos: [{ name: "repo", path: REPO_ROOT, branches: 1 }],
        primaryBranch: "main",
      },
      includedRepos: ["repo"],
      primaryBranch: "main",
    });
    expect(rawAddError).toMatchObject({ type: "rpcError", code: "invalid_input" });
    expect(JSON.stringify(rawAddError)).not.toContain(REPO_ROOT);

    // Inbound: send the repoKey where a private client would send a host path — it resolves server-side.
    const captured = (await paired.request("review.capture", {
      commandId: "cap",
      repoPath: repoKey,
    })) as {
      review: { repositoryRoot: { repoKey: string } };
    };
    expect(captured.review.repositoryRoot.repoKey).toBe(repoKey);
    await paired.request("review.setDisposition", {
      commandId: "d",
      reviewId: "rev-1",
      patchsetId: "ps-1",
      path: "src/app.ts",
      disposition: null,
      body: "",
    });

    expect(isAbsolute(ASK_STREAM_ANCHOR)).toBe(false);
    expect(win32.isAbsolute(ASK_STREAM_ANCHOR)).toBe(false);
    await paired.request("review.ask", {
      commandId: "ask",
      reviewId: "rev-1",
      question: "what changed?",
    });
    const askStreamFrame = paired.frames
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.type === "askStreamEvent");
    expect(askStreamFrame).toMatchObject({
      event: { kind: "ask-focus", anchor: ASK_STREAM_ANCHOR },
    });

    // The display transcript over the PROJECTED connection. This is the half that must not
    // regress now that the rows are stored raw: the repo root, the home dir, AND a stray
    // absolute path under neither all have to be gone by the time the phone sees them.
    const projectedTranscript = (await paired.request("session.transcript", {
      reviewId: "rev-1",
    })) as { rows: { preface: { detail: string }[]; paragraphs: string[] }[] };
    const projectedDetail = projectedTranscript.rows[0]?.preface[0]?.detail ?? "";
    expect(projectedDetail).not.toContain(REPO_ROOT);
    expect(projectedDetail).not.toContain(HOME);
    expect(projectedDetail).not.toContain(STRAY_PATH);
    expect(projectedDetail).toContain("~/.zshrc");
    expect(projectedDetail).toContain("<path>");
    expect(projectedTranscript.rows[0]?.paragraphs[0]).not.toContain(REPO_ROOT);

    const projectedFailure = await requestFailure(paired, "harness.detect", {});
    expect(projectedFailure).toMatchObject({
      type: "rpcError",
      code: "command_failed",
    });
    expect(JSON.stringify(projectedFailure)).not.toContain(REPO_ROOT);
    expect(String(projectedFailure.message)).toContain("<rennet-remote-repo-");
    expect(String((projectedFailure.details as { path: string }).path)).toContain(
      "<rennet-remote-repo-",
    );

    expect(state.connectionId).toBeTruthy();
    const serverRequestMessage = once(paired.socket, "message");
    const answerPromise = listener.askConnection(state.connectionId as string, "inspect", {
      path: `${REPO_ROOT}/server-request`,
    });
    const serverRequest = JSON.parse(String((await serverRequestMessage)[0]));
    expect(JSON.stringify(serverRequest)).not.toContain(REPO_ROOT);
    expect(serverRequest.payload.path).toContain("<rennet-remote-repo-");
    const resolvedMessage = once(paired.socket, "message");
    paired.send({
      type: "serverResponse",
      serverRequestId: serverRequest.serverRequestId,
      payload: { answer: "ok" },
    });
    await expect(answerPromise).resolves.toEqual({ answer: "ok" });
    expect(JSON.parse(String((await resolvedMessage)[0]))).toMatchObject({
      type: "serverRequestResolved",
      serverRequestId: serverRequest.serverRequestId,
    });

    const pairingFrameCount = unpaired.frames.length;
    const projectedBroadcast = once(paired.socket, "message");
    listener.broadcastProgress("broadcast", {
      kind: "repo-done",
      repo: "repo",
      summary: { repo: "repo", path: REPO_ROOT, ok: true },
    });
    const broadcastFrame = JSON.parse(String((await projectedBroadcast)[0]));
    expect(broadcastFrame.event.summary.path.repoKey).toBeTruthy();
    expect(JSON.stringify(broadcastFrame)).not.toContain(REPO_ROOT);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unpaired.frames).toHaveLength(pairingFrameCount);

    const privateClient = await connect(`ws://127.0.0.1:${listener.port}`);
    const privateFailure = await requestFailure(privateClient, "harness.detect", {});
    expect(privateFailure).toMatchObject({
      type: "rpcError",
      code: "command_failed",
      details: { path: `${REPO_ROOT}/details` },
    });
    expect(String(privateFailure.message)).toContain(REPO_ROOT);
    // …and the LOOPBACK connection reads the transcript exactly as it was stored. This is the
    // point of moving the scrub to the wire: the reviewer's own machine gets their own paths
    // back, whole. Put the write-time scrub back and this assertion cannot hold.
    const privateTranscript = (await privateClient.request("session.transcript", {
      reviewId: "rev-1",
    })) as { rows: { preface: { detail: string }[] }[] };
    expect(privateTranscript.rows[0]?.preface[0]?.detail).toBe(
      `cat ${REPO_ROOT}/src/app.ts ${HOME}/.zshrc ${STRAY_PATH}`,
    );
    // Let the pushed progress frame arrive.
    await new Promise((r) => setTimeout(r, 30));

    // 4. Sweep every frame the projected connection received for a host-absolute path.
    const needles = [HOME, REPO_ROOT];
    expect(findLeaks(paired.frames, needles)).toEqual([]);
    // Sanity: the flow actually exercised the projection (a repoKey reference did cross).
    expect(paired.frames.some((frame) => frame.includes(repoKey as string))).toBe(true);

    // 5. Positive control: the sweep is NOT vacuous — a leaked path is detected.
    const leakyFrame = JSON.stringify({
      type: "response",
      requestId: "x",
      output: { repositoryRoot: REPO_ROOT },
    });
    expect(findLeaks([leakyFrame], needles)).toContain(REPO_ROOT);
  });

  it("refuses a foreign Host header before the WebSocket upgrade (rebinding guard)", async () => {
    const ip = nonLoopbackIpv4();
    if (!ip) {
      console.warn(
        "remote-surface host-guard test skipped: no non-loopback IPv4 interface available",
      );
      return;
    }
    const pairing = new PairingStore(
      join(mkdtempSync(join(tmpdir(), "rennet-remote-pair2-")), "devices.json"),
    );
    const listener = await startRemoteListener(pairing, "0.0.0.0");
    // A hostNAME Host header (the DNS-rebinding shape) is refused; the upgrade fails.
    const socket = new WebSocket(`ws://${ip}:${listener.port}`, {
      headers: { host: "evil.example.com" },
    });
    sockets.push(socket);
    const [error] = (await once(socket, "error")) as [Error];
    expect(error.message).toContain("403");
  });

  it("rejects a present-but-invalid device token as a terminal auth error, not pairing-only (#383)", async () => {
    const ip = nonLoopbackIpv4();
    if (!ip) {
      console.warn("remote-surface token-reject test skipped: no non-loopback IPv4 interface");
      return;
    }
    const pairing = new PairingStore(
      join(mkdtempSync(join(tmpdir(), "rennet-remote-pair3-")), "devices.json"),
    );
    const listener = await startRemoteListener(pairing, "0.0.0.0");
    const socket = new WebSocket(`ws://${ip}:${listener.port}`);
    sockets.push(socket);
    await once(socket, "open");
    const first = once(socket, "message");
    const closed = once(socket, "close");
    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "reject-me",
        clientType: "rennet-client",
        protocolVersion: PROTOCOL_VERSION,
        deviceToken: "not-a-real-token",
      }),
    );
    // The daemon answers `unauthorized` correlated to the hello (NOT a serverInfo that would
    // read as a healthy pairing-only `online`) and closes the socket.
    const frame = JSON.parse(String((await first)[0]));
    expect(frame).toMatchObject({
      type: "rpcError",
      requestId: "reject-me",
      code: "unauthorized",
    });
    expect(frame.type).not.toBe("serverInfo");
    await closed; // terminal: the connection is dropped, not left pairing-only
  });

  it("broadcasts board events raw to private sockets and privacy-wrapped to projected ones (B4)", async () => {
    const ip = nonLoopbackIpv4();
    if (!ip) {
      console.warn("remote-surface board-broadcast test skipped: no non-loopback IPv4 interface");
      return;
    }
    const pairing = new PairingStore(
      join(mkdtempSync(join(tmpdir(), "rennet-remote-board-")), "devices.json"),
    );
    const listener = await startRemoteListener(pairing, "0.0.0.0");
    const url = `ws://${ip}:${listener.port}`;

    // Pair over a pairing-only connection, then reconnect projected; open a loopback private one.
    const unpaired = await connect(url);
    const { code } = pairing.mint();
    const exchanged = (await unpaired.request("pairing.exchange", {
      code,
      deviceName: "phone",
    })) as { deviceToken: string };
    unpaired.socket.close();
    const paired = await connect(url, exchanged.deviceToken);
    const priv = await connect(`ws://127.0.0.1:${listener.port}`);

    const privFrame = once(priv.socket, "message");
    const pairedFrame = once(paired.socket, "message");
    listener.broadcastBoardEvent("b1", [
      {
        seq: 1,
        actor: "lens:design",
        op: {
          op: "create",
          op_id: "op-1",
          element: {
            id: "e1",
            kind: "prose",
            data: { markdown: `see ${REPO_ROOT}/src/a.ts and ${HOME}/notes.md` },
          },
        },
      },
    ]);

    // Private (loopback): the raw event, host paths intact.
    const raw = JSON.parse(String((await privFrame)[0]));
    expect(raw).toMatchObject({ type: "boardEvent", boardId: "b1" });
    expect(raw.events[0].op.element.data.markdown).toContain(REPO_ROOT);

    // Projected: same frame shape, every host path substituted.
    const wrapped = JSON.parse(String((await pairedFrame)[0]));
    expect(wrapped).toMatchObject({ type: "boardEvent", boardId: "b1" });
    expect(findLeaks([JSON.stringify(wrapped)], [REPO_ROOT, HOME])).toEqual([]);
    expect(wrapped.events[0].op.element.data.markdown).toContain("~/notes.md");
    expect(wrapped.events[0].seq).toBe(1);
  });

  it("revoking a device severs its live socket and blocks its token from re-authorizing (#383 batch)", async () => {
    const ip = nonLoopbackIpv4();
    if (!ip) {
      console.warn("remote-surface revoke test skipped: no non-loopback IPv4 interface");
      return;
    }
    const pairing = new PairingStore(
      join(mkdtempSync(join(tmpdir(), "rennet-remote-revoke-")), "devices.json"),
    );
    const listener = await startRemoteListener(pairing, "0.0.0.0");
    const url = `ws://${ip}:${listener.port}`;

    // Pair over a pairing-only connection, then reconnect projected.
    const unpaired = await connect(url);
    const { code } = pairing.mint();
    const exchanged = (await unpaired.request("pairing.exchange", {
      code,
      deviceName: "phone",
    })) as { deviceToken: string; deviceId: string };
    unpaired.socket.close();

    const paired = await connect(url, exchanged.deviceToken);
    // The projected device can register a push token.
    await expect(
      paired.request("device.registerPush", { pushToken: "tok", platform: "ios" }),
    ).resolves.toMatchObject({ registered: true });

    // Revoke: drop the pairing AND sever the live socket (mirrors create-server's revoke wiring).
    const closedSocket = once(paired.socket, "close");
    pairing.revokeDevice(exchanged.deviceId);
    expect(listener.disconnectDevice(exchanged.deviceId)).toBe(1);
    await closedSocket;
    expect(paired.socket.readyState).toBe(WebSocket.CLOSED);

    // The revoked token can no longer authorize a fresh connection: it is rejected as a terminal
    // auth error, so it can never reach device.registerPush again.
    const reauth = new WebSocket(url);
    sockets.push(reauth);
    await once(reauth, "open");
    const firstFrame = once(reauth, "message");
    reauth.send(
      JSON.stringify({
        type: "hello",
        clientId: "revoked",
        clientType: "rennet-client",
        protocolVersion: PROTOCOL_VERSION,
        deviceToken: exchanged.deviceToken,
      }),
    );
    expect(JSON.parse(String((await firstFrame)[0]))).toMatchObject({
      type: "rpcError",
      code: "unauthorized",
    });
  });
});
