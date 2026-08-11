// @vitest-environment happy-dom
//
// The Spec angle wired INTO CanvasWorkspace (review finding #1, guardrail #2 —
// "fail loud, never silent"). This mounts the real workspace on the spec angle over
// a real openSpecChange with a bridge that REJECTS the write (as the engine does for
// an artifact file not in the reviewed patchset, or a wrong-side span), and proves
// the rejection is SURFACED — `onDispositionError` fires and it is logged — never a
// swallowed no-op that looks like the comment persisted.
import type { CommandInput, RennetBridge } from "@rennet/protocol";
import type { OpenSpecChange } from "@rennet/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoCanvases } from "../canvas/fixtures";
import type { DispositionWrite } from "../canvas/logic";
import { createViewStore } from "../canvas/store";
import { mount } from "../test/dom";
import { CanvasWorkspace } from "./workspace";

const CHANGE: OpenSpecChange = {
  name: "add-review-intelligence-core",
  specDeltas: [
    {
      capability: "review-hypothesis-pass",
      source: { artifact: "spec", capability: "review-hypothesis-pass", line: 1 },
      groups: [
        {
          operation: "added",
          requirements: [
            {
              name: "A hypothesis is committed before the runners read the diff",
              statement: "The system SHALL run a hypothesis pre-read pass.",
              source: { artifact: "spec", capability: "review-hypothesis-pass", line: 3 },
              scenarios: [],
            },
          ],
        },
      ],
    },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe("Spec disposition — fail loud on engine rejection (finding #1, guardrail #2)", () => {
  it("surfaces onDispositionError + logs when canvas.disposition is rejected", async () => {
    const rejection = new Error("Cannot set a disposition on a path outside the active patchset");
    const invoked: CommandInput<"canvas.disposition">[] = [];
    const bridge: RennetBridge = {
      invoke: ((name: string, input: CommandInput<"canvas.disposition">) => {
        if (name === "canvas.disposition") {
          invoked.push(input);
          return Promise.reject(rejection);
        }
        return Promise.resolve({});
      }) as unknown as RennetBridge["invoke"],
    };
    const onDispositionError = vi.fn<(write: DispositionWrite, error: Error) => void>();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { getByRole, user } = mount(
      <CanvasWorkspace
        canvases={demoCanvases()}
        store={createViewStore({ angle: "spec" })}
        bridge={bridge}
        openSpecChange={CHANGE}
        onDispositionError={onDispositionError}
      />,
    );

    // Request-change on the requirement — its write targets the REAL spec.md file.
    await user.click(
      getByRole("button", {
        name: "Request change on element A hypothesis is committed before the runners read the diff",
      }),
    );

    // The write went to the engine (real artifact path + span), the engine rejected,
    // and the rejection was SURFACED — not swallowed.
    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.path).toContain("specs/review-hypothesis-pass/spec.md");
    expect(invoked[0]?.span).toEqual({ startLine: 3 });
    expect(invoked[0]?.side).toBe("additions");

    expect(onDispositionError).toHaveBeenCalledTimes(1);
    expect(onDispositionError.mock.calls[0]?.[0].path).toContain("spec.md");
    expect(onDispositionError.mock.calls[0]?.[1]).toBe(rejection);
    // The never-silent floor: even with a host handler, a rejection is logged.
    expect(errorLog).toHaveBeenCalled();
  });
});
