import type { DossierItem, KnowledgeSet, PatchFile, Patchset } from "@rennet/protocol";
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
