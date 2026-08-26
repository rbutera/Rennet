import type {
  HarnessDescriptor,
  HarnessEvent,
  HarnessHealth,
  HarnessPort,
  HarnessSession,
  SessionOutcome,
  SessionSpec,
  TurnInput,
} from "@rennet/core";
import type { Hunk, Patchset, PatchsetIntentSurface } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  createGitShowFileRead,
  createVerificationFileReader,
  createVerificationFileReaderForPatchset,
  createVerificationTurn,
  DEFAULT_VERIFICATION_CONTEXT_LINES,
} from "./finding-verification-backend";
import type { GitExec } from "./git-range-diff";

// ── The real-file reader (hermetic: an injected read, no disk) ──────────────────

function hunk(overrides: Partial<Hunk> & { id: string; filePath: string }): Hunk {
  return {
    fileStatus: "modified",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    addedLines: [],
    deletedLines: [],
    contextLines: [],
    changedLoc: 1,
    ...overrides,
  };
}

const FILE = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");

describe("createVerificationFileReader (#179)", () => {
  it("returns the real window around a hunk — MORE than the offered hunk", async () => {
    const read = createVerificationFileReader({
      hunks: [hunk({ id: "h1", filePath: "src/a.ts", newStart: 100, newLines: 3 })],
      repositoryRoot: "/repo",
      readFile: () => FILE,
      contextLines: 10,
    });
    const window = await read("rennet:hunk/h1");
    expect(window).toBeDefined();
    expect(window?.path).toBe("src/a.ts");
    // 100 - 10 context .. (100 + 3 - 1) + 10 = lines 90..112.
    expect(window?.startLine).toBe(90);
    expect(window?.endLine).toBe(112);
    expect(window?.text).toContain("line 100");
    expect(window?.text).toContain("line 90");
    expect(window?.text).toContain("line 112");
  });

  it("clamps the window to the file bounds", async () => {
    const read = createVerificationFileReader({
      hunks: [hunk({ id: "h1", filePath: "a.ts", newStart: 1, newLines: 1 })],
      repositoryRoot: "/repo",
      readFile: () => "only one line",
      contextLines: DEFAULT_VERIFICATION_CONTEXT_LINES,
    });
    const window = await read("rennet:hunk/h1");
    expect(window?.startLine).toBe(1);
    expect(window?.endLine).toBe(1);
    expect(window?.text).toBe("only one line");
  });

  it("returns undefined for an unknown hunk (fail-closed → core caveats it)", async () => {
    const read = createVerificationFileReader({
      hunks: [hunk({ id: "h1", filePath: "a.ts" })],
      repositoryRoot: "/repo",
      readFile: () => FILE,
    });
    expect(await read("rennet:hunk/nope")).toBeUndefined();
    expect(await read("not-an-anchor")).toBeUndefined();
  });

  it("refuses an unsafe file path (path escape) fail-closed", async () => {
    const read = createVerificationFileReader({
      hunks: [hunk({ id: "h1", filePath: "../../etc/passwd" })],
      repositoryRoot: "/repo",
      readFile: () => "secret",
    });
    expect(await read("rennet:hunk/h1")).toBeUndefined();
  });

  it("returns undefined when the file cannot be read", async () => {
    const read = createVerificationFileReader({
      hunks: [hunk({ id: "h1", filePath: "a.ts" })],
      repositoryRoot: "/repo",
      readFile: () => undefined,
    });
    expect(await read("rennet:hunk/h1")).toBeUndefined();
  });
});

// ── The git-show-at-head read + the by-review-kind selector (#179 → PR/retro) ───

