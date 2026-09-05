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
import { FAKE_SIDECAR } from "./fake-sidecar";
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

  it("puts the board bearer in the sidecar's environment and on no argument list", async () => {
    const f = fixture();
    const running = await start(f);
    const dump = JSON.parse(readFileSync(join(running.claim.baseDir, "fake-spawn.json"), "utf8"));
    // It really was delivered — every harness child the sidecar starts inherits it — so
    // its absence from argv below says something.
    expect(dump.env.RENNET_BOARD_BEARER).toBe(running.boardBearer);
    expect(running.boardBearer.length).toBeGreaterThan(20);
    expect(JSON.stringify(dump.argv)).not.toContain(running.boardBearer);
    // Recorded in the 0600 credentials file, because a later daemon that ADOPTS this
    // sidecar cannot re-mint it: the value is fixed in an environment already handed out.
    expect(readSidecarCredentials(running.claim.baseDir)?.boardBearer).toBe(running.boardBearer);
  }, 20_000);

  it("reuses the recorded board bearer when it respawns on the same base dir", async () => {
    const f = fixture();
    const first = await start(f);
    await stopSidecar(f.dataDir);
    const second = await start(f);
    // A seat's address token is DERIVED from this value, so rotating it on a respawn would
    // change every live seat's url — and both providers refuse a turn whose MCP servers
    // differ from the ones its session was opened with.
    expect(second.boardBearer).toBe(first.boardBearer);
    const dump = JSON.parse(readFileSync(join(second.claim.baseDir, "fake-spawn.json"), "utf8"));
    expect(dump.env.RENNET_BOARD_BEARER).toBe(first.boardBearer);
  }, 30_000);

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

  it("an adopted sidecar carries the board bearer forward", async () => {
    const f = fixture();
    const first = await start(f);
    const adopted = await adoptSidecar(f.dataDir, "abc123");
    expect(adopted?.boardBearer).toBe(first.boardBearer);
  }, 20_000);

  it("refuses to adopt a sidecar that carries no board bearer", async () => {
    const f = fixture();
    const first = await start(f);
    const file = join(first.claim.baseDir, "rennet-credentials.json");
    const { boardBearer, ...withoutBearer } = JSON.parse(readFileSync(file, "utf8"));
    expect(boardBearer).toBeDefined();
    writeFileSync(file, JSON.stringify(withoutBearer));
    // A sidecar spawned before the board server existed has no `RENNET_BOARD_BEARER` in
    // the environment its harness children inherited, so its seats could never reach a
    // board. Refused for the same reason a snapshot mismatch is.
    expect(await adoptSidecar(f.dataDir, "abc123")).toBeNull();
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

  it("sets the board bearer the daemon minted, and never the one a parent shell carried", () => {
    const parent = { PATH: "/bin", RENNET_BOARD_BEARER: "from-the-users-shell" };
    expect(sidecarEnvironment(parent, "minted-by-this-daemon")).toEqual({
      PATH: "/bin",
      T3CODE_TELEMETRY_ENABLED: "false",
      RENNET_BOARD_BEARER: "minted-by-this-daemon",
    });
    // No bearer to set ⇒ the name is absent rather than inherited, so a sidecar without a
    // board server cannot be reached with a value its parent shell happened to hold.
    expect(sidecarEnvironment(parent)).toEqual({
      PATH: "/bin",
      T3CODE_TELEMETRY_ENABLED: "false",
    });
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
