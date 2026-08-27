import { readFileSync } from "node:fs";
import {
  type DossierItem,
  type KnowledgeSet,
  type PatchFile,
  type Patchset,
  patchsetSchema,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { buildSuccessorAccount } from "../successor-account";
import { buildDeltaPacket } from "./delta-packet";

function file(path: string, patch: string, overrides: Partial<PatchFile> = {}): PatchFile {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    patch,
    ...overrides,
  };
}

function patchsetOf(files: PatchFile[]): Patchset {
  return {
    id: "ps_delta_packet",
    createdAt: "2026-01-01T00:00:00.000Z",
    repository: {
      id: "repo",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "origin/main",
      baseOid: "0".repeat(40),
      headOid: "1".repeat(40),
    },
    files,
    rawDiff: "",
    byteLength: 0,
    truncated: false,
  };
}

const PATCH = ["@@ -1,2 +1,2 @@", " const a = 1;", "-const b = 2;", "+const b = 3;"].join("\n");

const KNOWLEDGE: KnowledgeSet = {
  schemaVersion: 1,
  repoKey: "repo",
  baseOid: "0".repeat(40),
  snapshotFingerprint: "fp",
  generator: "test",
  statements: [],
};

const DOSSIER: DossierItem[] = [
  {
    id: "gh-1",
    tracker: "github",
    title: "An issue",
    state: "open",
    body: "body",
    url: "https://example.invalid/1",
    provenance: "pr-body",
    fetchedAt: "2026-01-01T00:00:00.000Z",
  },
];

// The full producer spread: an impl+test pair, a lockfile, a deleted file (a
// deterministic blast-radius mark), and an openspec artifact.
function fullPatchset(): Patchset {
  return patchsetOf([
    file("src/foo.ts", PATCH),
    file("src/foo.test.ts", PATCH),
    file("pnpm-lock.yaml", PATCH),
    file("src/gone.ts", PATCH, { status: "deleted" }),
    file("openspec/changes/my-change/proposal.md", PATCH, { status: "added" }),
  ]);
}

describe("buildDeltaPacket", () => {
  it("assembles every producer's facts from one patchset", () => {
    const packet = buildDeltaPacket(fullPatchset(), KNOWLEDGE, DOSSIER);

    expect(packet.patchset.id).toBe("ps_delta_packet");
    expect(packet.patchset.files.map((f) => f.path)).toHaveLength(5);
    // Meta, not patches: no file row carries patch text.
    for (const row of packet.patchset.files) expect(row).not.toHaveProperty("patch");

    expect(packet.hunks.hunks.length).toBeGreaterThan(0);
    expect(packet.knowledge).toEqual(KNOWLEDGE);
    expect(packet.dossier).toEqual(DOSSIER);

    const lockfileHunk = packet.hunks.hunks.find((h) => h.path === "pnpm-lock.yaml");
    expect(packet.noisePreclass.some((fact) => fact.hunkId === lockfileHunk?.id)).toBe(true);

    expect(packet.counterpartHints).toEqual([
      { implPath: "src/foo.ts", testPath: "src/foo.test.ts" },
    ]);

    expect(packet.blastRadius.some((mark) => mark.assessed)).toBe(true);

    expect(packet.openspec).toEqual({
      changes: [
        {
          name: "my-change",
          artifactPaths: ["openspec/changes/my-change/proposal.md"],
        },
      ],
    });
  });

  it("carries the successor-account section iff the argument is supplied", () => {
    const account = buildSuccessorAccount({ asks: [], carried: [], changedPaths: ["src/foo.ts"] });
    const withAccount = buildDeltaPacket(fullPatchset(), KNOWLEDGE, DOSSIER, account);
    expect(withAccount.successorAccount).toEqual(account);

    const withoutAccount = buildDeltaPacket(fullPatchset(), KNOWLEDGE, DOSSIER);
    expect("successorAccount" in withoutAccount).toBe(false);
  });

  it("a mode-only change is visible in the packet as typed mode evidence", () => {
    const chmodOnly = ["old mode 100644", "new mode 100755"].join("\n");
    const packet = buildDeltaPacket(
      patchsetOf([file("bin/run.sh", chmodOnly, { additions: 0, deletions: 0 })]),
      KNOWLEDGE,
      DOSSIER,
    );
    // Zero hunks — without the file-row evidence the change would vanish.
    expect(packet.hunks.hunks).toEqual([]);
    expect(packet.patchset.files[0]?.modeChange).toEqual({ old: "100644", new: "100755" });
    // A hunk-carrying file without mode lines carries none.
    const plain = buildDeltaPacket(patchsetOf([file("src/foo.ts", PATCH)]), KNOWLEDGE, DOSSIER);
    expect("modeChange" in (plain.patchset.files[0] ?? {})).toBe(false);
  });

  it("omits the openspec section when the patchset touches no openspec artifact", () => {
    const packet = buildDeltaPacket(patchsetOf([file("src/foo.ts", PATCH)]), KNOWLEDGE, DOSSIER);
    expect("openspec" in packet).toBe(false);
  });

  it("is deterministic: two calls over the same inputs are deep-equal", () => {
    expect(buildDeltaPacket(fullPatchset(), KNOWLEDGE, DOSSIER)).toEqual(
      buildDeltaPacket(fullPatchset(), KNOWLEDGE, DOSSIER),
    );
  });
});

// The B05 packet's fixture test: a REAL captured patchset (frozen from this
// repository's own commit 3228a4cc — the B04 heal fix, an impl+test pair; no
// client code, per the fixture rule) through the whole seam.
describe("e2e (B05 packet): real captured patchset", () => {
  const realPatchset: Patchset = patchsetSchema.parse(
    JSON.parse(readFileSync(new URL("./real-capture-fixture.json", import.meta.url), "utf8")),
  );

  it("hunk ids are stable across a re-run", () => {
    const first = buildDeltaPacket(realPatchset, KNOWLEDGE, DOSSIER);
    const second = buildDeltaPacket(realPatchset, KNOWLEDGE, DOSSIER);
    expect(first.hunks.hunks.length).toBeGreaterThan(0);
    expect(second.hunks.hunks.map((h) => h.id)).toEqual(first.hunks.hunks.map((h) => h.id));
    expect(second).toEqual(first);
  });

  it("successor-account section is present iff a prior generation exists", () => {
    const account = buildSuccessorAccount({
      asks: [],
      carried: [],
      changedPaths: realPatchset.files.map((f) => f.path),
    });
    const withPrior = buildDeltaPacket(realPatchset, KNOWLEDGE, DOSSIER, account);
    expect(withPrior.successorAccount).toEqual(account);

    const firstGeneration = buildDeltaPacket(realPatchset, KNOWLEDGE, DOSSIER);
    expect("successorAccount" in firstGeneration).toBe(false);
  });

  it("the real impl+test pair surfaces as a counterpart hint", () => {
    const packet = buildDeltaPacket(realPatchset, KNOWLEDGE, DOSSIER);
    expect(packet.counterpartHints).toEqual([
      {
        implPath: "packages/server/src/boards/file-board-store.ts",
        testPath: "packages/server/src/boards/file-board-store.test.ts",
      },
    ]);
  });
});
