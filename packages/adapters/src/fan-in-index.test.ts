import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fanInIndexFromSnapshot } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { ProjectSnapshotStore } from "./project-snapshot-store";

// The reddening PROBE for the blast-radius fan-in signal (#200 → #35 follow-on): prove
// `fanInIndexFromSnapshot` reads the REAL identifier-occurrence reference index off a
// materialized snapshot — a symbol defined in one file, and the distinct files that
// reference it. This is the guard that keeps the signal from silently going vacuous: if
// the index reader stopped finding references, the assertion below reddens.

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
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

describe("fanInIndexFromSnapshot — reads the real #200 reference index (fan-in probe)", () => {
  it("resolves a file's defined symbols and the distinct files that reference them", async () => {
    const { store, repoKey, baseOid } = await generateBeaconRepo();
    const gated = new ProjectContextReader(store).loadFresh(repoKey, baseOid);
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;

    const index = fanInIndexFromSnapshot(gated.snapshot);
    // The symbol IS a defined symbol of lib.ts.
    expect(index.definedSymbols("packages/a/src/lib.ts")).toContain("blastRadiusBeacon");
    // It is referenced in BOTH use.ts and also.ts (and lib.ts itself, where it is defined).
    const referencing = index.referencingFiles("blastRadiusBeacon");
    expect(referencing).toContain("packages/a/src/use.ts");
    expect(referencing).toContain("packages/a/src/also.ts");
    // Distinct files only — no path repeated across occurrence lines.
    expect(new Set(referencing).size).toBe(referencing.length);
  });

  it("returns empty for a path with no symbols and a name with no references (fail-soft)", async () => {
    const { store, repoKey, baseOid } = await generateBeaconRepo();
    const gated = new ProjectContextReader(store).loadFresh(repoKey, baseOid);
    if (!gated.ok) return;
    const index = fanInIndexFromSnapshot(gated.snapshot);
    expect(index.definedSymbols("packages/a/src/does-not-exist.ts")).toEqual([]);
    expect(index.referencingFiles("noSuchIdentifierAnywhere")).toEqual([]);
  });
});
