import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSnapshotStore } from "@rennet/adapters";
import type { ProjectProcessEvent } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createKnowledgeSwarmRuntime, knowledgeOutcomeLine } from "./knowledge-swarm";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-runtime-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("knowledgeOutcomeLine", () => {
  it("carries the failure reason to the narration channel", () => {
    expect(
      knowledgeOutcomeLine("rennet", { status: "failed", reason: "Prompt is too long" }),
    ).toEqual({
      kind: "stage",
      repo: "rennet",
      stage: "knowledge",
      note: "Knowledge pass failed",
      detail: "Prompt is too long",
    });
  });

  it("distinguishes skipped and snapshot-unavailable from a failure", () => {
    expect(
      knowledgeOutcomeLine("rennet", { status: "skipped", reason: "already current" }),
    ).toMatchObject({ note: "Knowledge pass skipped", detail: "already current" });
    expect(
      knowledgeOutcomeLine("rennet", { status: "snapshot-unavailable", reason: "stale" }),
    ).toMatchObject({ note: "Knowledge pass has no fresh snapshot", detail: "stale" });
  });

  it("says nothing on ok — the verify progress line already reported the counts", () => {
    expect(
      knowledgeOutcomeLine("rennet", {
        status: "ok",
        set: {
          schemaVersion: 1,
          repoKey: "repo",
          baseOid: "a".repeat(40),
          snapshotFingerprint: "fp",
          generator: "knowledge-swarm@1",
          statements: [],
        },
        ranPartitions: 1,
        totalPartitions: 1,
        failedPartitions: 0,
        carried: 0,
        verify: {
          status: "ok",
          confirmed: 0,
          rejected: 0,
          crossCutting: 0,
          droppedAnchors: 0,
          droppedStatements: 0,
        },
      }),
    ).toBeUndefined();
  });
});

describe("createKnowledgeSwarmRuntime", () => {
  it("narrates the reason when no harness is available (never a silent no-op)", async () => {
    const narrated: ProjectProcessEvent[] = [];
    const runtime = createKnowledgeSwarmRuntime({
      store: new ProjectSnapshotStore(tempDir()),
      resolveClaudePort: async () => null,
      resolveCodexExecutor: async () => null,
      narrate: (event) => narrated.push(event),
    });

    const outcome = await runtime.runForRepo({
      repoKey: "repo",
      repoRoot: join(tempDir(), "rennet"),
      toOid: "a".repeat(40),
    });

    expect(outcome).toEqual({
      status: "failed",
      reason: "no harness is available to run the knowledge swarm",
    });
    expect(narrated).toEqual([
      {
        kind: "stage",
        repo: "rennet",
        stage: "knowledge",
        note: "Knowledge pass failed",
        detail: "no harness is available to run the knowledge swarm",
      },
    ]);
  });

  it("narrates a THROWN failure exactly like a typed one (never console-only)", async () => {
    // A harness probe can reject, and a Claude seat's `createSession` runs before
    // the adapter turn's own `try`. Uncaught, those escaped to the rehydration
    // loop's `onError` — wired to `console.error` in production, so the user saw
    // nothing while the typed path narrated. Same failure, one visibility.
    const narrated: ProjectProcessEvent[] = [];
    const runtime = createKnowledgeSwarmRuntime({
      store: new ProjectSnapshotStore(tempDir()),
      resolveClaudePort: async () => {
        throw new Error("spawn claude ENOENT");
      },
      resolveCodexExecutor: async () => null,
      narrate: (event) => narrated.push(event),
    });

    const outcome = await runtime.runForRepo({
      repoKey: "repo",
      repoRoot: join(tempDir(), "rennet"),
      toOid: "a".repeat(40),
    });

    expect(outcome).toEqual({ status: "failed", reason: "spawn claude ENOENT" });
    expect(narrated).toEqual([
      {
        kind: "stage",
        repo: "rennet",
        stage: "knowledge",
        note: "Knowledge pass failed",
        detail: "spawn claude ENOENT",
      },
    ]);
  });
});
