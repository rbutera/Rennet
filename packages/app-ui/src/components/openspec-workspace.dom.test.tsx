// @vitest-environment happy-dom
//
// The Spec angle wired INTO CanvasWorkspace (review finding #1, guardrail #2 —
// "fail loud, never silent"). This mounts the real workspace on the spec angle over
// a real openSpecChange with a bridge that REJECTS the write (as the engine does for
// an artifact file not in the reviewed patchset, or a wrong-side span), and proves
// the rejection is SURFACED — `onDispositionError` fires and it is logged — never a
// swallowed no-op that looks like the comment persisted.

import type { Canvas, CanvasAngle, ElementDiff, OpenSpecChange } from "@rennet/protocol";
import {
  CANVAS_ANGLES,
  type CommandInput,
  openSpecRequirementCoverageKey,
  type RennetBridge,
} from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoCanvases } from "../canvas/fixtures";
import type { DispositionWrite } from "../canvas/logic";
import type { OpenSpecCoverageIndex } from "../canvas/openspec";
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

describe("Spec coverage chip — the jump reaches the claiming hunk's diff (wireframes #9 / R53)", () => {
  it("clicking a covered chip switches to the owning code lens and renders the hunk diff", async () => {
    // The requirement is covered by c1-h1, a hunk that lives in the SHARED substrate
    // (the Spec canvas's own elements are doc-anchored, so the hunk is on a code lens).
    const coverage: OpenSpecCoverageIndex = new Map([
      [
        openSpecRequirementCoverageKey(
          "review-hypothesis-pass",
          "A hypothesis is committed before the runners read the diff",
        ),
        { hunks: ["rennet:hunk/c1-h1"], tests: 1 },
      ],
    ]);
    // A diff for whichever owning element the jump selects (the substrate resolves
    // c1-h1 to a chunk/hunk element on a code lens; diffFor is keyed by element key).
    const diff: ElementDiff = {
      path: "src/module-1/file-1.ts",
      paths: ["src/module-1/file-1.ts"],
      diff: "@@ -1,1 +1,2 @@\n+const committed = true;",
      hunkOccurrences: [[{ id: "c1-h1", oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }]],
    };
    const store = createViewStore({ angle: "spec" });

    const { getByRole, container, user } = mount(
      <CanvasWorkspace
        canvases={demoCanvases()}
        store={store}
        openSpecChange={CHANGE}
        openSpecCoverage={coverage}
        diffFor={() => diff}
      />,
    );

    // On the Spec angle, no code diff is shown yet.
    expect(container.querySelector(".diff-zoom")).toBeNull();
    expect(store.getState().angle).toBe("spec");

    // Click the covered chip → it must reach the claiming hunk's diff.
    await user.click(
      getByRole("button", { name: "covered by 1 hunk · 1 test — jump to the claiming hunk" }),
    );

    // The jump left the Spec angle for the code lens that OWNS the hunk, zoomed to the
    // diff, and the CodeView actually rendered it — not a silent no-op on the Spec canvas.
    expect(store.getState().angle).not.toBe("spec");
    expect(store.getState().zoom.level).toBe("diff");
    expect(store.getState().selection).toBeTruthy();
    expect(container.querySelector(".diff-zoom")).not.toBeNull();
    expect(container.textContent).toContain("const committed = true;");
  });

  it("a covered chip whose hunk is owned by a PROPOSAL chunk (outside the substrate) still jumps to it (#250 r2 F2)", async () => {
    // The claiming hunk h1 is in the sequence substrate but REGROUPED under a proposal
    // element anchored `rennet:chunk/agent-group`, which is NOT a substrate chunk. The
    // cross-canvas jump resolved element membership from substrate ids only, so it could
    // not find the proposal element and silently stayed on Spec. Membership must come
    // from the element's real diff (`hunkOccurrences`) so the regrouped hunk is found.
    const proposalCoverageCanvases = (): Record<CanvasAngle, Canvas> => {
      const build = (angle: CanvasAngle): Canvas => ({
        canvasId: `cid-${angle}`,
        reviewId: "r1",
        patchsetId: "p1",
        angle,
        layers: {
          substrate:
            angle === "sequence"
              ? { chunks: [{ chunkId: "c1", hunkIds: ["h1"], filePaths: ["src/a.ts"] }] }
              : { chunks: [] },
          analysis:
            angle === "sequence"
              ? {
                  elements: [
                    {
                      elementKey: "seq-el",
                      docId: "pdoc",
                      anchor: "rennet:chunk/agent-group",
                      kind: "chunk",
                      title: "Agent group",
                    },
                  ],
                  cohorts: [],
                  readingOrder: ["seq-el"],
                }
              : { elements: [], cohorts: [], readingOrder: [] },
          disposition: { dispositions: [] },
          annotation: { annotations: [], proposals: [] },
        },
        overlay: [],
      });
      return Object.fromEntries(CANVAS_ANGLES.map((a) => [a, build(a)])) as Record<
        CanvasAngle,
        Canvas
      >;
    };
    const coverage: OpenSpecCoverageIndex = new Map([
      [
        openSpecRequirementCoverageKey(
          "review-hypothesis-pass",
          "A hypothesis is committed before the runners read the diff",
        ),
        { hunks: ["rennet:hunk/h1"], tests: 1 },
      ],
    ]);
    const proposalDiff: ElementDiff = {
      path: "src/a.ts",
      paths: ["src/a.ts"],
      diff: "@@ -1,1 +1,2 @@\n+const committed = true;",
      hunkOccurrences: [[{ id: "h1", oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }]],
    };
    const store = createViewStore({ angle: "spec" });

    const { getByRole, container, user } = mount(
      <CanvasWorkspace
        canvases={proposalCoverageCanvases()}
        store={store}
        openSpecChange={CHANGE}
        openSpecCoverage={coverage}
        diffFor={() => proposalDiff}
      />,
    );

    expect(store.getState().angle).toBe("spec");
    await user.click(
      getByRole("button", { name: "covered by 1 hunk · 1 test — jump to the claiming hunk" }),
    );

    // The jump left Spec for the sequence lens whose PROPOSAL element owns h1, zoomed to
    // its diff, and rendered it — not a silent no-op on the Spec canvas.
    expect(store.getState().angle).toBe("sequence");
    expect(store.getState().zoom.level).toBe("diff");
    expect(store.getState().selection).toBe("seq-el");
    expect(container.querySelector(".diff-zoom")).not.toBeNull();
    expect(container.textContent).toContain("const committed = true;");
  });
});
