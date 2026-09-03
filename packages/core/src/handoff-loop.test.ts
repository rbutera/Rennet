import type { HandoffDisposition, PatchFile, Patchset } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  anchoredContext,
  buildHandoffBundle,
  type CheckpointPort,
  disclosureFor,
  filesTouchedByDiff,
  HANDOFF_ADDRESSED_TYPES,
  type HandoffRunOutcome,
  type HandoffRunPort,
  isAddressedByHandoff,
  renderHandoffPrompt,
  runHandoffTurn,
} from "./handoff-loop";
import { inlineContextViolation } from "./harness-run-turn";

const FOO_PATCH = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "+const b = 2;",
  " const c = 3;",
  " const d = 4;",
].join("\n");

const BAR_PATCH = [
  "diff --git a/src/bar.ts b/src/bar.ts",
  "--- a/src/bar.ts",
  "+++ b/src/bar.ts",
  "@@ -10,2 +10,2 @@",
  "-let x = 0;",
  "+let x = 1;",
  " return x;",
].join("\n");

function file(path: string, patch: string): PatchFile {
  return { path, status: "modified", additions: 1, deletions: 0, binary: false, patch };
}

function patchsetOf(id: string, files: PatchFile[]): Patchset {
  return {
    id,
    createdAt: "2026-08-11T00:00:00.000Z",
    repository: {
      id: "repo",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "origin/main",
      baseOid: "base",
      headOid: "head",
    },
    files,
    rawDiff: files.map((entry) => entry.patch).join("\n"),
    byteLength: 0,
    truncated: false,
  };
}

const patchset = patchsetOf("ps-1", [file("src/bar.ts", BAR_PATCH), file("src/foo.ts", FOO_PATCH)]);

function disposition(
  over: Partial<HandoffDisposition> & Pick<HandoffDisposition, "path" | "type">,
): HandoffDisposition {
  return { body: "", ...over };
}

describe("HANDOFF_ADDRESSED_TYPES", () => {
  it("addresses request-change and comment, never approve or question", () => {
    expect([...HANDOFF_ADDRESSED_TYPES].sort()).toEqual(["comment", "request-change"]);
    expect(isAddressedByHandoff("request-change")).toBe(true);
    expect(isAddressedByHandoff("comment")).toBe(true);
    expect(isAddressedByHandoff("approve")).toBe(false);
    expect(isAddressedByHandoff("question")).toBe(false);
  });
});

