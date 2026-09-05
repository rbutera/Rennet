// The T3 Code sidecar the daemon owns (openspec change t3code-sidecar-chat, group 2).
//
// One sidecar per Rennet data dir, running the server bundle built from the vendored
// snapshot (`vendor/t3code/apps/server/dist/bin.mjs`) under a PRIVATE base dir,
// `<dataDir>/t3`, never the user's own `~/.t3`. Its claim (`<dataDir>/t3-sidecar.json`)
// mirrors `daemon.json`: a claim to verify, never truth. Verification is the sidecar's
// own unauthenticated `/.well-known/t3/environment` plus its `userdata/server-runtime.json`
// (written by T3 only after its listener has a real address), cross-checked on pid and
// port so a reused pid reads as stale.
//
// Credentials never touch argv or the environment. The daemon mints a bootstrap token,
// hands it over fd 3 as T3's desktop bootstrap envelope, exchanges it at `/oauth/token`
// for a bearer session, and keeps both in `<dataDir>/t3/rennet-credentials.json` (owner
// read/write only). Clients never read that file; they get sidecar access through the
// daemon (`chat.t3Session`).
//
// This module imports no `effect` and no `@t3tools/*`: it is process supervision over
// plain Node. The RPC client (`./client.ts`) is the one Rennet module that imports them.
//
// Docs: docs/developing/concepts/t3code-sidecar.md

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BOARD_BEARER_ENV_VAR } from "../board/board-credentials";
import { isRunning } from "../process-state";

/** The sidecar's claim: where the daemon says its sidecar listens, and which daemon spawned it. */
export const sidecarClaimSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  /** The daemon that spawned it; a later daemon adopts the sidecar if it still answers. */
  daemonPid: z.number().int().positive(),
  /** The vendored snapshot's upstream commit, so a fold's bundle never adopts an older one. */
  upstreamCommit: z.string(),
  baseDir: z.string(),
  startedAt: z.string(),
});
export type SidecarClaim = z.infer<typeof sidecarClaimSchema>;

/** T3's `userdata/server-runtime.json`; written after its listener binds, removed on clean exit. */
const serverRuntimeSchema = z.object({
  version: z.literal(1),
  pid: z.number().int(),
  port: z.number().int(),
  origin: z.string(),
});

/** T3's unauthenticated environment descriptor at `/.well-known/t3/environment`. */
const environmentDescriptorSchema = z.object({
  environmentId: z.string(),
  serverVersion: z.string(),
});
export type SidecarEnvironment = z.infer<typeof environmentDescriptorSchema>;

const credentialsSchema = z.object({
  bootstrapToken: z.string(),
  accessToken: z.string(),
  /** ISO; the bearer's expiry as T3 reported it. */
  expiresAt: z.string(),
  /**
   * The daemon's board-server bearer (`lens-board-tools` D8), minted at spawn and placed
   * in the sidecar's environment under `RENNET_BOARD_BEARER` — which is where every
   * harness child inherits it from, and why it is fixed for this sidecar's life.
   *
   * Optional because a sidecar spawned before the board server existed has none, and its
   * children therefore carry no such variable; {@link adoptSidecar} refuses to adopt that
   * sidecar rather than adopting one whose seats could never reach a board.
   */
  boardBearer: z.string().optional(),
});
export type SidecarCredentials = z.infer<typeof credentialsSchema>;

export type SidecarVerdict =
  | { readonly kind: "absent" }
  | { readonly kind: "stale"; readonly claim: SidecarClaim }
  | {
      readonly kind: "healthy";
      readonly claim: SidecarClaim;
      readonly environment: SidecarEnvironment;
    };

const PROBE_TIMEOUT_MS = 500;
const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

export function sidecarClaimPath(dataDir: string): string {
  return join(dataDir, "t3-sidecar.json");
}

export function sidecarBaseDir(dataDir: string): string {
  return join(dataDir, "t3");
}

function credentialsPath(baseDir: string): string {
  return join(baseDir, "rennet-credentials.json");
}

function writeAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, mode === undefined ? {} : { mode });
  renameSync(tmp, path);
}

export function writeSidecarClaim(dataDir: string, claim: SidecarClaim): void {
  writeAtomic(sidecarClaimPath(dataDir), `${JSON.stringify(claim, null, 2)}\n`);
}

