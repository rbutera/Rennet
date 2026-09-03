import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadScoutFacts,
  PROJECT_SCOUT_CONTEXT_ID,
  ProjectSnapshotStore,
  SCOUT_DETECTED_FILE,
} from "@rennet/adapters";
import type { HarnessEvent, HarnessPort } from "@rennet/core";
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

  // ── session-context-files 3.8/D4: the scout's detected facts are a FILE in the repo ──

  /** A one-turn Claude port that captures the prompt and emits an empty scout body. */
  function capturingClaudePort(sink: { prompt: string; cwd: string }): HarnessPort {
    const events: HarnessEvent[] = [
      {
        seq: 1,
        harness: "claude-code",
        sessionId: "s",
        turnId: "t",
        receivedAt: 0,
        native: null,
        kind: "session.started",
        model: "claude-sonnet-5",
        cwd: "",
        tools: [],
        apiKeySource: null,
      } as unknown as HarnessEvent,
      {
        seq: 2,
        harness: "claude-code",
        sessionId: "s",
        turnId: "t",
        receivedAt: 0,
        native: null,
        kind: "session.ended",
        outcome: { status: "completed", finalText: "", structuredOutput: {} },
      } as unknown as HarnessEvent,
    ];
    return {
      descriptor: {} as never,
      health: async () => ({}) as never,
      createSession: async (spec: { cwd: string }) => {
        sink.cwd = spec.cwd;
        return {
          id: "session",
          harness: "claude-code",
          events: (async function* () {
            for (const event of events) yield event;
          })(),
          send: async (turn: { prompt: string }) => {
            sink.prompt = turn.prompt;
            return "turn" as never;
          },
          interrupt: async () => undefined,
          close: async () => undefined,
        } as never;
      },
    } as HarnessPort;
  }

  it("writes scout-detected.json into the scouted repo, names it, and purges it next run", async () => {
    const repoRoot = tempDir();
    // A guidance document so the seat has something to distil, and a JIRA marker so the
    // detected object is not empty.
    writeFileSync(join(repoRoot, "CLAUDE.md"), "# Rules\nRun the gate.");
    writeFileSync(join(repoRoot, "README.md"), "Track work in ABC-1 and ABC-2.");
    const sink = { prompt: "", cwd: "" };
    const runtime = createProjectScoutRuntime({
      store: new ProjectSnapshotStore(tempDir()),
      gitForRepo: () => (_root, args) => Promise.reject(new Error(`no ${args[0]}`)),
      resolveClaudePort: async () => capturingClaudePort(sink),
      resolveCodexExecutor: async () => null,
      narrate: () => undefined,
    });

    await runtime.runForRepo({ projectId: "p", repoKey: "repo", repoRoot });

    const contextDir = join(repoRoot, ".rennet", "context", PROJECT_SCOUT_CONTEXT_ID);
    const detected = join(contextDir, SCOUT_DETECTED_FILE);
    // The facts landed as a file in the repo the seat is scouting…
    expect(JSON.parse(readFileSync(detected, "utf8"))).toMatchObject({
      trackerKind: { value: "jira", provenance: "detected" },
    });
    // …the writer's index names it…
    expect(readFileSync(join(contextDir, "README.md"), "utf8")).toContain(SCOUT_DETECTED_FILE);
    // …the prompt names the path and carries no facts…
    expect(sink.prompt).toContain(
      `.rennet/context/${PROJECT_SCOUT_CONTEXT_ID}/${SCOUT_DETECTED_FILE}`,
    );
    expect(sink.prompt).not.toContain('"provenance"');
    // …the seat's cwd is the repo root the path is relative to (3.11)…
    expect(sink.cwd).toBe(repoRoot);
    // …and the managed ignore block keeps it out of every git operation.
    expect(readFileSync(join(repoRoot, ".rennet", ".gitignore"), "utf8")).toContain("context/");

    // The next run purges the last one: there is no archive for a project-scoped scout,
    // so a stale file left behind would be read by the next seat as current.
    writeFileSync(join(contextDir, "stale.json"), "{}");
    await runtime.runForRepo({ projectId: "p", repoKey: "repo", repoRoot });
    expect(existsSync(join(contextDir, "stale.json"))).toBe(false);
    expect(existsSync(detected)).toBe(true);
  });
});
