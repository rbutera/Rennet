import { describe, expect, it, vi } from "vitest";
import {
  createExclusiveNamespaceMover,
  type ExclusiveMoveHelperExecution,
} from "./exclusive-namespace-move";

const sourcePath = "/repo/.rennet-staged";
const destinationPath = "/repo/live";

function moverFor(execution: ExclusiveMoveHelperExecution) {
  const runHelper = vi.fn(async () => execution);
  return {
    mover: createExclusiveNamespaceMover({
      helperPath: "/runtime/rennet-exclusive-move",
      runHelper,
    }),
    runHelper,
  };
}

describe("exclusive namespace move", () => {
  it("passes source and destination as separate helper arguments", async () => {
    const { mover, runHelper } = moverFor({ kind: "exited", exitCode: 0, stderr: "" });

    await expect(mover.move({ sourcePath, destinationPath })).resolves.toEqual({ kind: "moved" });
    expect(runHelper).toHaveBeenCalledWith({
      helperPath: "/runtime/rennet-exclusive-move",
      sourcePath,
      destinationPath,
    });
  });

  it.each([
    [10, 17, "destination-exists"],
    [11, 2, "path-missing"],
    [12, 18, "cross-device"],
    [13, 95, "unsupported"],
  ] as const)(
    "maps helper exit %i and native code %i to %s",
    async (exitCode, nativeCode, kind) => {
      const { mover } = moverFor({
        kind: "exited",
        exitCode,
        stderr: `native-code=${nativeCode}\n`,
      });

      await expect(mover.move({ sourcePath, destinationPath })).resolves.toEqual({
        kind,
        nativeCode,
      });
    },
  );

  it("keeps an ordinary syscall refusal distinct from unsupported and cross-device", async () => {
    const { mover } = moverFor({
      kind: "exited",
      exitCode: 14,
      stderr: "native-code=13\n",
    });

    await expect(mover.move({ sourcePath, destinationPath })).resolves.toEqual({
      kind: "failed",
      nativeCode: 13,
    });
  });

  it("reports a helper that never started without claiming the move ran", async () => {
    const { mover } = moverFor({
      kind: "unavailable",
      code: "ENOENT",
      detail: "spawn ENOENT",
    });

    await expect(mover.move({ sourcePath, destinationPath })).resolves.toEqual({
      kind: "helper-unavailable",
      code: "ENOENT",
      detail: "spawn ENOENT",
    });
  });

  it("reports an interrupted helper as outcome-unknown", async () => {
    const { mover } = moverFor({
      kind: "interrupted",
      signal: "SIGKILL",
      detail: "helper terminated by SIGKILL",
    });

    await expect(mover.move({ sourcePath, destinationPath })).resolves.toEqual({
      kind: "outcome-unknown",
      detail: "helper terminated by SIGKILL",
    });
  });

  it.each([
    { kind: "exited", exitCode: 10, stderr: "" },
    { kind: "exited", exitCode: 64, stderr: "native-code=22\n" },
  ] satisfies readonly ExclusiveMoveHelperExecution[])(
    "treats a broken helper protocol as outcome-unknown",
    async (execution) => {
      const { mover } = moverFor(execution);

      await expect(mover.move({ sourcePath, destinationPath })).resolves.toEqual({
        kind: "outcome-unknown",
        detail: `exclusive move helper returned exit ${execution.exitCode} with stderr ${JSON.stringify(execution.stderr)}`,
      });
    },
  );
});