export function readSidecarClaim(dataDir: string): SidecarClaim | null {
  try {
    const parsed = sidecarClaimSchema.safeParse(
      JSON.parse(readFileSync(sidecarClaimPath(dataDir), "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Remove the claim only while it still names `expectedPid`. */
export function removeSidecarClaim(dataDir: string, expectedPid: number): boolean {
  if (readSidecarClaim(dataDir)?.pid !== expectedPid) return false;
  try {
    unlinkSync(sidecarClaimPath(dataDir));
    return true;
  } catch {
    return false;
  }
}

export function readSidecarCredentials(baseDir: string): SidecarCredentials | null {
  try {
    const parsed = credentialsSchema.safeParse(
      JSON.parse(readFileSync(credentialsPath(baseDir), "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeSidecarCredentials(baseDir: string, credentials: SidecarCredentials): void {
  writeAtomic(credentialsPath(baseDir), `${JSON.stringify(credentials)}\n`, 0o600);
}

function readServerRuntime(baseDir: string): z.infer<typeof serverRuntimeSchema> | null {
  try {
    const parsed = serverRuntimeSchema.safeParse(
      JSON.parse(readFileSync(join(baseDir, "userdata", "server-runtime.json"), "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** GET the sidecar's environment descriptor; null when it does not answer in time. */
export async function probeSidecar(
  port: number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<SidecarEnvironment | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const parsed = environmentDescriptorSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Read the claim and verify it: the process at that port answers, and T3's own runtime
 * record agrees on pid and port. Anything less is `stale`.
 */
export async function findHealthySidecar(dataDir: string): Promise<SidecarVerdict> {
  const claim = readSidecarClaim(dataDir);
  if (!claim) return { kind: "absent" };
  const environment = await probeSidecar(claim.port);
  if (!environment) return { kind: "stale", claim };
  const runtime = readServerRuntime(claim.baseDir);
  if (!runtime || runtime.pid !== claim.pid || runtime.port !== claim.port) {
    return { kind: "stale", claim };
  }
  return { kind: "healthy", claim, environment };
}

/**
 * Is that sidecar pid still doing work? Signal-0 alone said yes to a zombie — an exited,
 * unreaped child that serves nothing — so the stop below waited out its whole budget and
 * reported a timeout for a process that was already gone (#820).
 */
export function isProcessAlive(pid: number): boolean {
  return isRunning(pid);
}

/** Bind port 0 on loopback, read the number back, release it. T3 validates `--port` as 1..65535. */
export function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolvePort(port) : reject(new Error("no port"))));
    });
  });
}

export interface ProviderBinaries {
  readonly claude?: string;
  readonly codex?: string;
}

/**
 * Write the sidecar's provider settings with the absolute binaries Rennet discovered.
 * Merges into whatever the user changed through T3's own settings; only `binaryPath` is
 * ours. Home paths stay untouched, so the harness keeps the user's normal login.
 */
export function seedProviderSettings(baseDir: string, binaries: ProviderBinaries): void {
  const path = join(baseDir, "userdata", "settings.json");
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable: start from empty; T3 decodes leniently with defaults.
  }
  const providers =
    current.providers && typeof current.providers === "object"
      ? { ...(current.providers as Record<string, unknown>) }
      : {};
  const merge = (key: string, binaryPath: string | undefined) => {
    if (!binaryPath) return;
    const existing =
      providers[key] && typeof providers[key] === "object"
        ? (providers[key] as Record<string, unknown>)
        : {};
    providers[key] = { ...existing, binaryPath };
  };
  merge("claudeAgent", binaries.claude);
  merge("codex", binaries.codex);
  writeAtomic(path, `${JSON.stringify({ ...current, providers }, null, 2)}\n`);
}

/** The last lines of the sidecar log, for an error that would otherwise point at a file nobody can open. */
function logTail(path: string, bytes = 2_000): string {
  try {
    const text = readFileSync(path, "utf8");
    return `\n--- sidecar.log (tail) ---\n${text.slice(-bytes)}`;
  } catch {
    return "";
  }
}

/**
 * Drop every T3 knob the parent shell may carry, then set exactly what the sidecar needs.
 *
 * `boardBearer` is the one credential that travels by environment, because it is the only
 * way it can: a caller-supplied MCP server names an environment VARIABLE on the turn and
 * the harness child reads its value out of the environment it inherited from here. It is
 * therefore on no argument list, and a parent shell's own value for that name is dropped
 * rather than trusted.
 */
export function sidecarEnvironment(
  env: NodeJS.ProcessEnv,
  boardBearer?: string,
): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("T3CODE_") || key === BOARD_BEARER_ENV_VAR) continue;
    cleaned[key] = value;
  }
  cleaned.T3CODE_TELEMETRY_ENABLED = "false";
  if (boardBearer !== undefined) cleaned[BOARD_BEARER_ENV_VAR] = boardBearer;
  return cleaned;
}

/** The desktop bootstrap envelope T3 reads from `--bootstrap-fd` (contracts/desktopBootstrap.ts). */
export function bootstrapEnvelope(port: number, baseDir: string, token: string): string {
  return `${JSON.stringify({
    mode: "desktop",
    noBrowser: true,
    port,
    host: "127.0.0.1",
    t3Home: baseDir,
    desktopBootstrapToken: token,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  })}\n`;
}

/** The argv the daemon spawns. No credential rides here; `--bootstrap-fd 3` names the pipe. */
export function sidecarArgs(bundlePath: string, port: number, baseDir: string): string[] {
  return [
    bundlePath,
    "serve",
    "--mode",
    "desktop",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--no-browser",
    "--base-dir",
    baseDir,
    "--bootstrap-fd",
    "3",
  ];
}

async function exchangeBootstrapToken(
  origin: string,
  token: string,
): Promise<{ accessToken: string; expiresAt: string }> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: token,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_label: "Rennet daemon",
  });
  const res = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`sidecar token exchange failed: HTTP ${res.status}`);
  const parsed = z
    .object({ access_token: z.string(), expires_in: z.number() })
    .safeParse(await res.json());
  if (!parsed.success) throw new Error("sidecar token exchange returned an unexpected body");
  return {
    accessToken: parsed.data.access_token,
    expiresAt: new Date(Date.now() + parsed.data.expires_in * 1000).toISOString(),
  };
}

