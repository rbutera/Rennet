import type { CodexExecutor, HarnessPort, SessionSpec } from "@rennet/core";
import { describe, expect, it, vi } from "vitest";
import { createClaudeCiRefinementTurn, createCodexCiRefinementTurn } from "./ci-refinement-backend";

describe("CI refinement backend cancellation", () => {
  it("passes the per-turn deadline signal to the Claude session", async () => {
    let captured: SessionSpec | undefined;
    const port = {
      createSession: vi.fn(async (spec: SessionSpec) => {
        captured = spec;
        throw new Error("stop after capture");
      }),
    } as unknown as HarnessPort;
    const controller = new AbortController();
    const turn = createClaudeCiRefinementTurn(port, { cwd: "/repo" });

    await expect(turn("classify", controller.signal)).rejects.toThrow("stop after capture");
    expect(captured?.signal).toBe(controller.signal);
  });

  it("passes the per-turn deadline signal to the Codex executor", async () => {
    const executor = vi.fn<CodexExecutor>(async () => ({
      output: { classifications: [] },
    }));
    const controller = new AbortController();
    const turn = createCodexCiRefinementTurn(executor, { model: "test-model", effort: "low" });

    await turn("classify", controller.signal);
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });
});