describe("buildHandoffBundle", () => {
  it("filters out approve and question, keeping only the addressed dispositions", () => {
    const bundle = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [
        disposition({ path: "src/foo.ts", type: "request-change", body: "add a guard" }),
        disposition({ path: "src/foo.ts", type: "approve", body: "looks good" }),
        disposition({ path: "src/bar.ts", type: "question", body: "why?" }),
        disposition({ path: "src/bar.ts", type: "comment", body: "tidy this" }),
      ],
    });
    expect(bundle.tasks.map((t) => `${t.path}:${t.type}`)).toEqual([
      "src/bar.ts:comment",
      "src/foo.ts:request-change",
    ]);
  });

  it("resolves a span anchor to its covering hunk as the task context", () => {
    const bundle = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [
        disposition({
          path: "src/foo.ts",
          type: "request-change",
          body: "rename b",
          span: { startLine: 2 },
          side: "additions",
        }),
      ],
    });
    const [task] = bundle.tasks;
    expect(task?.context).toContain("+const b = 2;");
    expect(task?.context).toContain("@@ -1,3 +1,4 @@");
  });

  it("gives a path-grained disposition the whole file patch as context", () => {
    const bundle = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [disposition({ path: "src/bar.ts", type: "request-change", body: "revert" })],
    });
    expect(bundle.tasks[0]?.context).toBe(BAR_PATCH);
  });

  it("gives empty context when the file is not in the active patchset (never a guess)", () => {
    const bundle = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [disposition({ path: "src/gone.ts", type: "comment", body: "?" })],
    });
    expect(bundle.tasks[0]?.context).toBe("");
  });

  it("is deterministic in the disposition set — same set, same digest, regardless of input order", () => {
    const a = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [
        disposition({ path: "src/foo.ts", type: "request-change", body: "x" }),
        disposition({ path: "src/bar.ts", type: "comment", body: "y" }),
      ],
    });
    const b = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [
        disposition({ path: "src/bar.ts", type: "comment", body: "y" }),
        disposition({ path: "src/foo.ts", type: "request-change", body: "x" }),
      ],
    });
    expect(a.digest).toBe(b.digest);
    expect(a.prompt).toBe(b.prompt);
  });

  it("changes the digest when an instruction body changes (the consent binds to content)", () => {
    const base = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [disposition({ path: "src/foo.ts", type: "request-change", body: "x" })],
    });
    const edited = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [disposition({ path: "src/foo.ts", type: "request-change", body: "x!" })],
    });
    expect(edited.digest).not.toBe(base.digest);
  });

  it("carries the active patchset id as the bundle baseline", () => {
    const bundle = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [disposition({ path: "src/foo.ts", type: "comment", body: "x" })],
    });
    expect(bundle.patchsetId).toBe("ps-1");
  });

  it("keeps both asks when the caller supplies the same durable id twice", () => {
    const bundle = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [
        disposition({
          id: "ask-7",
          path: "src/foo.ts",
          type: "request-change",
          body: "add the first guard",
          span: { startLine: 2 },
          side: "additions",
        }),
        disposition({
          id: "ask-7",
          path: "src/foo.ts",
          type: "request-change",
          body: "add the second guard",
          span: { startLine: 3 },
          side: "additions",
        }),
      ],
    });

    expect(bundle.tasks).toHaveLength(2);
    expect(bundle.tasks.map((task) => task.instruction)).toEqual([
      "add the first guard",
      "add the second guard",
    ]);
    expect(bundle.tasks.map((task) => task.id)).toEqual(["ask-7", "d0"]);
    expect(new Set(bundle.tasks.map((task) => task.id)).size).toBe(2);
  });

  it("never mints a fallback id that collides with a caller-provided id", () => {
    const bundle = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [
        disposition({ path: "src/bar.ts", type: "comment", body: "legacy ask" }),
        disposition({
          id: "d0",
          path: "src/foo.ts",
          type: "request-change",
          body: "durable ask",
        }),
      ],
    });

    expect(bundle.tasks.map(({ id, instruction }) => ({ id, instruction }))).toEqual([
      { id: "d1", instruction: "legacy ask" },
      { id: "d0", instruction: "durable ask" },
    ]);
  });
});

describe("renderHandoffPrompt — the items are NAMED, never inlined (3.7)", () => {
  it("names the work order, states the count, and carries no instruction body", () => {
    const bundle = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [
        disposition({ path: "src/foo.ts", type: "request-change", body: "add a guard" }),
      ],
    });
    expect(bundle.prompt).toContain(".rennet/context/r1/work-order.md");
    expect(bundle.prompt).toContain("Address ONLY the items in that file");
    expect(bundle.prompt).toContain("do NOT push");
    expect(bundle.prompt).toContain("1 requested change,");
    // The body and its diff fence are in the file, not in what the turn is billed for.
    expect(bundle.prompt).not.toContain("add a guard");
    expect(bundle.prompt).not.toContain("```diff");
    expect(inlineContextViolation(bundle.prompt)).toBeUndefined();
  });

  it("is CONSTANT in the tasks: forty items render the same length as one", () => {
    const one = renderHandoffPrompt(
      buildHandoffBundle({
        reviewId: "r1",
        patchset,
        dispositions: [disposition({ path: "src/foo.ts", type: "request-change", body: "x" })],
      }).tasks,
      "r1",
    );
    const forty = renderHandoffPrompt(
      buildHandoffBundle({
        reviewId: "r1",
        patchset,
        dispositions: Array.from({ length: 40 }, (_unused, index) =>
          disposition({
            path: "src/foo.ts",
            type: "request-change",
            body: `rework call site ${index} thoroughly and at length`,
            span: { startLine: index + 1 },
          }),
        ),
      }).tasks,
      "r1",
    );
    // Only the count differs — "1 requested change" vs "40 requested changes".
    expect(Math.abs(forty.length - one.length)).toBeLessThan(10);
  });

  it("renders the count as zero for an empty bundle", () => {
    expect(renderHandoffPrompt([], "r1")).toContain("0 requested changes,");
  });
});

