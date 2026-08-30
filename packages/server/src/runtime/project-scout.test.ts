import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScoutFacts, ProjectSnapshotStore } from "@rennet/adapters";
import type { ProjectProcessEvent } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectScoutRuntime } from "./project-scout";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scout-runtime-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createProjectScoutRuntime", () => {
  it("runs and persists the deterministic pass even when harness discovery rejects", async () => {
    const store = new ProjectSnapshotStore(tempDir());
    const runtime = createProjectScoutRuntime({
      store,
      gitForRepo: () => (_root, args) =>
        args[0] === "config"
          ? Promise.resolve("https://github.com/rbutera/rennet.git\n")
          : Promise.reject(new Error(`no ${args[0]}`)),
      resolveClaudePort: () => Promise.reject(new Error("claude discovery exploded")),
      resolveCodexExecutor: () => Promise.reject(new Error("codex discovery exploded")),
      narrate: () => {
        /* progress lines are irrelevant to this test */
      },
    });

    const result = await runtime.runForRepo({
      projectId: "project-1",
      repoKey: "repo",
      repoRoot: tempDir(),
    });

    // The deterministic floor stood: GitHub detected from the remote, persisted.
    expect(result?.facts.trackerKind?.value).toBe("github");
    const stored = loadScoutFacts(store, "repo");
    expect(stored?.facts.trackerKind?.value).toBe("github");
  });

  it("streams named typed scout steps and exposes the persisted five-answer questionnaire", async () => {
    const store = new ProjectSnapshotStore(tempDir());
    const events: ProjectProcessEvent[] = [];
    const runtime = createProjectScoutRuntime({
      store,
      gitForRepo: () => (_root, args) =>
        args[0] === "config"
          ? Promise.resolve("https://github.com/rbutera/rennet.git\n")
          : Promise.reject(new Error(`no ${args[0]}`)),
      resolveClaudePort: async () => null,
      resolveCodexExecutor: async () => null,
    });
    const result = await runtime.runForRepo({
      projectId: "project-1",
      repoKey: "repo",
      repoRoot: join(tempDir(), "rennet"),
      defaultBranch: "trunk",
      runId: "e01921c2-d838-4d57-9f64-aee31942e23c",
      narrate: (event) => events.push(event),
    });

    expect(result).not.toBeNull();
    expect(
      events
        .filter((event) => event.kind === "step")
        .map((event) => `${event.step}:${event.status}`),
    ).toEqual([
      "remotes:running",
      "remotes:done",
      "config:running",
      "config:done",
      "guidance:running",
      "guidance:done",
      "returned:done",
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "scout-ready",
      questionnaire: {
        detected: 2,
        guessed: 3,
        answers: expect.arrayContaining([
          expect.objectContaining({
            key: "logoPath",
            provenance: "guessed",
            source: "no repository logo found",
          }),
        ]),
      },
    });
    expect(loadScoutFacts(store, "repo")?.facts.defaultBranch?.value).toBe("trunk");
  });
});