/** True when the bearer still opens an authenticated route. */
export async function verifyAccessToken(origin: string, accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 4),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SpawnSidecarOptions {
  readonly dataDir: string;
  readonly bundlePath: string;
  readonly upstreamCommit: string;
  readonly env: NodeJS.ProcessEnv;
  readonly binaries: ProviderBinaries;
  /** The Node executable to run the bundle with; defaults to this process's. */
  readonly execPath?: string;
  readonly readyTimeoutMs?: number;
}

export interface RunningSidecar {
  readonly claim: SidecarClaim;
  readonly origin: string;
  readonly environment: SidecarEnvironment;
  readonly credentials: SidecarCredentials;
  /**
   * The board server's process bearer, as it stands in this sidecar's environment. Every
   * harness child the sidecar starts inherits it under `RENNET_BOARD_BEARER`, so it is
   * what the daemon's board listener must accept.
   */
  readonly boardBearer: string;
  /** The child when this daemon spawned it; absent when adopted from a previous daemon. */
  readonly child?: ChildProcess;
}

/**
 * Spawn the bundle, hand the bootstrap envelope over fd 3, wait for T3's runtime record
 * and well-known probe, exchange the token, publish the claim.
 */
export async function spawnSidecar(options: SpawnSidecarOptions): Promise<RunningSidecar> {
  const baseDir = sidecarBaseDir(options.dataDir);
  mkdirSync(join(baseDir, "userdata"), { recursive: true });
  seedProviderSettings(baseDir, options.binaries);
  const port = await pickFreePort();
  const bootstrapToken = randomBytes(24).toString("base64url");
  // The board server's process bearer (D8). Minted here because the sidecar's environment
  // is fixed at spawn and every harness child inherits it from there.
  //
  // REUSED across respawns of the same base dir when one was already recorded, because a
  // seat's address token is derived from it: rotating it on every respawn would change
  // every live seat's url, and both providers refuse a turn whose MCP servers differ from
  // the ones its session was opened with. The value is one 32-byte secret in a 0600 file
  // that only this machine's daemon and its own sidecar ever see; rotating it buys nothing
  // that file's permissions do not already give.
  const boardBearer =
    readSidecarCredentials(baseDir)?.boardBearer ?? randomBytes(32).toString("base64url");
  const logFd = openSync(join(baseDir, "sidecar.log"), "a");
  let child: ChildProcess;
  try {
    child = spawn(
      options.execPath ?? process.execPath,
      sidecarArgs(options.bundlePath, port, baseDir),
      {
        cwd: baseDir,
        env: sidecarEnvironment(options.env, boardBearer),
        stdio: ["ignore", logFd, logFd, "pipe"],
      },
    );
  } finally {
    closeSync(logFd);
  }
  const pipe = child.stdio[3];
  if (!pipe || !("write" in pipe)) throw new Error("sidecar bootstrap pipe was not opened");

  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let channelFailure: Error | null = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  // Both listeners are attached BEFORE the envelope is written, and both exist to stop an
  // UNCAUGHT exception rather than to add a new failure mode.
  //
  // A sidecar that dies the instant it starts — a bundle that is not there, one Node cannot
  // load, an immediate crash — closes the read end of this pipe under the write below. A
  // `Writable` with no `error` listener re-throws EPIPE/ECONNRESET as an uncaught exception,
  // which takes the whole process with it; the same is true of `spawn`'s own `error` event.
  // That used to be a crash a reviewer had to open the chat dock to reach. Since #849 the
  // daemon spawns the sidecar at launch, so it would be a crash on BOOT, in a path whose
  // whole promise is that the daemon comes up either way. Seen on Linux as `read ECONNRESET`
  // and not on macOS, where the small envelope usually lands in the pipe buffer before the
  // child is gone — the platform decides whether it fires, so neither side may be relied on.
  //
  // Nothing is swallowed: the readiness loop below reports the exit it already knows how to
  // describe (with the log tail), and a spawn that never produced a process reports this.
  const captureChannelFailure = (error: Error): void => {
    channelFailure ??= error;
  };
  child.once("error", captureChannelFailure);
  pipe.once("error", captureChannelFailure);
  pipe.end(bootstrapEnvelope(port, baseDir, bootstrapToken));

  const deadline = Date.now() + (options.readyTimeoutMs ?? READY_TIMEOUT_MS);
  let environment: SidecarEnvironment | null = null;
  while (Date.now() < deadline) {
    if (exited) {
      const { code, signal } = exited as { code: number | null; signal: NodeJS.Signals | null };
      throw new Error(
        `sidecar exited before it was ready (code ${code}, signal ${signal}); see ${join(baseDir, "sidecar.log")}${logTail(join(baseDir, "sidecar.log"))}`,
      );
    }
    // A process that never started at all: `exit` never fires, so without this the wait runs
    // out and reports a timeout for something that failed in the first millisecond.
    // The cast is the same one `exited` needs above: both are assigned only from a listener,
    // which control-flow analysis cannot see, so each narrows to `never` inside this loop.
    if (channelFailure && child.pid === undefined) {
      throw new Error(`sidecar could not be started: ${(channelFailure as Error).message}`);
    }
    const runtime = readServerRuntime(baseDir);
    if (runtime && runtime.pid === child.pid && runtime.port === port) {
      environment = await probeSidecar(port);
      if (environment) break;
    }
    await sleep(100);
  }
  if (!environment || child.pid === undefined) {
    child.kill("SIGTERM");
    throw new Error(
      `sidecar did not become ready within ${options.readyTimeoutMs ?? READY_TIMEOUT_MS}ms`,
    );
  }
  const origin = `http://127.0.0.1:${port}`;
  const exchanged = await exchangeBootstrapToken(origin, bootstrapToken);
  const credentials: SidecarCredentials = { bootstrapToken, boardBearer, ...exchanged };
  writeSidecarCredentials(baseDir, credentials);
  const claim: SidecarClaim = {
    pid: child.pid,
    port,
    daemonPid: process.pid,
    upstreamCommit: options.upstreamCommit,
    baseDir,
    startedAt: new Date().toISOString(),
  };
  writeSidecarClaim(options.dataDir, claim);
  return { claim, origin, environment, credentials, boardBearer, child };
}

