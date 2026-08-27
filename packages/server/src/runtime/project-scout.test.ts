import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScoutFacts, ProjectSnapshotStore } from "@rennet/adapters";
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
      narrate: () => {},
    });

    const result = await runtime.runForRepo({ repoKey: "repo", repoRoot: tempDir() });

    // The deterministic floor stood: GitHub detected from the remote, persisted.
    expect(result?.facts.trackerKind?.value).toBe("github");
    const stored = loadScoutFacts(store, "repo");
    expect(stored?.facts.trackerKind?.value).toBe("github");
  });
});