describe("disclosureFor", () => {
  it("discloses write-enabled + working-tree edit and the task count", () => {
    const bundle = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [
        disposition({ path: "src/foo.ts", type: "request-change", body: "x" }),
        disposition({ path: "src/bar.ts", type: "comment", body: "y" }),
      ],
    });
    const disclosure = disclosureFor(bundle, "claude-code", "sonnet-5");
    expect(disclosure.writeEnabled).toBe(true);
    expect(disclosure.editsWorkingTree).toBe(true);
    expect(disclosure.taskCount).toBe(2);
    expect(disclosure.harness).toBe("claude-code");
    expect(disclosure.model).toBe("sonnet-5");
    expect(disclosure.summary).toContain("edit your working tree");
    expect(disclosure.summary).toContain("Nothing is committed or pushed");
  });
});

describe("anchoredContext", () => {
  it("bounds an oversized context and marks the cut honestly", () => {
    const big = file("src/big.ts", `diff --git a/src/big.ts b/src/big.ts\n${"x".repeat(50)}`);
    const bounded = anchoredContext(big, 20);
    expect(bounded.length).toBeLessThan(60);
    expect(bounded).toContain("context truncated at 20 bytes");
  });
});

describe("filesTouchedByDiff", () => {
  it("extracts the post-image path from every diff --git header, sorted", () => {
    const diff = [
      "diff --git a/src/z.ts b/src/z.ts",
      "@@ -1 +1 @@",
      "diff --git a/src/a.ts b/src/a.ts",
      "@@ -1 +1 @@",
    ].join("\n");
    expect(filesTouchedByDiff(diff)).toEqual(["src/a.ts", "src/z.ts"]);
  });

  it("returns nothing for an empty diff", () => {
    expect(filesTouchedByDiff("")).toEqual([]);
  });
});

function makeCheckpoint(
  opts: { diff?: string; paths?: readonly string[]; discardError?: string } = {},
) {
  let captureCount = 0;
  const capture = vi.fn<CheckpointPort["capture"]>(() => {
    captureCount += 1;
    return Promise.resolve({ ref: `r${captureCount}`, commit: `c${captureCount}` });
  });
  const diff = vi.fn<CheckpointPort["diff"]>(() => Promise.resolve(opts.diff ?? ""));
  const changedPaths = vi.fn<CheckpointPort["changedPaths"]>(() =>
    Promise.resolve(opts.paths ?? []),
  );
  const discard = vi.fn<CheckpointPort["discard"]>(() =>
    opts.discardError !== undefined
      ? Promise.reject(new Error(opts.discardError))
      : Promise.resolve(),
  );
  const port: CheckpointPort = { capture, diff, changedPaths, discard };
  return { port, capture, diff, changedPaths, discard };
}

function runPortReturning(outcome: HandoffRunOutcome): HandoffRunPort {
  return () => Promise.resolve(outcome);
}

const A_BUNDLE = () =>
  buildHandoffBundle({
    reviewId: "r1",
    patchset,
    dispositions: [disposition({ path: "src/foo.ts", type: "request-change", body: "x" })],
  });

