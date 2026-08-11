import { describe, expect, it } from "vitest";
import { commandDefinitions, isCommandName, parseCommandInput } from "./index";

const COMMAND_ID = "92e8f263-a7ee-4fd8-9c11-40c9f6682661";

describe("canvas user commands (issue #10)", () => {
  it("accepts a canvas disposition command and rejects an unknown type", () => {
    expect(
      parseCommandInput("canvas.disposition", {
        commandId: COMMAND_ID,
        reviewId: "rev",
        patchsetId: "ps",
        path: "a.ts",
        disposition: "approve",
        body: "looks good",
      }).disposition,
    ).toBe("approve");
    expect(() =>
      parseCommandInput("canvas.disposition", {
        commandId: COMMAND_ID,
        reviewId: "rev",
        patchsetId: "ps",
        path: "a.ts",
        disposition: "merge",
        body: "",
      }),
    ).toThrow();
  });

  it("accepts an optional span+side (the Spec view's per-node write) and rejects half (issue #78)", () => {
    // Span-grained: both span and side present.
    const withSpan = parseCommandInput("canvas.disposition", {
      commandId: COMMAND_ID,
      reviewId: "rev",
      patchsetId: "ps",
      path: "openspec/changes/x/specs/cap/spec.md",
      disposition: "request-change",
      body: "needs a guard",
      span: { startLine: 3 },
      side: "additions",
    });
    expect(withSpan.span).toEqual({ startLine: 3 });
    expect(withSpan.side).toBe("additions");
    // A span without a side (or vice-versa) is rejected — all-or-none.
    expect(() =>
      parseCommandInput("canvas.disposition", {
        commandId: COMMAND_ID,
        reviewId: "rev",
        patchsetId: "ps",
        path: "a.ts",
        disposition: "comment",
        body: "",
        span: { startLine: 3 },
      }),
    ).toThrow();
  });

  it("accepts a proposal adjudication with an accepted/dismissed outcome only", () => {
    expect(
      parseCommandInput("canvas.adjudicateProposal", {
        commandId: COMMAND_ID,
        reviewId: "rev",
        canvasId: "cv",
        proposalId: "p1",
        outcome: "accepted",
      }).outcome,
    ).toBe("accepted");
    expect(() =>
      parseCommandInput("canvas.adjudicateProposal", {
        commandId: COMMAND_ID,
        reviewId: "rev",
        canvasId: "cv",
        proposalId: "p1",
        outcome: "auto-approve",
      }),
    ).toThrow();
  });
});

describe("L2 is user-sovereign: no agent/orchestrator disposition-write command exists (structural)", () => {
  it("has no orchestrator/agent-namespaced command in the IPC registry at all", () => {
    // The renderer (the user) reaches the engine through this map; the
    // orchestrator's ops are MCP tools (canvasOps@2), deliberately NOT here. So
    // "no agent writes a disposition" is a property of the wiring: there is no
    // orchestrator/agent-namespaced command, and no disposition-writing command
    // outside the two user surfaces.
    const agentNamespaced = Object.keys(commandDefinitions).filter((name) =>
      /^(orchestrator|agent|fleet)\./.test(name),
    );
    expect(agentNamespaced).toEqual([]);
    expect(isCommandName("orchestrator.disposition")).toBe(false);
    expect(isCommandName("canvas.orchestratorDisposition")).toBe(false);

    const dispositionWriters = Object.keys(commandDefinitions).filter((name) =>
      /dispos/i.test(name),
    );
    expect(dispositionWriters.sort()).toEqual(["canvas.disposition", "review.setDisposition"]);
  });
});
