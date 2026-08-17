import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
// On Windows the pnpm launcher is `pnpm.cmd`; `spawnSync`/`execFileSync` resolve a bare
// "pnpm" to nothing (ENOENT). Name the platform-correct executable, keep argv an array.
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const allowed = new Map([
  ["@rennet/types", new Set()],
  ["@rennet/protocol", new Set(["@rennet/types"])],
  ["@rennet/instructions", new Set(["@rennet/types"])],
  ["@rennet/core", new Set(["@rennet/types", "@rennet/protocol", "@rennet/instructions"])],
  [
    "@rennet/adapters",
    new Set(["@rennet/types", "@rennet/protocol", "@rennet/instructions", "@rennet/core"]),
  ],
  ["@rennet/ui", new Set(["@rennet/types", "@rennet/protocol"])],
]);

for (const [packageName, permitted] of allowed) {
  const directory = packageName.slice("@rennet/".length);
  const manifestPath = resolve(workspaceRoot, "packages", directory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };
  for (const dependency of Object.keys(dependencies)) {
    if (dependency.startsWith("@rennet/") && !permitted.has(dependency)) {
      throw new Error(`${packageName} cannot depend on ${dependency}`);
    }
  }
}

const positiveControl = resolve(workspaceRoot, "packages/ui/src/.boundary-positive-control.ts");
try {
  writeFileSync(positiveControl, 'import "@rennet/core";\n');
  const result = spawnSync(PNPM, ["exec", "eslint", positiveControl], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes("@nx/enforce-module-boundaries")) {
    throw new Error(`Boundary positive control did not fail as expected:\n${output}`);
  }
} finally {
  rmSync(positiveControl, { force: true });
}

console.log(
  "Package manifests obey the dependency arrows; the forbidden-import control failed as expected.",
);