describe("runHandoffTurn", () => {
  it("brackets the write turn with two checkpoints and returns the turn diff + files touched", async () => {
    const turnDiff =
      "diff --git a/src/foo.ts b/src/foo.ts\n@@ -1 +1 @@\n-const b = 2;\n+const b = 3;";
    const cp = makeCheckpoint({ diff: turnDiff, paths: ["src/foo.ts"] });
    const runPort = vi.fn<HandoffRunPort>(() =>
      Promise.resolve({ status: "completed", finalText: "done" }),
    );

    const result = await runHandoffTurn({
      repoRoot: "/repo",
      prompt: A_BUNDLE().prompt,
      runPort,
      checkpoint: cp.port,
    });

    expect(cp.capture).toHaveBeenCalledTimes(2); // before AND after the turn
    expect(runPort).toHaveBeenCalledTimes(1);
    // The write turn ran AFTER the first checkpoint, BEFORE the second (the bracket order).
    expect(cp.capture.mock.invocationCallOrder[0]).toBeLessThan(
      runPort.mock.invocationCallOrder[0] ?? 0,
    );
    expect(runPort.mock.invocationCallOrder[0]).toBeLessThan(
      cp.capture.mock.invocationCallOrder[1] ?? 0,
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.turnDiff).toBe(turnDiff);
      expect(result.filesTouched).toEqual(["src/foo.ts"]);
    }
    // Both checkpoint refs are cleaned up (Codex F5).
    expect(cp.discard).toHaveBeenCalledTimes(2);
  });

  it("proves totality — an edit to a file no disposition mentioned still appears in filesTouched", async () => {
    // `changedPaths` is the structural source (Codex F7); the agent also touched an
    // unrelated file, which the totality guarantee must surface.
    const cp = makeCheckpoint({ diff: "…", paths: ["src/foo.ts", "src/unrelated.ts"] });
    const result = await runHandoffTurn({
      repoRoot: "/repo",
      prompt: A_BUNDLE().prompt,
      runPort: runPortReturning({ status: "completed", finalText: "done" }),
      checkpoint: cp.port,
    });
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.filesTouched).toContain("src/unrelated.ts");
  });

  it("a FAILED turn still carries the turn diff + files it changed before erroring (Codex F4)", async () => {
    // The agent wrote src/half.ts, then the turn errored: the mutation is on disk and
    // must NOT be hidden. The post-checkpoint is taken on failure too.
    const partialDiff = "diff --git a/src/half.ts b/src/half.ts\n@@ -0,0 +1 @@\n+half";
    const cp = makeCheckpoint({ diff: partialDiff, paths: ["src/half.ts"] });
    const result = await runHandoffTurn({
      repoRoot: "/repo",
      prompt: A_BUNDLE().prompt,
      runPort: runPortReturning({ status: "failed", reason: "harness overloaded" }),
      checkpoint: cp.port,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("harness overloaded");
      expect(result.turnDiff).toBe(partialDiff);
      expect(result.filesTouched).toEqual(["src/half.ts"]); // the edits are visible, not hidden
    }
    // The post-checkpoint WAS taken (both captures) and both refs cleaned up.
    expect(cp.capture).toHaveBeenCalledTimes(2);
    expect(cp.discard).toHaveBeenCalledTimes(2);
  });

  it("discards both checkpoint refs best-effort even when discard rejects (hygiene, not a gate)", async () => {
    const cp = makeCheckpoint({ paths: ["src/foo.ts"], discardError: "cannot lock ref" });
    // A discard failure is swallowed — the run still returns its real result.
    const result = await runHandoffTurn({
      repoRoot: "/repo",
      prompt: A_BUNDLE().prompt,
      runPort: runPortReturning({ status: "completed", finalText: "done" }),
      checkpoint: cp.port,
    });
    expect(result.status).toBe("completed");
    expect(cp.discard).toHaveBeenCalledTimes(2);
  });
});
