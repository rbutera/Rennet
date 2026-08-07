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
