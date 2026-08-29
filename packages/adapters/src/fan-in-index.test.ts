import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fanInIndexFromSnapshot, queryReferences } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { ProjectSnapshotStore } from "./project-snapshot-store";

// The reddening PROBE for the blast-radius fan-in signal (#200 → #35 follow-on): prove
// `fanInIndexFromSnapshot` reads a REAL index off a materialized snapshot — and that it
// PREFERS the resolved file→file import graph over the textual identifier index when the
// snapshot carries import shards. This is the guard that keeps the signal from silently
// going vacuous: if the graph reader stopped resolving edges, the assertions below redden
// (either by falling back to `textual` or by finding no importers).

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/** A repo where `blastRadiusBeacon` is DEFINED in lib.ts and REFERENCED in two other files. */
async function generateBeaconRepo(): Promise<{
  store: ProjectSnapshotStore;
  repoKey: string;
  baseOid: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "rennet-fanin-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-fanin-store-"));
  scratch.push(root, storeDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(
    root,
    "packages/a/package.json",
    JSON.stringify({ name: "@t/a", private: true, main: "./src/lib.ts" }),
  );
  write(root, "packages/a/src/lib.ts", "export function blastRadiusBeacon() {\n  return 1;\n}\n");
  write(
    root,
    "packages/a/src/use.ts",
    "import { blastRadiusBeacon } from './lib';\nexport const x = blastRadiusBeacon();\n",
  );
  write(
    root,
    "packages/a/src/also.ts",
    "import { blastRadiusBeacon } from './lib';\nexport const y = blastRadiusBeacon();\n",
  );
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const baseOid = git(root, "rev-parse", "HEAD");
  const store = new ProjectSnapshotStore(storeDir);
  const { manifest } = await new ProjectSnapshotGenerator({ store }).generate(root, {
    explicitBaseRef: baseOid,
  });
  return { store, repoKey: manifest.repoKey, baseOid: manifest.baseOid };
}

describe("fanInIndexFromSnapshot — prefers the real import graph (fan-in probe)", () => {
  it("is edge-backed and names the distinct files that IMPORT a changed file", async () => {
    const { store, repoKey, baseOid } = await generateBeaconRepo();
    const gated = new ProjectContextReader(store).loadFresh(repoKey, baseOid);
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;

    const index = fanInIndexFromSnapshot(gated.snapshot);
    // The snapshot carries resolvable import edges, so the STRONGER method answers.
    expect(index.method).toBe("import-edges");
    if (index.method !== "import-edges") return;

    // lib.ts is imported by BOTH use.ts and also.ts — a proven edge, not a name match.
    const importers = index.importersOf("packages/a/src/lib.ts");
    expect(importers).toEqual(["packages/a/src/also.ts", "packages/a/src/use.ts"]);
  });

  it("returns empty for a path nothing imports, and for an unknown path (fail-soft)", async () => {
    const { store, repoKey, baseOid } = await generateBeaconRepo();
    const gated = new ProjectContextReader(store).loadFresh(repoKey, baseOid);
    if (!gated.ok) return;
    const index = fanInIndexFromSnapshot(gated.snapshot);
    if (index.method !== "import-edges") throw new Error("expected an edge-backed index");
    expect(index.importersOf("packages/a/src/use.ts")).toEqual([]);
    expect(index.importersOf("packages/a/src/does-not-exist.ts")).toEqual([]);
  });

  it("still resolves the textual identifier index the graph is layered over", async () => {
    const { store, repoKey, baseOid } = await generateBeaconRepo();
    const gated = new ProjectContextReader(store).loadFresh(repoKey, baseOid);
    if (!gated.ok) return;
    // The #200 index is independently readable — the import graph replaces the fan-in
    // METHOD, not the reference index itself.
    const references = queryReferences(gated.snapshot, { name: "blastRadiusBeacon" });
    expect(references.ok).toBe(true);
    if (!references.ok) return;
    const paths = new Set(references.references.sites.map((site) => site.path));
    expect(paths).toContain("packages/a/src/use.ts");
    expect(paths).toContain("packages/a/src/also.ts");
  });
});
