import { describe, expect, it } from "vitest";
import { commandDefinitions, isCommandName, parseCommandInput } from "./index";

describe("command protocol", () => {
  it("rejects malformed command payloads", () => {
    expect(() =>
      parseCommandInput("review.capture", { commandId: "not-a-uuid", repoPath: "" }),
    ).toThrow();
  });

  it("accepts a valid capture command", () => {
    expect(
      parseCommandInput("review.capture", {
        commandId: "92e8f263-a7ee-4fd8-9c11-40c9f6682661",
        repoPath: "/repo",
      }),
    ).toEqual({
      commandId: "92e8f263-a7ee-4fd8-9c11-40c9f6682661",
      repoPath: "/repo",
    });
  });

  it("accepts a disposition command with a null (clear) disposition", () => {
    expect(
      parseCommandInput("review.setDisposition", {
        commandId: "92e8f263-a7ee-4fd8-9c11-40c9f6682661",
        reviewId: "review",
        patchsetId: "patch",
        path: "a.ts",
        disposition: null,
        body: "",
      }).disposition,
    ).toBeNull();
  });

  it("rejects an unknown disposition type", () => {
    expect(() =>
      parseCommandInput("review.setDisposition", {
        commandId: "92e8f263-a7ee-4fd8-9c11-40c9f6682661",
        reviewId: "review",
        patchsetId: "patch",
        path: "a.ts",
        disposition: "merge",
        body: "",
      }),
    ).toThrow();
  });
});

describe("ordering is agent-owned: no user-approval command exists (issue #9)", () => {
  it("has no command that approves an ordering (structural, not a prompt)", () => {
    // The user does NOT approve the comprehension ordering (Q2, 2026-08-06).
    // "The human does not approve ordering" is a property of the wiring: the
    // command registry simply contains no such operation.
    expect(isCommandName("ordering.approve")).toBe(false);
    const orderingApproval = Object.keys(commandDefinitions).filter(
      (name) => /order/i.test(name) && /(approve|accept|confirm|dispose)/i.test(name),
    );
    expect(orderingApproval).toEqual([]);
  });
});
