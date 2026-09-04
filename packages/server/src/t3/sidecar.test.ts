import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adoptSidecar,
  findHealthySidecar,
  isProcessAlive,
  type RunningSidecar,
  readSidecarClaim,
  readSidecarCredentials,
  resolveSidecarBundle,
  sidecarBaseDir,
  sidecarEnvironment,
  spawnSidecar,
  stopSidecar,
  writeSidecarClaim,
} from "./sidecar";

/**
 * A stand-in for the vendored T3 server that honours the same parent contract: reads
 * the bootstrap envelope from fd 3, listens on the envelope's port, writes
 * `userdata/server-runtime.json` once bound, answers the well-known probe, exchanges
 * the bootstrap token at `/oauth/token`, checks bearers on `/api/auth/websocket-ticket`,
 * and exits on SIGTERM. It also dumps its argv and env so a test can prove no credential
 * travelled that way. `FAKE_T3_IGNORE_SIGTERM=1` makes it refuse to die.
 */
const FAKE_SIDECAR = `
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
// Read the pipe by descriptor number: /dev/fd/3 is not readable as a path on every Linux.
const line = fs.readFileSync(3, "utf8").split("\\n")[0];
const envelope = JSON.parse(line);
const home = envelope.t3Home;
fs.mkdirSync(path.join(home, "userdata"), { recursive: true });
fs.writeFileSync(path.join(home, "fake-spawn.json"), JSON.stringify({ argv: process.argv, env: process.env, envelope }));
const access = "access-" + Math.random().toString(36).slice(2);
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.url === "/.well-known/t3/environment") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ environmentId: "env-1", label: "fake", platform: "darwin", serverVersion: "0.0.38", capabilities: [] }));
      return;
    }
    if (req.url === "/oauth/token" && req.method === "POST") {
      const form = new URLSearchParams(body);
      if (form.get("subject_token") !== envelope.desktopBootstrapToken || form.get("subject_token_type") !== "urn:t3:params:oauth:token-type:environment-bootstrap") {
        res.writeHead(401); res.end("{}"); return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: access, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 2592000, scope: "orchestration:read" }));
      return;
    }
    if (req.url === "/api/auth/websocket-ticket" && req.method === "POST") {
      const ok = req.headers.authorization === "Bearer " + access;
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { ticket: "t", expiresAt: "x" } : {}));
      return;
    }
    res.writeHead(404); res.end();
  });
});
server.listen(envelope.port, envelope.host, () => {
  const runtime = path.join(home, "userdata", "server-runtime.json");
  fs.writeFileSync(runtime, JSON.stringify({ version: 1, pid: process.pid, host: envelope.host, port: envelope.port, origin: "http://" + envelope.host + ":" + envelope.port, startedAt: new Date().toISOString() }) + "\\n");
  process.on("SIGTERM", () => {
    if (process.env.FAKE_T3_IGNORE_SIGTERM === "1") return;
    try { fs.unlinkSync(runtime); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 200).unref();
  });
});
`;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rennet-t3-sidecar-"));
  // The real bundle keeps writing logs for a moment after SIGKILL; retry the sweep.
  cleanups.push(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const dataDir = join(root, "data");
  const bundlePath = join(root, "fake-t3.cjs");
  writeFileSync(bundlePath, FAKE_SIDECAR);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, "home"),
    T3CODE_RELAY_URL: "https://relay.example",
    T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test",
    T3CODE_TELEMETRY_ENABLED: "true",
  };
  return { root, dataDir, bundlePath, env };
}

async function start(
  f: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof spawnSidecar>[0]> = {},
): Promise<RunningSidecar> {
  const running = await spawnSidecar({
    dataDir: f.dataDir,
    bundlePath: f.bundlePath,
    upstreamCommit: "abc123",
    env: f.env,
    binaries: { claude: "/opt/bin/claude", codex: "/opt/bin/codex" },
    readyTimeoutMs: 10_000,
    ...overrides,
  });
  cleanups.push(async () => {
    running.child?.kill("SIGKILL");
  });
  return running;
}

