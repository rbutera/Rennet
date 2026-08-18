import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_COMPATIBLE_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRennetServer, type RennetServer } from "./create-server";
import { writeDaemonFile } from "./daemon-file";
import { findHealthyDaemon, probeHealth } from "./supervise";

/** Start a throwaway HTTP server that answers `/healthz` with the given identity JSON. */
function fakeHealthz(identity: unknown): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      if (req.url?.startsWith("/healthz")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(identity));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe("healthz + probe-then-spawn supervision (#379)", () => {
  const cleanups: Array<() => void> = [];
  const servers: RennetServer[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    for (const s of servers.splice(0)) s.shutdown();
  });
  const dataDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "rennet-supervise-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  it("healthz on the real listener answers the probe with matching identity", async () => {
    const server = await createRennetServer({
      dataDir: dataDir(),
      env: {},
      serverVersion: "9.9.9",
    });
    servers.push(server);
    const identity = await probeHealth(server.wsPort);
    expect(identity).not.toBeNull();
    expect(identity).toMatchObject({
      wsPort: server.wsPort,
      version: "9.9.9",
      protocolVersion: PROTOCOL_VERSION,
      minCompatibleProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
    });
    expect(identity?.pid).toBe(process.pid);
  });

  it("no claim → absent", async () => {
    expect(await findHealthyDaemon(dataDir())).toEqual({ kind: "absent" });
  });

  it("a claim whose port has nothing listening → stale", async () => {
    const dir = dataDir();
    // Port 1 is privileged and unbound in the test env: the probe fails fast.
    const claim = {
      pid: 999_999,
      wsPort: 1,
      protocolVersion: PROTOCOL_VERSION,
      version: "0.0.0",
      startedAt: new Date().toISOString(),
    };
    writeDaemonFile(dir, claim);
    const verdict = await findHealthyDaemon(dir);
    expect(verdict.kind).toBe("stale");
  });

  it("a live compatible daemon → healthy", async () => {
    const dir = dataDir();
    const server = await createRennetServer({ dataDir: dir, env: {}, serverVersion: "1.2.3" });
    servers.push(server);
    writeDaemonFile(dir, {
      pid: process.pid,
      wsPort: server.wsPort,
      protocolVersion: PROTOCOL_VERSION,
      version: "1.2.3",
      startedAt: new Date().toISOString(),
    });
    const verdict = await findHealthyDaemon(dir);
    expect(verdict.kind).toBe("healthy");
  });

  it("a live daemon on an incompatible protocol → incompatible verdict, not healthy", async () => {
    const dir = dataDir();
    const future = await fakeHealthz({
      pid: 4321,
      wsPort: 12_345,
      version: "99.0.0",
      protocolVersion: PROTOCOL_VERSION + 500,
      minCompatibleProtocolVersion: PROTOCOL_VERSION + 500,
    });
    cleanups.push(future.close);
    writeDaemonFile(dir, {
      pid: 4321,
      wsPort: future.port,
      protocolVersion: PROTOCOL_VERSION + 500,
      version: "99.0.0",
      startedAt: new Date().toISOString(),
    });
    const verdict = await findHealthyDaemon(dir);
    expect(verdict.kind).toBe("incompatible");
    if (verdict.kind === "incompatible") expect(verdict.reason).toMatch(/protocol/i);
  });
});
