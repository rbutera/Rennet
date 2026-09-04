// The ONE adapters suite that reads the live rennet checkout — its own `.git`, at
// whatever HEAD the working tree happens to be on. That makes its verdict depend on
// state no Nx input can hash, so it lives in its own file behind its own uncacheable
// `dogfood-test` target and is excluded from `rennet-adapters:test` (see
// packages/adapters/project.json). Keeping it here is what lets `test` — ~100 files
// whose inputs ARE fully declared — be cached.
//
// It is also the slowest thing in the gate: each generation maps the whole 4,600-file
// repo. Three generations is the floor for the property being asserted (a baseline to
// build FROM, the incremental step, and the clean full build to compare AGAINST), so
// the suite is one test, not several, and no build is repeated.
//
// If you add another file that reads the real repo, name it `*.dogfood.test.ts` — the
// `test` target excludes that glob, and `dogfood-test` is where it belongs.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSnapshotFresh, serializeManifest, verifySnapshotIntegrity } from "@rennet/core";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { resolveBaseRef } from "./project-snapshot-source";
import { ProjectSnapshotStore } from "./project-snapshot-store";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("ProjectSnapshotGenerator — dogfood over the REAL rennet repo", () => {
  const repoRoot = join(import.meta.dirname, "../../..");
  function realGit(...args: string[]): string {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  }

  it("rebuilds incrementally to a byte-identical, integral, fresh snapshot of rennet itself", async () => {
    const oid2 = realGit("rev-parse", "HEAD");
    const oid1 = realGit("rev-parse", "HEAD~1");
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-dogfood-"));
    scratch.push(storeDir);

    // Three generations of the whole repo, and no more: the HEAD~1 baseline the
    // incremental step reuses from, the incremental step itself, and the clean full
    // build at the same commit that it must equal byte for byte.
    const store = new ProjectSnapshotStore(storeDir);
    const inc = new ProjectSnapshotGenerator({ store });
    await inc.generate(repoRoot, { explicitBaseRef: oid1 });
    const step2 = await inc.generate(repoRoot, { explicitBaseRef: oid2 });
    const full = await new ProjectSnapshotGenerator().generate(repoRoot, {
      explicitBaseRef: oid2,
      previousSymbols: [],
    });

    // The load-bearing property, over the real repo.
    expect(serializeManifest(step2.manifest)).toBe(serializeManifest(full.manifest));
    expect(step2.manifest.fingerprint).toBe(full.manifest.fingerprint);
    const fullShards = new Map(full.built.shards);
    expect([...step2.built.shards.keys()].sort()).toEqual([...fullShards.keys()].sort());
    for (const [d, b] of step2.built.shards) expect(b).toBe(fullShards.get(d));
    // And it genuinely reused work: most blobs are unchanged across one commit.
    expect(step2.reusedSymbolShards).toBeGreaterThan(0);

    // The clean full build stands on its own as a snapshot of rennet: self-consistent,
    // pinned where it says it is, and actually carrying the real source tree.
    expect(full.manifest.schemaVersion).toBe(PROJECT_SNAPSHOT_SCHEMA_VERSION);
    expect(verifySnapshotIntegrity(full.manifest, (d) => full.built.shards.get(d)).ok).toBe(true);
    expect(isSnapshotFresh(full.manifest, oid2)).toBe(true);
    // It really mapped the real source tree: many eligible files ⇒ many shards.
    expect(full.manifest.symbols.length).toBeGreaterThan(50);

    // `explicitBaseRef` above is an OID, because byte-identity needs all three builds
    // pinned to the same commit — so `manifest.baseOid === oid2` would be an OID going
    // in and coming back out, which proves nothing. The ref→OID resolution that a
    // fourth, named-ref generation used to demonstrate is asserted directly instead,
    // against the same real repo, at no build cost.
    const resolved = await resolveBaseRef(repoRoot, { explicitBaseRef: "HEAD" });
    expect(resolved.baseOid).toBe(oid2);
    expect(resolved.baseRefResolution).toBe("explicit-setting");
    expect(full.manifest.baseOid).toBe(resolved.baseOid);
  }, 300000);
});
