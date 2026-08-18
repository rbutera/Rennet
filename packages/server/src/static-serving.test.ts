import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWsListener, type WsListener, type WsListenerDeps } from "./ws-listener";

// The daemon serves the built browser UI (issue #381, design D2): the static handler slots
// before the 404 when a `uiDist` is configured — `/` → index.html, nested assets by path,
// a path-traversal escape refused, and the daemon still runs headless with no uiDist.

const noopDispatch = vi.fn(async () => ({})) as WsListenerDeps["dispatch"];

describe("daemon static UI serving (#381)", () => {
  const listeners: WsListener[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const listener of listeners.splice(0)) await listener.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixtureUi(): string {
    const root = mkdtempSync(join(tmpdir(), "rennet-ui-"));
    dirs.push(root);
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Rennet</title>");
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "app.js"), "export const x = 1;");
    writeFileSync(join(root, "secret.txt"), "not for the web root's parent to reach");
    return root;
  }

  async function start(uiDist?: string): Promise<string> {
    const listener = await startWsListener({
      dispatch: noopDispatch,
      serverVersion: "test",
      uiDist,
    });
    listeners.push(listener);
    return `http://127.0.0.1:${listener.port}`;
  }

  it("serves index.html at /", async () => {
    const base = await start(fixtureUi());
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("<title>Rennet</title>");
  });

  it("serves a nested asset with its content type", async () => {
    const base = await start(fixtureUi());
    const res = await fetch(`${base}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("export const x");
  });

  it("refuses a path-traversal escape with a 404", async () => {
    const base = await start(fixtureUi());
    // Encoded so the client does not normalise it away before it reaches the daemon.
    const res = await fetch(`${base}/%2e%2e/%2e%2e/etc/hosts`);
    expect(res.status).toBe(404);
  });

  it("404s an asset that does not exist", async () => {
    const base = await start(fixtureUi());
    const res = await fetch(`${base}/assets/missing.js`);
    expect(res.status).toBe(404);
  });

  it("runs headless (404 at /) when no uiDist is configured", async () => {
    const base = await start(undefined);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(404);
    // /healthz is unaffected.
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
  });
});
