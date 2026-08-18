// The process entry the desktop shell spawns (detached, via ELECTRON_RUN_AS_NODE) and
// `rennet serve` runs in the foreground. Kept to two lines so daemon.ts stays a pure,
// importable module: this file is the only place `runDaemon` executes on load, and it is
// never imported by a test or another module. Bundled to `dist/server/index.cjs` (#379).
import { resolveDaemonConfig, runDaemon } from "./daemon";

void runDaemon(resolveDaemonConfig(process.argv.slice(2), process.env)).catch((error) => {
  console.error("rennet daemon failed to start:", error);
  process.exit(1);
});
