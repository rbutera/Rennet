// The process entry the desktop shell spawns (detached, via ELECTRON_RUN_AS_NODE) and
// `rennet serve` runs in the foreground. Kept thin so daemon.ts stays a pure, importable
// module: this file is the only place `runDaemon` executes on load, and it is never
// imported by a test or another module. Bundled to `dist/server/index.cjs` (#379).
import { setDefaultResultOrder } from "node:dns";
import { existsSync } from "node:fs";
import { setDefaultAutoSelectFamily, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDaemonConfig, runDaemon } from "./daemon";

// Dual-stack hardening (field bug, lancelot 2026-08-19): on a machine whose IPv6
// route is dead while IPv4 works, the daemon's GitHub connects burned the whole
// undici connect budget on the broken family and surfaced "Connect Timeout Error
// github.com:443" for hours — while curl on the same box answered in 91ms over v4.
// The daemon's only egress is GitHub + the loopback/tailnet WS, so preferring
// IPv4 answers and racing families aggressively is safe process-wide:
//  • ipv4first: v4 addresses attempted before v6 when both resolve.
//  • autoSelectFamily + 300ms attempt timeout: a dead family forfeits within
//    300ms instead of holding the connect budget (Happy Eyeballs, forced on).
// Plain-Node built-ins — no dependency, no behavior change on healthy networks
// beyond attempt ordering.
setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(true);
setDefaultAutoSelectFamilyAttemptTimeout(300);

// The served browser UI (issue #381, design D2): by convention the built `browser` bundle
// is a sibling of this server bundle (`dist/server` + `dist/browser`). Resolve it from this
// module's own location; absent ⇒ the daemon runs headless. `--ui-dist` (parsed in
// resolveDaemonConfig) overrides. In the CLI's esbuild bundle import.meta.url is empty, so
// this yields undefined there — that path relies on `--ui-dist` instead.
function defaultUiDist(): string | undefined {
  try {
    const url = import.meta.url;
    if (!url) return undefined;
    const candidate = resolve(dirname(fileURLToPath(url)), "../browser");
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

let config: ReturnType<typeof resolveDaemonConfig> | undefined;
try {
  config = resolveDaemonConfig(process.argv.slice(2), process.env);
} catch (error) {
  process.stderr.write(
    `rennet daemon: ${error instanceof Error ? error.message : String(error)}\nUsage: rennet-daemon [--data-dir <dir>] [--server-version <version>] [--ui-dist <dir>]\n`,
  );
  process.exitCode = 2;
}

if (config) {
  void runDaemon({ ...config, uiDist: config.uiDist ?? defaultUiDist() }).catch((error) => {
    console.error("rennet daemon failed to start:", error);
    process.exitCode = 1;
  });
}