/** A fake git runner that answers `git show <oid>:<path>` from an in-memory tree. */
function fakeGitShow(
  filesAtHead: Record<string, string>,
  expectedHeadOid: string,
): { git: GitExec; calls: string[] } {
  const calls: string[] = [];
  const git: GitExec = (_root, arguments_) => {
    calls.push(arguments_.join(" "));
    const spec = arguments_[1] ?? "";
    const colon = spec.indexOf(":");
    const oid = spec.slice(0, colon);
    const path = spec.slice(colon + 1);
    if (arguments_[0] !== "show" || oid !== expectedHeadOid) {
      return Promise.reject(new Error(`unexpected git invocation: ${spec}`));
    }
    if (!(path in filesAtHead)) {
      // Mirror git: a missing path at an OID exits non-zero (execaGit would throw).
      return Promise.reject(new Error(`fatal: path '${path}' does not exist in '${oid}'`));
    }
    return Promise.resolve(filesAtHead[path] as string);
  };
  return { git, calls };
}

/** A minimal `Patchset` carrying a repository root + head OID + captured surface. */
function patchset(overrides: {
  root?: string;
  headOid?: string;
  surface?: PatchsetIntentSurface;
}): Patchset {
  const root = overrides.root ?? "/repo";
  return {
    id: "ps1",
    createdAt: "2026-01-01T00:00:00.000Z",
    repository: {
      id: "r1",
      root,
      commonDir: `${root}/.git`,
      baseRef: "origin/main",
      baseOid: "basesha",
      headOid: overrides.headOid ?? "headsha",
    },
    files: [],
    rawDiff: "",
    byteLength: 0,
    truncated: false,
    ...(overrides.surface === undefined ? {} : { intent: { surface: overrides.surface } }),
  };
}

