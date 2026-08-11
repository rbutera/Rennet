import type { HandoffDisposition, PatchFile, Patchset } from "@rennet/types";
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
  notWiredLineageCarry,
  renderHandoffPrompt,
  runHandoffTurn,
} from "./handoff-loop";

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
});

describe("renderHandoffPrompt", () => {
  it("instructs the agent to address only the listed items and never push", () => {
    const bundle = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [
        disposition({ path: "src/foo.ts", type: "request-change", body: "add a guard" }),
      ],
    });
    expect(bundle.prompt).toContain("Address ONLY the items listed below");
    expect(bundle.prompt).toContain("do NOT push");
    expect(bundle.prompt).toContain("## Requested changes (1)");
    expect(bundle.prompt).toContain("add a guard");
  });

  it("renders the count as zero for an empty bundle", () => {
    expect(renderHandoffPrompt([])).toContain("## Requested changes (0)");
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

function checkpointReturning(diff: string): { port: CheckpointPort; captured: number } {
  const state = { captured: 0 };
  const port: CheckpointPort = {
    capture: () => {
      state.captured += 1;
      return Promise.resolve({
        ref: `refs/rennet/checkpoints/${state.captured}`,
        commit: `c${state.captured}`,
      });
    },
    diff: () => Promise.resolve(diff),
  };
  return { port, captured: state.captured };
}

function runPortReturning(outcome: HandoffRunOutcome): HandoffRunPort {
  return () => Promise.resolve(outcome);
}

describe("runHandoffTurn", () => {
  it("brackets the write turn with two checkpoints and returns the turn diff + files touched", async () => {
    const bundle = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [disposition({ path: "src/foo.ts", type: "request-change", body: "x" })],
    });
    const turnDiff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "@@ -1 +1 @@",
      "-const b = 2;",
      "+const b = 3;",
    ].join("\n");
    const capture = vi.fn<CheckpointPort["capture"]>(() =>
      Promise.resolve({ ref: "r", commit: "c" }),
    );
    const diff = vi.fn<CheckpointPort["diff"]>(() => Promise.resolve(turnDiff));
    const runPort = vi.fn<HandoffRunPort>(() =>
      Promise.resolve({ status: "completed", finalText: "done" }),
    );

    const result = await runHandoffTurn({
      repoRoot: "/repo",
      bundle,
      runPort,
      checkpoint: { capture, diff },
    });

    expect(capture).toHaveBeenCalledTimes(2); // before AND after the turn
    expect(runPort).toHaveBeenCalledTimes(1);
    // The write turn ran AFTER the first checkpoint (the bracket order).
    expect(capture.mock.invocationCallOrder[0]).toBeLessThan(
      runPort.mock.invocationCallOrder[0] ?? 0,
    );
    expect(runPort.mock.invocationCallOrder[0]).toBeLessThan(
      capture.mock.invocationCallOrder[1] ?? 0,
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.turnDiff).toBe(turnDiff);
      expect(result.filesTouched).toEqual(["src/foo.ts"]);
    }
  });

  it("proves totality — an edit to a file no disposition mentioned still appears in filesTouched", async () => {
    const bundle = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [disposition({ path: "src/foo.ts", type: "request-change", body: "x" })],
    });
    // The agent also touched src/unrelated.ts, which no disposition addressed.
    const turnDiff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "@@ -1 +1 @@",
      "diff --git a/src/unrelated.ts b/src/unrelated.ts",
      "@@ -1 +1 @@",
    ].join("\n");
    const { port } = checkpointReturning(turnDiff);
    const result = await runHandoffTurn({
      repoRoot: "/repo",
      bundle,
      runPort: runPortReturning({ status: "completed", finalText: "done" }),
      checkpoint: port,
    });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.filesTouched).toContain("src/unrelated.ts");
    }
  });

  it("does not diff or claim a turn when the write turn fails", async () => {
    const bundle = buildHandoffBundle({
      reviewId: "r1",
      patchset,
      dispositions: [disposition({ path: "src/foo.ts", type: "request-change", body: "x" })],
    });
    const diff = vi.fn<CheckpointPort["diff"]>(() => Promise.resolve(""));
    const capture = vi.fn<CheckpointPort["capture"]>(() =>
      Promise.resolve({ ref: "r", commit: "c" }),
    );
    const result = await runHandoffTurn({
      repoRoot: "/repo",
      bundle,
      runPort: runPortReturning({ status: "failed", reason: "harness overloaded" }),
      checkpoint: { capture, diff },
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toBe("harness overloaded");
    // The failed turn is not diffed into a fake result.
    expect(diff).not.toHaveBeenCalled();
  });
});

describe("notWiredLineageCarry (the #16 seam)", () => {
  it("reports the matcher is not wired rather than fabricating a carry", async () => {
    const result = await notWiredLineageCarry().carry({
      previous: [],
      previousPatchset: patchset,
      nextPatchset: patchset,
    });
    expect(result).toEqual({ status: "matcher-not-wired" });
  });
});
