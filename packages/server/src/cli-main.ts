// The `rennet` process entry (bundled to dist/rennet.cjs, wired as the package bin).
// Kept to a thin shell so cli.ts stays a pure, importable module.
import { runCli } from "./cli";

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`rennet: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
