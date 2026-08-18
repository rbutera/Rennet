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
import { join } from "node:path";
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

  /** Controlled dispatch: routes pairing.exchange to the store, returns host-path-bearing shapes. */
  function makeDispatch(pairing: PairingStore): WsListenerDeps["dispatch"] {
    return (async (name, input, ctx) => {
      switch (name) {
        case "pairing.exchange": {
          const { code, deviceName } = input as { code: string; deviceName: string };
          return pairing.exchange(code, deviceName);
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
        default:
          return {};
      }
    }) as WsListenerDeps["dispatch"];
  }

  async function startRemoteListener(pairing: PairingStore, host: string): Promise<WsListener> {
    const listener = await startWsListener({
      dispatch: makeDispatch(pairing),
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
            reject(new Error(frame.message));
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
    const listener = await startRemoteListener(pairing, "0.0.0.0");
    const url = `ws://${ip}:${listener.port}`;

    // 1. Unpaired remote: a non-pairing request is refused (only pairing.exchange is allowed).
    const unpaired = await connect(url);
    await expect(
      unpaired.request("review.capture", { commandId: "c", repoPath: "anything" }),
    ).rejects.toThrow(/pair first/);

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
    const error = await once(socket, "error")
      .then(() => true)
      .catch(() => true);
    expect(error).toBe(true);
  });
});
