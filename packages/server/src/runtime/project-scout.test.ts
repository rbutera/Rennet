import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadScoutFacts,
  PROJECT_SCOUT_CONTEXT_PREFIX,
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

  /**
   * A one-turn Claude port that captures the prompt and emits an empty scout body.
   *
   * `onSend` runs at the exact moment the seat is handed its prompt — which is when a real
   * seat would go and read the files that prompt names. The scout's context directory is
   * purged when the run returns, so that instant is the only place its contents can be
   * observed, and observing them anywhere else would be asserting about a different time.
   */
  function capturingClaudePort(
    sink: { prompt: string; cwd: string },
    onSend: () => void = () => undefined,
  ): HarnessPort {
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
            onSend();
            return "turn" as never;
          },
          interrupt: async () => undefined,
          close: async () => undefined,
        } as never;
      },
    } as HarnessPort;
  }

  /** The scout context directories present in a repo right now, newest-agnostic. */
  function scoutContextDirs(repoRoot: string): string[] {
    try {
      return readdirSync(join(repoRoot, ".rennet", "context")).filter((name) =>
        name.startsWith(PROJECT_SCOUT_CONTEXT_PREFIX),
      );
    } catch {
      return [];
    }
  }

  it("writes scout-detected.json into the scouted repo under a per-run id, names it, and purges it when the run returns", async () => {
    const repoRoot = tempDir();
    // A guidance document so the seat has something to distil, and a JIRA marker so the
    // detected object is not empty.
    writeFileSync(join(repoRoot, "CLAUDE.md"), "# Rules\nRun the gate.");
    writeFileSync(join(repoRoot, "README.md"), "Track work in ABC-1 and ABC-2.");
    const sink = { prompt: "", cwd: "" };
    // Read at the instant the seat is handed the prompt — a real seat's read moment.
    let seen: { dirs: string[]; detected: string; index: string } | undefined;
    const runtime = createProjectScoutRuntime({
      store: new ProjectSnapshotStore(tempDir()),
      gitForRepo: () => (_root, args) => Promise.reject(new Error(`no ${args[0]}`)),
      resolveClaudePort: async () =>
        capturingClaudePort(sink, () => {
          const dirs = scoutContextDirs(repoRoot);
          const dir = join(repoRoot, ".rennet", "context", dirs[0] ?? "missing");
          seen = {
            dirs,
            detected: readFileSync(join(dir, SCOUT_DETECTED_FILE), "utf8"),
            index: readFileSync(join(dir, "README.md"), "utf8"),
          };
        }),
      resolveCodexExecutor: async () => null,
      narrate: () => undefined,
    });

    await runtime.runForRepo({ projectId: "p", repoKey: "repo", repoRoot });

    // ONE directory during the run, and its id is a per-run id, not the bare prefix — a
    // fixed id is never a session id, so every daemon start read it as an orphan and two
    // concurrent scouts raced purge-then-write over each other's files.
    expect(seen?.dirs).toHaveLength(1);
    expect(seen?.dirs[0]).not.toBe(PROJECT_SCOUT_CONTEXT_PREFIX);
    expect(seen?.dirs[0]).toMatch(new RegExp(`^${PROJECT_SCOUT_CONTEXT_PREFIX}-.+`));
    // The facts landed as a file in the repo the seat is scouting…
    expect(JSON.parse(seen?.detected ?? "{}")).toMatchObject({
      trackerKind: { value: "jira", provenance: "detected" },
    });
    // …the writer's index names it…
    expect(seen?.index).toContain(SCOUT_DETECTED_FILE);
    // …the prompt names that exact per-run path and carries no facts…
    expect(sink.prompt).toContain(`.rennet/context/${seen?.dirs[0]}/${SCOUT_DETECTED_FILE}`);
    expect(sink.prompt).not.toContain('"provenance"');
    // …the seat's cwd is the repo root the path is relative to (3.11)…
    expect(sink.cwd).toBe(repoRoot);
    // …and the managed ignore block keeps it out of every git operation.
    expect(readFileSync(join(repoRoot, ".rennet", ".gitignore"), "utf8")).toContain("context/");

    // The run purges its OWN directory on the way out: there is no archive for a
    // project-scoped scout, and a directory left behind is one the daemon-start sweep
    // would have to reason about.
    expect(scoutContextDirs(repoRoot)).toEqual([]);

    // A second run leaves nothing behind either, and does not collide with the first.
    await runtime.runForRepo({ projectId: "p", repoKey: "repo", repoRoot });
    expect(scoutContextDirs(repoRoot)).toEqual([]);
  });

  it("purges its directory even when the run FAILS", async () => {
    const repoRoot = tempDir();
    writeFileSync(join(repoRoot, "CLAUDE.md"), "# Rules\nRun the gate.");
    const sink = { prompt: "", cwd: "" };
    const runtime = createProjectScoutRuntime({
      store: new ProjectSnapshotStore(tempDir()),
      gitForRepo: () => (_root, args) => Promise.reject(new Error(`no ${args[0]}`)),
      resolveClaudePort: async () =>
        capturingClaudePort(sink, () => {
          // The directory really is there when the turn runs (this assertion is what makes
          // the "purged" one below non-vacuous)…
          expect(scoutContextDirs(repoRoot)).toHaveLength(1);
          throw new Error("the seat died mid-turn");
        }),
      resolveCodexExecutor: async () => null,
      narrate: () => undefined,
    });

    await runtime.runForRepo({ projectId: "p", repoKey: "repo", repoRoot });

    // …and nothing is left for a sweep to puzzle over.
    expect(scoutContextDirs(repoRoot)).toEqual([]);
  });
});
