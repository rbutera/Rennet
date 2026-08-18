// The process entry the desktop shell spawns (detached, via ELECTRON_RUN_AS_NODE) and
// `rennet serve` runs in the foreground. Kept to two lines so daemon.ts stays a pure,
// importable module: this file is the only place `runDaemon` executes on load, and it is
// never imported by a test or another module. Bundled to `dist/server/index.cjs` (#379).
import { resolveDaemonConfig, runDaemon } from "./daemon";

let config: ReturnType<typeof resolveDaemonConfig> | undefined;
try {
  config = resolveDaemonConfig(process.argv.slice(2), process.env);
} catch (error) {
  process.stderr.write(
    `rennet daemon: ${error instanceof Error ? error.message : String(error)}\nUsage: rennet-daemon [--data-dir <dir>] [--server-version <version>]\n`,
  );
  process.exitCode = 2;
}

if (config) {
  void runDaemon(config).catch((error) => {
    console.error("rennet daemon failed to start:", error);
    process.exitCode = 1;
  });
}