describe("t3 sidecar: spawn, claim, credentials", () => {
  it("spawns, becomes ready, publishes a verified claim, and stores owner-only credentials", async () => {
    const f = fixture();
    const running = await start(f);
    expect(running.claim.pid).toBe(running.child?.pid);
    expect(running.claim.daemonPid).toBe(process.pid);
    expect(running.claim.baseDir).toBe(sidecarBaseDir(f.dataDir));
    expect(readSidecarClaim(f.dataDir)).toEqual(running.claim);
    expect(running.environment.environmentId).toBe("env-1");

    const verdict = await findHealthySidecar(f.dataDir);
    expect(verdict.kind).toBe("healthy");

    const credentialsFile = join(running.claim.baseDir, "rennet-credentials.json");
    expect(statSync(credentialsFile).mode & 0o777).toBe(0o600);
    expect(readSidecarCredentials(running.claim.baseDir)?.accessToken).toBe(
      running.credentials.accessToken,
    );
  }, 20_000);

  it("keeps the credential off argv and env, and strips the parent's T3 knobs", async () => {
    const f = fixture();
    const running = await start(f);
    const dump = JSON.parse(readFileSync(join(running.claim.baseDir, "fake-spawn.json"), "utf8"));
    const token = running.credentials.bootstrapToken;
    // The token really was delivered (over fd 3) — so its absence below is meaningful.
    expect(dump.envelope.desktopBootstrapToken).toBe(token);
    expect(JSON.stringify(dump.argv)).not.toContain(token);
    expect(JSON.stringify(dump.env)).not.toContain(token);
    expect(JSON.stringify(dump.env)).not.toContain(running.credentials.accessToken);
    expect(dump.argv).toContain("--bootstrap-fd");
    expect(dump.argv).toContain(String(running.claim.port));
    expect(dump.env.T3CODE_TELEMETRY_ENABLED).toBe("false");
    expect(dump.env.T3CODE_RELAY_URL).toBeUndefined();
    expect(dump.env.T3CODE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
  }, 20_000);

  it("seeds provider binaries into settings.json without clobbering the user's other keys", async () => {
    const f = fixture();
    const userdata = join(sidecarBaseDir(f.dataDir), "userdata");
    mkdirSync(userdata, { recursive: true });
    writeFileSync(
      join(userdata, "settings.json"),
      JSON.stringify({
        theme: "dark",
        providers: { codex: { homePath: "/keep/me", binaryPath: "/stale/codex" } },
      }),
    );
    await start(f);
    const settings = JSON.parse(readFileSync(join(userdata, "settings.json"), "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.providers.codex).toEqual({
      homePath: "/keep/me",
      binaryPath: "/opt/bin/codex",
    });
    expect(settings.providers.claudeAgent).toEqual({ binaryPath: "/opt/bin/claude" });
  }, 20_000);

  it("never touches the user's own ~/.t3", async () => {
    const f = fixture();
    const running = await start(f);
    expect(existsSync(join(f.env.HOME as string, ".t3"))).toBe(false);
    expect(running.claim.baseDir.startsWith(f.dataDir)).toBe(true);
  }, 20_000);
});

describe("t3 sidecar: adoption, stale claims, stop", () => {
  it("a second daemon adopts the live sidecar and leaves the claim unchanged", async () => {
    const f = fixture();
    const first = await start(f);
    const adopted = await adoptSidecar(f.dataDir, "abc123");
    expect(adopted?.claim).toEqual(first.claim);
    expect(adopted?.child).toBeUndefined();
    expect(adopted?.credentials.accessToken).toBe(first.credentials.accessToken);
  }, 20_000);

  it("refuses to adopt a sidecar built from a different snapshot", async () => {
    const f = fixture();
    await start(f);
    expect(await adoptSidecar(f.dataDir, "def456")).toBeNull();
  }, 20_000);

  it("re-exchanges the bootstrap grant when the stored bearer no longer works", async () => {
    const f = fixture();
    const first = await start(f);
    const file = join(first.claim.baseDir, "rennet-credentials.json");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...stored, accessToken: "revoked" }));
    const adopted = await adoptSidecar(f.dataDir, "abc123");
    expect(adopted?.credentials.accessToken).toBe(first.credentials.accessToken);
    expect(readSidecarCredentials(first.claim.baseDir)?.accessToken).toBe(
      first.credentials.accessToken,
    );
  }, 20_000);

  it("reads a claim for a dead pid as stale and reaps it on stop", async () => {
    const f = fixture();
    mkdirSync(f.dataDir, { recursive: true });
    writeSidecarClaim(f.dataDir, {
      pid: 2_147_483_000,
      port: 1,
      daemonPid: process.pid,
      upstreamCommit: "abc123",
      baseDir: sidecarBaseDir(f.dataDir),
      startedAt: new Date().toISOString(),
    });
    expect((await findHealthySidecar(f.dataDir)).kind).toBe("stale");
    expect(await adoptSidecar(f.dataDir, "abc123")).toBeNull();
    expect(await stopSidecar(f.dataDir)).toEqual({ kind: "stopped" });
    expect(readSidecarClaim(f.dataDir)).toBeNull();
    expect((await findHealthySidecar(f.dataDir)).kind).toBe("absent");
  });

  it("stop sends SIGTERM, waits for the process to die, and clears the claim", async () => {
    const f = fixture();
    const running = await start(f);
    const pid = running.claim.pid;
    expect(await stopSidecar(f.dataDir)).toEqual({ kind: "stopped" });
    expect(readSidecarClaim(f.dataDir)).toBeNull();
    // The stop ends when the process is no longer RUNNING, which includes the instant after
    // it exits and before its parent reaps it (#820) — a zombie serves nothing.
    expect(isProcessAlive(pid)).toBe(false);
    // …and the pid really does leave the table once this process reaps its child.
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    expect(await stopSidecar(f.dataDir)).toEqual({ kind: "absent" });
  }, 20_000);

  it("reports a timeout, keeps the claim, and leaves a stubborn sidecar for the next start", async () => {
    const f = fixture();
    const running = await start(f, { env: { ...f.env, FAKE_T3_IGNORE_SIGTERM: "1" } });
    const outcome = await stopSidecar(f.dataDir, { timeoutMs: 400 });
    expect(outcome).toEqual({ kind: "timeout", pid: running.claim.pid });
    expect(readSidecarClaim(f.dataDir)?.pid).toBe(running.claim.pid);
  }, 20_000);
});

