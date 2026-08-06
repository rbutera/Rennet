import { execFileSync } from "node:child_process";

const allowed = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "ISC",
  "MIT",
]);

const report = JSON.parse(
  execFileSync("pnpm", ["licenses", "list", "--json", "--prod"], { encoding: "utf8" }),
);
const blocked = Object.keys(report).filter((license) => !allowed.has(license));

if (blocked.length > 0) {
  throw new Error(`Blocked shipped dependency licences: ${blocked.join(", ")}`);
}

const packageCount = Object.values(report).reduce((total, packages) => total + packages.length, 0);
console.log(
  `Checked ${packageCount} shipped dependency records across ${Object.keys(report).length} allowed licences.`,
);
