import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoComposition } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { assembleContextForComposition, gatherContextDocuments } from "./context-manifest";

function composition(): RepoComposition {
  return {
    repoRecordId: "/repo",
    pinnedOid: "oid-1",
    projectSnapshotId: "fp-1",
    scopeTree: {
      repoRecordId: "/repo",
      rootId: "root",
      nodes: [
        {
          id: "root",
          name: "@x/root",
          root: "",
          parentId: null,
          provenance: [],
          dependencies: [],
        },
      ],
      contentDigest: "d-1",
    },
    submodules: [],
    contentDigest: "comp-1",
    freshness: { status: "current", staleMembers: [] },
  };
}

describe("context-manifest — adapter gathering + assembly (issue #30)", () => {
  it("gathers existing repo guidance labelled by source, then the project map", () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-ctxman-"));
    writeFileSync(join(root, "CLAUDE.md"), "rule zero: no gates\n");
    // No AGENTS.md written — it must be absent, not fabricated.

    const docs = gatherContextDocuments(root, composition());
    expect(docs.map((d) => d.source)).toEqual(["claude-md", "project-map"]);
    expect(docs[0]?.sourcePath).toBe("CLAUDE.md");
    expect(docs[0]?.content).toContain("rule zero");
  });

  it("assembles deterministically and records the guidance document in the manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-ctxman-"));
    writeFileSync(join(root, "CLAUDE.md"), "guidance line 1\nguidance line 2\n");

    const a = assembleContextForComposition(root, composition());
    const b = assembleContextForComposition(root, composition());
    expect(a.digest).toBe(b.digest);

    const claude = a.documents.find((d) => d.source === "claude-md");
    expect(claude).toBeDefined();
    expect(claude?.state).toBe("included");
    expect(claude?.contentHash.length).toBeGreaterThan(0);
    // The assembled text labels the guidance by source — fed directly, no gate.
    expect(a.text).toContain("### claude-md — CLAUDE.md");
  });

  it("truncates visibly under a tiny byte budget and records the cut", () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-ctxman-"));
    writeFileSync(join(root, "CLAUDE.md"), "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");

    const assembly = assembleContextForComposition(root, composition(), 6);
    // Some document is cut, and every cut is recorded (never a silent drop).
    const cut = assembly.documents.filter((d) => d.state === "truncated" || d.state === "dropped");
    expect(cut.length).toBeGreaterThan(0);
    expect(assembly.totalBytes).toBeLessThanOrEqual(6);
  });
});