/**
 * Adopt a verified sidecar from a previous daemon: same snapshot, alive, and a bearer
 * that still works (re-exchanged from the bootstrap grant when it does not). Returns
 * null when the sidecar must be respawned.
 */
export async function adoptSidecar(
  dataDir: string,
  upstreamCommit: string,
): Promise<RunningSidecar | null> {
  const verdict = await findHealthySidecar(dataDir);
  if (verdict.kind !== "healthy") return null;
  if (verdict.claim.upstreamCommit !== upstreamCommit) return null;
  const origin = `http://127.0.0.1:${verdict.claim.port}`;
  const stored = readSidecarCredentials(verdict.claim.baseDir);
  if (!stored) return null;
  // A sidecar spawned before the board server existed carries no `RENNET_BOARD_BEARER` in
  // its environment, so its harness children could never reach a board however the daemon
  // addressed them. Refused here for the same reason a snapshot mismatch is: this daemon
  // cannot use it, and a respawn is the honest answer rather than a seat that 401s.
  if (stored.boardBearer === undefined) return null;
  let credentials = stored;
  if (!(await verifyAccessToken(origin, stored.accessToken))) {
    try {
      credentials = { ...stored, ...(await exchangeBootstrapToken(origin, stored.bootstrapToken)) };
      writeSidecarCredentials(verdict.claim.baseDir, credentials);
    } catch {
      return null;
    }
  }
  return {
    claim: verdict.claim,
    origin,
    environment: verdict.environment,
    credentials,
    boardBearer: credentials.boardBearer ?? stored.boardBearer,
  };
}

