import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertPnpmCommandShape, pnpmCommand } from "./pnpm-launcher.mjs";

// Regenerates THIRD-PARTY-LICENSES.md from the resolved production graph. The
// permissive licences Rennet ships (MIT/Apache/BSD/ISC/…) require their
// copyright notices to travel with the distributed artifact; this file is that
// attribution. Rennet's own source is FSL-1.1-MIT (see LICENSE) — a separate,
// outbound licence that this file does not restate.
//
// Run with `pnpm notices` (or `node scripts/generate-notices.mjs`) and commit
// the result whenever the dependency graph changes.

const OUTPUT = new URL("../THIRD-PARTY-LICENSES.md", import.meta.url);

export function renderNotices(report) {
  const licenses = Object.keys(report).sort((a, b) => a.localeCompare(b));
  const total = Object.values(report).reduce((n, pkgs) => n + pkgs.length, 0);

  const lines = [
    "# Third-party licences",
    "",
    "Rennet's own source is licensed under FSL-1.1-MIT (see [`LICENSE`](./LICENSE)).",
    "The production dependencies below ship under their own permissive licences,",
    "reproduced here to satisfy their attribution and notice requirements.",
    "",
    `Generated from the resolved production graph: ${total} packages across ` +
      `${licenses.length} licence buckets. Regenerate with \`pnpm notices\`.`,
    "",
  ];

  for (const license of licenses) {
    const pkgs = [...report[license]].sort((a, b) => a.name.localeCompare(b.name));
    lines.push(`## ${license}`, "");
    for (const pkg of pkgs) {
      const version = pkg.version ?? (pkg.versions ?? []).join(", ");
      const home = pkg.homepage ? ` — ${pkg.homepage}` : "";
      lines.push(`- **${pkg.name}**${version ? ` ${version}` : ""}${home}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function main() {
  assertPnpmCommandShape();
  const { command, args } = pnpmCommand(["licenses", "list", "--json", "--prod"]);
  const report = JSON.parse(execFileSync(command, args, { encoding: "utf8" }));
  writeFileSync(OUTPUT, renderNotices(report));
  const total = Object.values(report).reduce((n, pkgs) => n + pkgs.length, 0);
  console.log(`Wrote THIRD-PARTY-LICENSES.md (${total} packages).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
