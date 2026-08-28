import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWsListener, type WsListener, type WsListenerDeps } from "./ws-listener";

/** GET `path` VERBATIM — `node:http` passes its `path` option through without the URL-spec
 *  normalisation `fetch` applies, which is the only way to send dot segments to the daemon. */
function rawGet(base: string, path: string): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  return new Promise((resolveBody, reject) => {
    const request = get({ host: url.hostname, port: url.port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolveBody({ status: res.statusCode ?? 0, body }));
    });
    request.on("error", reject);
  });
}

// The daemon serves the built browser UI (issue #381, design D2): the static handler slots
// before the 404 when a `uiDist` is configured — `/` → index.html, nested assets by path,
// client routes falling back to the entry document, an in-root symlink that escapes the root
// refused, and the daemon still runs headless with no uiDist.

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

  it("serves index.html when uiDist is relative", async () => {
    const uiDist = fixtureUi();
    const base = await start(relative(process.cwd(), uiDist));
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Rennet</title>");
  });

  it("serves a nested asset with its content type", async () => {
    const base = await start(fixtureUi());
    const res = await fetch(`${base}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("export const x");
  });

  it("keeps a dot-segmented request a 404, and does not reach the resolve guard", async () => {
    const base = await start(fixtureUi());
    // ⚠️ WHAT THIS DOES NOT DO, stated because two earlier versions of this comment claimed it
    // did: it does not exercise `serveStatic`'s `target.startsWith(root + sep)` guard. `new URL()`
    // resolves `%2e%2e` per the URL spec and `path.normalize` collapses a leading `..` off an
    // absolute path, so a request path is ALWAYS inside the root by the time it is resolved —
    // the guard is unreachable over HTTP and is defence-in-depth against a future non-HTTP
    // caller, not something a request can trip. The realpath escape it exists for is covered by
    // the symlink test below, which is the only test in this file that reaches an escape at all.
    //
    // What this DOES pin, and it became load-bearing when the client-route fallback landed: a
    // dot-segmented request stays a 404 rather than being handed the app document. Sent raw over
    // `node:http`, whose `path` is passed through verbatim — `fetch` resolves the dot segments
    // away in the CLIENT, so a fetch of these addresses never sends them at all.
    expect((await rawGet(base, "/%2e%2e/%2e%2e/etc/hosts")).status).toBe(404);
    // Without the `dotSegmented` check this one returns 200: the path is extension-less, so the
    // fallback would otherwise claim it as a client route.
    expect((await rawGet(base, "/%2e%2e/%2e%2e/new-chat")).status).toBe(404);
  });

  it("refuses an in-root symlink that points outside uiDist", async () => {
    const uiDist = fixtureUi();
    const outside = mkdtempSync(join(tmpdir(), "rennet-ui-outside-"));
    dirs.push(outside);
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "outside secret");
    symlinkSync(secret, join(uiDist, "leak.txt"));

    const base = await start(uiDist);
    const res = await fetch(`${base}/leak.txt`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("outside secret");
  });

  it("404s an asset that does not exist", async () => {
    const base = await start(fixtureUi());
    const res = await fetch(`${base}/assets/missing.js`);
    expect(res.status).toBe(404);
  });

  it("serves the entry document for a client route, so a refresh is not a dead end", async () => {
    // The router replaces `/` with `/new-chat` on boot, so a served tab is ALWAYS on a client
    // route after the first paint. Without this the shell was a one-visit surface: refresh,
    // bookmark, or a shared `/s/<slug>` link all answered "not found".
    const base = await start(fixtureUi());
    for (const route of ["/new-chat", "/s/abc123", "/settings/appearance"]) {
      const res = await fetch(`${base}${route}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("<title>Rennet</title>");
    }
    // A missing FILE still 404s — handing an HTML document to a script tag is not a fallback.
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    // (The dot-segmented case lives in the test above, its one home.)
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
