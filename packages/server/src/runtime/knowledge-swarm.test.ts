import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSnapshotStore } from "@rennet/adapters";
import type { ProjectProcessEvent } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  createKnowledgeSwarmRuntime,
  knowledgeOutcomeLine,
  knowledgeStageLine,
} from "./knowledge-swarm";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-runtime-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("knowledgeStageLine", () => {
  it("narrates scope selection before worker fan-out with honest coverage counts", () => {
    expect(
      knowledgeStageLine("rennet", {
        kind: "scope",
        status: "done",
        candidates: 96,
        selected: 64,
        scopeExcludedFiles: 702,
        mechanicallyExcludedFiles: 177,
        attempts: 1,
      }),
    ).toMatchObject({
      note: "Context-map coverage selected",
      detail:
        "64 of 96 slices selected; 702 files excluded by scope; 177 mechanically excluded; 1 selector model turn",
    });
    expect(
      knowledgeStageLine("rennet", {
        kind: "scope",
        status: "reused",
        candidates: 96,
        selected: 64,
        scopeExcludedFiles: 702,
        mechanicallyExcludedFiles: 177,
      }),
    ).toMatchObject({ note: "Context-map coverage reused" });
  });

  it("narrates a journal REUSE as reuse, never as a turn that ran", () => {
    // A batch answered from the journal cost nothing. Reporting it as "done"
    // alongside the batches that really ran would overstate the run's spend.
    expect(
      knowledgeStageLine("rennet", {
        kind: "partition",
        sliceId: "mod:src/a.ts#aaaa",
        index: 2,
        total: 5,
        status: "reused",
        statements: 4,
      }),
    ).toMatchObject({
      note: "Knowledge worker 2/5 reused from the journal",
      detail: "mod:src/a.ts#aaaa: 4 statements",
    });
    // The control: a batch that DID run reads differently.
    expect(
      knowledgeStageLine("rennet", {
        kind: "partition",
        sliceId: "mod:src/a.ts#aaaa",
        index: 2,
        total: 5,
        status: "done",
        statements: 4,
      }),
    ).toMatchObject({ note: "Knowledge worker 2/5 done" });
  });
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
        selectedPartitions: 1,
        totalPartitions: 1,
        scopeExcludedFiles: 0,
        mechanicallyExcludedFiles: 0,
        removedByCoverage: 0,
        reusedScopePlan: false,
        failedPartitions: 0,
        reusedPartitions: 0,
        skippedCosmetic: 0,
        carried: 0,
        verify: {
          status: "ok",
          confirmed: 0,
          rejected: 0,
          crossCutting: 0,
          droppedAnchors: 0,
          droppedStatements: 0,
          merged: 0,
          residue: 0,
          duplicateIds: 0,
          duplicateClaims: 0,
          flagged: 0,
        },
      }),
    ).toBeUndefined();
  });
});

describe("createKnowledgeSwarmRuntime", () => {
  it("keeps a foreground project run on typed knowledge steps and off the background channel", async () => {
    const foreground: ProjectProcessEvent[] = [];
    const background: ProjectProcessEvent[] = [];
    const runtime = createKnowledgeSwarmRuntime({
      store: new ProjectSnapshotStore(tempDir()),
      resolveClaudePort: async () => null,
      resolveCodexExecutor: async () => null,
      narrate: (_projectId, event) => background.push(event),
    });

    const outcome = await runtime.runForRepo({
      projectId: "project-1",
      repoKey: "repo",
      repoRoot: join(tempDir(), "rennet"),
      toOid: "a".repeat(40),
      runId: "01f15934-68bf-487b-b03b-71e75a8e93a8",
      narrate: (event) => foreground.push(event),
    });

    expect(outcome.status).toBe("failed");
    expect(foreground).toEqual([
      {
        kind: "step",
        runId: "01f15934-68bf-487b-b03b-71e75a8e93a8",
        repo: "rennet",
        phase: "knowledge",
        step: "connect",
        status: "failed",
        note: "Knowledge pass failed",
        detail: "no harness is available to run the knowledge swarm",
      },
    ]);
    expect(background).toEqual([]);
  });

  it("narrates the reason when no harness is available (never a silent no-op)", async () => {
    const narrated: ProjectProcessEvent[] = [];
    const runtime = createKnowledgeSwarmRuntime({
      store: new ProjectSnapshotStore(tempDir()),
      resolveClaudePort: async () => null,
      resolveCodexExecutor: async () => null,
      narrate: (_projectId, event) => narrated.push(event),
    });

    const outcome = await runtime.runForRepo({
      projectId: "project-1",
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
      narrate: (_projectId, event) => narrated.push(event),
    });

    const outcome = await runtime.runForRepo({
      projectId: "project-1",
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