describe("createGitShowFileRead (#179 → PR/retrospective)", () => {
  it("reads a file's content at the reviewed head OID via `git show <oid>:<path>`", async () => {
    const { git, calls } = fakeGitShow({ "src/a.ts": FILE }, "headsha");
    const read = createGitShowFileRead({ git, repositoryRoot: "/repo", headOid: "headsha" });
    expect(await read("/repo/src/a.ts")).toBe(FILE);
    expect(calls).toEqual(["show headsha:src/a.ts"]);
  });

  it("is fail-closed on a git error (unknown path / bad OID) → undefined", async () => {
    const { git } = fakeGitShow({ "src/a.ts": FILE }, "headsha");
    const read = createGitShowFileRead({ git, repositoryRoot: "/repo", headOid: "headsha" });
    expect(await read("/repo/src/missing.ts")).toBeUndefined();
  });

  it("refuses a path escaping the repository root — fail-closed, no git call", async () => {
    const calls: string[] = [];
    const git: GitExec = (_root, arguments_) => {
      calls.push(arguments_.join(" "));
      return Promise.resolve("");
    };
    const read = createGitShowFileRead({ git, repositoryRoot: "/repo", headOid: "headsha" });
    expect(await read("/etc/passwd")).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("returns undefined for an empty head OID — never `git show :path` against the index", async () => {
    const calls: string[] = [];
    const git: GitExec = (_root, arguments_) => {
      calls.push(arguments_.join(" "));
      return Promise.resolve("");
    };
    const read = createGitShowFileRead({ git, repositoryRoot: "/repo", headOid: "" });
    expect(await read("/repo/src/a.ts")).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("createVerificationFileReaderForPatchset (#179 → PR/retrospective)", () => {
  it("PR review: reads the real window from the reviewed HEAD via git show, not disk", async () => {
    const { git, calls } = fakeGitShow({ "src/a.ts": FILE }, "headsha");
    const read = createVerificationFileReaderForPatchset({
      patchset: patchset({ surface: "github-pr", root: "/repo", headOid: "headsha" }),
      hunks: [hunk({ id: "h1", filePath: "src/a.ts", newStart: 100, newLines: 3 })],
      git,
      contextLines: 10,
    });
    const window = await read("rennet:hunk/h1");
    expect(window?.path).toBe("src/a.ts");
    // The SAME window math as the working-tree reader, over the git-show content.
    expect(window?.startLine).toBe(90);
    expect(window?.endLine).toBe(112);
    expect(window?.text).toContain("line 100");
    expect(calls).toEqual(["show headsha:src/a.ts"]);
  });

  it("retrospective/range review with NO captured intent surface still uses git show", async () => {
    const { git, calls } = fakeGitShow({ "src/a.ts": FILE }, "headsha");
    const read = createVerificationFileReaderForPatchset({
      patchset: patchset({ surface: undefined, root: "/repo", headOid: "headsha" }),
      hunks: [hunk({ id: "h1", filePath: "src/a.ts", newStart: 5, newLines: 1 })],
      git,
    });
    expect((await read("rennet:hunk/h1"))?.text).toContain("line 5");
    expect(calls).toEqual(["show headsha:src/a.ts"]);
  });

  it("working-tree review: reads on disk (injected), never shells out to git show", async () => {
    const calls: string[] = [];
    const git: GitExec = (_root, arguments_) => {
      calls.push(arguments_.join(" "));
      return Promise.resolve("");
    };
    const read = createVerificationFileReaderForPatchset({
      patchset: patchset({ surface: "working-tree", root: "/repo", headOid: "headsha" }),
      hunks: [hunk({ id: "h1", filePath: "src/a.ts", newStart: 1, newLines: 1 })],
      git,
      readFile: () => FILE,
    });
    expect((await read("rennet:hunk/h1"))?.text).toContain("line 1");
    expect(calls).toEqual([]);
  });

  it("PR review is fail-closed when the file is absent at head → undefined (honest inconclusive)", async () => {
    const { git } = fakeGitShow({}, "headsha");
    const read = createVerificationFileReaderForPatchset({
      patchset: patchset({ surface: "github-pr", root: "/repo", headOid: "headsha" }),
      hunks: [hunk({ id: "h1", filePath: "src/a.ts" })],
      git,
    });
    expect(await read("rennet:hunk/h1")).toBeUndefined();
  });
});

// ── The fresh verification session over a scripted fake HarnessPort ─────────────

function endedEvent(outcome: SessionOutcome): HarnessEvent {
  return {
    seq: 1,
    harness: "claude-code",
    sessionId: "s1",
    turnId: "t1",
    receivedAt: 0,
    native: {},
    kind: "session.ended",
    outcome,
  };
}

interface FakeState {
  spec?: SessionSpec;
  sent: TurnInput[];
  closed: boolean;
}

function fakePort(events: HarnessEvent[], state: FakeState): HarnessPort {
  return {
    descriptor: { id: "claude-code" } as unknown as HarnessDescriptor,
    health(): Promise<HarnessHealth> {
      return Promise.resolve({ state: "ready", version: "2.1.0" });
    },
    createSession(spec: SessionSpec): Promise<HarnessSession> {
      state.spec = spec;
      const session: HarnessSession = {
        id: "s1",
        harness: "claude-code",
        events: {
          async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
            for (const event of events) yield event;
          },
        },
        send(input: TurnInput): Promise<string> {
          state.sent.push(input);
          return Promise.resolve("t1");
        },
        interrupt: () => Promise.resolve(),
        close(): Promise<void> {
          state.closed = true;
          return Promise.resolve();
        },
      };
      return Promise.resolve(session);
    },
  };
}

describe("createVerificationTurn (#179)", () => {
  it("emits the structured body of a completed turn, constrained to the verify schema", async () => {
    const body = { verifications: [{ ref: "f1", verdict: "reproduced", evidence: "e" }] };
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [endedEvent({ status: "completed", finalText: "ok", structuredOutput: body })],
      state,
    );
    const turn = createVerificationTurn(port, { cwd: "/repo", model: "claude-opus-4-8" });
    const result = await turn("verify this");
    expect(result).toEqual({ status: "emitted", body });
    // A fresh, schema-constrained session on the requested (different) seat.
    expect(state.spec?.outputSchema).toBeDefined();
    expect(state.spec?.model).toBe("claude-opus-4-8");
    expect(state.sent).toHaveLength(1);
    expect(state.closed).toBe(true);
  });

  it("threads real token usage when the terminal frame carries it", async () => {
    const usage = {
      input: 50,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: null,
      total: 60,
    };
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [
        endedEvent({
          status: "completed",
          finalText: "ok",
          structuredOutput: { verifications: [] },
          usage,
        }),
      ],
      state,
    );
    const turn = createVerificationTurn(port, { cwd: "/repo" });
    const result = await turn("verify");
    expect(result.status).toBe("emitted");
    if (result.status === "emitted") expect(result.tokens).toEqual(usage);
  });

  it("maps a completed turn WITHOUT structured output to a failure (core → inconclusive)", async () => {
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort([endedEvent({ status: "completed", finalText: "no json" })], state);
    const turn = createVerificationTurn(port, { cwd: "/repo" });
    const result = await turn("verify");
    expect(result.status).toBe("failed");
    expect(state.closed).toBe(true);
  });

  it("maps a failed outcome to a turn failure", async () => {
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [
        endedEvent({
          status: "failed",
          error: {
            class: "upstream",
            origin: "provider",
            message: "boom",
            retryable: true,
            retryableSource: "inferred",
            nativeCode: "server_error",
          },
        }),
      ],
      state,
    );
    const turn = createVerificationTurn(port, { cwd: "/repo" });
    const result = await turn("verify");
    expect(result).toEqual({ status: "failed", message: "boom" });
  });
});

// ── The executed-reproduction observation (#259): the shell was invoked and printed ─

function toolStartedExec(callId: string, command: string): HarnessEvent {
  return {
    seq: 1,
    harness: "claude-code",
    sessionId: "s1",
    turnId: "t1",
    receivedAt: 0,
    native: {},
    kind: "tool.started",
    call: { id: callId, name: "Bash", input: { command }, parentToolCallId: null, kind: "exec" },
  };
}

function toolOutputEvent(callId: string, ok: boolean, text: string): HarnessEvent {
  return {
    seq: 2,
    harness: "claude-code",
    sessionId: "s1",
    turnId: "t1",
    receivedAt: 0,
    native: {},
    kind: "tool.output",
    callId,
    ok,
    output: {},
    text,
  };
}

function toolStartedRead(callId: string, path: string): HarnessEvent {
  return {
    seq: 1,
    harness: "claude-code",
    sessionId: "s1",
    turnId: "t1",
    receivedAt: 0,
    native: {},
    kind: "tool.started",
    call: {
      id: callId,
      name: "Read",
      input: { file_path: path },
      parentToolCallId: null,
      kind: "read",
    },
  };
}

describe("createVerificationTurn executed-reproduction observation (#259)", () => {
  const reproducedBody = {
    verifications: [{ ref: "f1", verdict: "reproduced", evidence: "the test fails" }],
  };

  it("records the exec commands the turn RAN, with their output tail, as executed evidence", async () => {
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [
        toolStartedExec("c1", "pnpm vitest run empty.test.ts"),
        toolOutputEvent("c1", false, "FAIL empty.test.ts\n 1 failed | 0 passed"),
        endedEvent({ status: "completed", finalText: "ok", structuredOutput: reproducedBody }),
      ],
      state,
    );
    const turn = createVerificationTurn(port, { cwd: "/repo" });
    const result = await turn("verify");
    expect(result.status).toBe("emitted");
    if (result.status === "emitted") {
      expect(result.execution?.commands).toEqual([
        {
          command: "pnpm vitest run empty.test.ts",
          ok: false,
          outputTail: "FAIL empty.test.ts\n 1 failed | 0 passed",
        },
      ]);
    }
  });

  it("carries NO execution when the turn ran nothing — a re-read is never dressed up as a run", async () => {
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [endedEvent({ status: "completed", finalText: "ok", structuredOutput: reproducedBody })],
      state,
    );
    const turn = createVerificationTurn(port, { cwd: "/repo" });
    const result = await turn("verify");
    if (result.status === "emitted") expect(result.execution).toBeUndefined();
  });

  it("ignores non-exec tool calls — reading a file is not running the code", async () => {
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [
        toolStartedRead("r1", "src/a.ts"),
        toolOutputEvent("r1", true, "const x = load();"),
        endedEvent({ status: "completed", finalText: "ok", structuredOutput: reproducedBody }),
      ],
      state,
    );
    const turn = createVerificationTurn(port, { cwd: "/repo" });
    const result = await turn("verify");
    if (result.status === "emitted") expect(result.execution).toBeUndefined();
  });

  it("truncates a long command output to the tail, where a test/build verdict prints", async () => {
    const long = `${"x".repeat(2000)}\n=== 3 failed ===`;
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [
        toolStartedExec("c1", "pnpm build"),
        toolOutputEvent("c1", false, long),
        endedEvent({ status: "completed", finalText: "ok", structuredOutput: reproducedBody }),
      ],
      state,
    );
    const turn = createVerificationTurn(port, { cwd: "/repo" });
    const result = await turn("verify");
    if (result.status === "emitted") {
      const tail = result.execution?.commands[0]?.outputTail ?? "";
      expect(tail.length).toBeLessThanOrEqual(800);
      expect(tail.endsWith("=== 3 failed ===")).toBe(true);
    }
  });

  it("a DUPLICATE tool-call id is excluded, never misattributing one command's output to another (#268 Gap A)", async () => {
    // The literal bug: two exec starts share id c1, then one output arrives. The old
    // `if (!has)` guard dropped the second command and wrote c1's output onto the FIRST
    // record — surfacing `pnpm test first.test.ts` with `node second-repro.js`'s output.
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [
        toolStartedExec("c1", "pnpm test first.test.ts"),
        toolStartedExec("c1", "node second-repro.js"),
        toolOutputEvent("c1", false, "SECOND_ONLY"),
        // A distinct-id command in the same turn is still recorded normally (control).
        toolStartedExec("c2", "node good.js"),
        toolOutputEvent("c2", false, "GOOD"),
        endedEvent({ status: "completed", finalText: "ok", structuredOutput: reproducedBody }),
      ],
      state,
    );
    const turn = createVerificationTurn(port, { cwd: "/repo" });
    const result = await turn("verify");
    expect(result.status).toBe("emitted");
    if (result.status === "emitted") {
      // The ambiguous c1 record surfaces NOWHERE — not as a command, not as incomplete.
      const commands = result.execution?.commands ?? [];
      const incomplete = result.execution?.incomplete ?? [];
      const all = [...commands, ...incomplete];
      expect(all.some((c) => c.command === "pnpm test first.test.ts")).toBe(false);
      expect(all.some((c) => c.command === "node second-repro.js")).toBe(false);
      expect(all.some((c) => c.outputTail.includes("SECOND_ONLY"))).toBe(false);
      // The unambiguous control command is still recorded with its own output.
      expect(commands.map((c) => c.command)).toEqual(["node good.js"]);
      expect(commands[0]?.outputTail).toBe("GOOD");
    }
  });

  it("a started-but-unpaired exec is NOT a run: it stays out of commands, kept as incomplete (#268 F1)", async () => {
    // A command that STARTED but was denied/interrupted before any output used to be
    // recorded as {ok: true} — an unrun command reported as a clean one. It must not
    // count as executed: it belongs in `incomplete`, never in `commands`.
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [
        toolStartedExec("c1", "pnpm test"), // no matching tool.output → never ran to completion
        toolStartedExec("c2", "node repro.js"),
        toolOutputEvent("c2", false, "TypeError"), // this one completed
        endedEvent({ status: "completed", finalText: "ok", structuredOutput: reproducedBody }),
      ],
      state,
    );
    const turn = createVerificationTurn(port, { cwd: "/repo" });
    const result = await turn("verify");
    expect(result.status).toBe("emitted");
    if (result.status === "emitted") {
      // Only the completed command is proof of a run.
      expect(result.execution?.commands.map((c) => c.command)).toEqual(["node repro.js"]);
      // The unpaired one is kept separately, never reported as ok.
      expect(result.execution?.incomplete?.map((c) => c.command)).toEqual(["pnpm test"]);
      expect(result.execution?.incomplete?.[0]?.ok).toBe(false);
    }
  });
});