export type StopSidecarOutcome =
  | { readonly kind: "stopped" }
  | { readonly kind: "absent" }
  | { readonly kind: "timeout"; readonly pid: number };

/**
 * SIGTERM the claimed sidecar, wait a bounded time for the process to die, clear the
 * claim. A sidecar that will not exit is reported, not killed harder: the next start
 * reaps it through the stale-claim path.
 */
export async function stopSidecar(
  dataDir: string,
  { timeoutMs = STOP_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<StopSidecarOutcome> {
  const claim = readSidecarClaim(dataDir);
  if (!claim) return { kind: "absent" };
  if (!isProcessAlive(claim.pid)) {
    removeSidecarClaim(dataDir, claim.pid);
    return { kind: "stopped" };
  }
  // Only signal a pid that is verifiably our sidecar: its runtime record must agree.
  const runtime = readServerRuntime(claim.baseDir);
  if (!runtime || runtime.pid !== claim.pid) {
    removeSidecarClaim(dataDir, claim.pid);
    return { kind: "stopped" };
  }
  try {
    process.kill(claim.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      removeSidecarClaim(dataDir, claim.pid);
      return { kind: "stopped" };
    }
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(claim.pid)) {
      removeSidecarClaim(dataDir, claim.pid);
      return { kind: "stopped" };
    }
    await sleep(100);
  }
  return { kind: "timeout", pid: claim.pid };
}

/**
 * Locate the vendored server bundle. `RENNET_T3_BUNDLE` overrides; otherwise walk up from
 * this module's location looking for the workspace's `vendor/t3code/apps/server/dist`.
 *
 * The walk works in the `rennet` CLI bundle too: `build-server-cli.mjs` defines
 * `import.meta.url` as the bundle's own `pathToFileURL(__filename)`, and
 * `packages/server/dist` is four levels under a checkout's root — so a `rennet serve` run
 * from a built checkout finds the vendored bundle with no flag and no env. An INSTALLED
 * CLI is outside any checkout and finds nothing, which is what `--t3-bundle` and
 * `RENNET_T3_BUNDLE` are for, and what the packaged app sets (#875).
 */
export function resolveSidecarBundle(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.RENNET_T3_BUNDLE;
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  try {
    const url = import.meta.url;
    if (!url) return undefined;
    let dir = dirname(fileURLToPath(url));
    for (let i = 0; i < 6; i += 1) {
      const candidate = resolve(dir, "vendor/t3code/apps/server/dist/bin.mjs");
      if (existsSync(candidate)) return candidate;
      dir = dirname(dir);
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** The vendored base commit, read from `vendor/t3code/UPSTREAM.json` beside the bundle. */
export function readUpstreamCommit(bundlePath: string): string {
  try {
    const upstream = resolve(dirname(bundlePath), "../../../UPSTREAM.json");
    const parsed = z
      .object({ commit: z.string() })
      .safeParse(JSON.parse(readFileSync(upstream, "utf8")));
    return parsed.success ? parsed.data.commit : "unknown";
  } catch {
    return "unknown";
  }
}
