import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertPnpmCommandShape, pnpmCommand } from "./pnpm-launcher.mjs";

const workspaceRoot = resolve(import.meta.dirname, "..");
assertPnpmCommandShape();
const allowed = new Map([
  ["@rennet/types", new Set()],
  ["@rennet/theme", new Set()],
  ["@rennet/protocol", new Set(["@rennet/types"])],
  ["@rennet/instructions", new Set(["@rennet/types"])],
  ["@rennet/core", new Set(["@rennet/types", "@rennet/protocol", "@rennet/instructions"])],
  [
    "@rennet/adapters",
    new Set(["@rennet/types", "@rennet/protocol", "@rennet/instructions", "@rennet/core"]),
  ],
  [
    "@rennet/server",
    new Set([
      "@rennet/types",
      "@rennet/protocol",
      "@rennet/instructions",
      "@rennet/core",
      "@rennet/adapters",
    ]),
  ],
  ["@rennet/ui", new Set(["@rennet/types", "@rennet/theme"])],
  ["@rennet/app-ui", new Set(["@rennet/types", "@rennet/protocol", "@rennet/theme", "@rennet/ui"])],
  ["@rennet/client", new Set(["@rennet/types", "@rennet/protocol"])],
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

const positiveControl = resolve(workspaceRoot, "packages/app-ui/src/.boundary-positive-control.ts");
try {
  writeFileSync(positiveControl, 'import "@rennet/core";\n');
  const { command, args } = pnpmCommand(["exec", "eslint", positiveControl]);
  const result = spawnSync(command, args, {
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

const electronPositiveControl = resolve(
  workspaceRoot,
  "packages/server/src/.electron-boundary-positive-control.ts",
);
try {
  writeFileSync(electronPositiveControl, 'import "electron";\n');
  const { command, args } = pnpmCommand(["exec", "eslint", electronPositiveControl]);
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !output.includes("no-restricted-imports")) {
    throw new Error(`Electron boundary positive control did not fail as expected:\n${output}`);
  }
} finally {
  rmSync(electronPositiveControl, { force: true });
}

console.log(
  "Package manifests obey the dependency arrows; the @rennet/core and Electron forbidden-import controls both failed as expected.",
);