describe("t3 sidecar: environment", () => {
  it("drops every T3CODE_* key from the parent and forces telemetry off", () => {
    const env = sidecarEnvironment({ PATH: "/bin", T3CODE_HOME: "/x", T3CODE_PORT: "9" });
    expect(env).toEqual({ PATH: "/bin", T3CODE_TELEMETRY_ENABLED: "false" });
  });
});

const realBundle = resolveSidecarBundle({});
describe.skipIf(!realBundle)("t3 sidecar: the vendored bundle", () => {
  it("starts on a private base dir, answers the probe, exchanges the token, and stops", async () => {
    const f = fixture();
    const running = await spawnSidecar({
      dataDir: f.dataDir,
      bundlePath: realBundle as string,
      upstreamCommit: "real",
      env: f.env,
      binaries: {},
      readyTimeoutMs: 30_000,
    });
    cleanups.push(() => {
      running.child?.kill("SIGKILL");
    });
    expect(running.environment.serverVersion).toMatch(/\d+\.\d+\.\d+/);
    expect(running.credentials.accessToken.length).toBeGreaterThan(10);
    expect(existsSync(join(f.env.HOME as string, ".t3"))).toBe(false);
    expect((await findHealthySidecar(f.dataDir)).kind).toBe("healthy");
    expect(await stopSidecar(f.dataDir)).toEqual({ kind: "stopped" });
  }, 60_000);
});
