import { describe, expect, it } from "vitest";
import { readScenario } from "./scenario-reading";

describe("readScenario", () => {
  it("reads a transcribed OpenSpec scenario as its name plus one row per keyword clause", () => {
    // The exact shape the Design assembler ships: heading text, then the list items with
    // their markers, whitespace-collapsed onto one line.
    const reading = readScenario(
      "Scenario: Branch review on the current checkout - **WHEN** a reviewer whose repository resolves `workspace: share` starts a review - **THEN** the session binds to that checkout - **AND** no worktree is created",
      { condition: "a reviewer whose repository", response: "the session binds" },
    );
    expect(reading.name).toBe("Branch review on the current checkout");
    expect(reading.rows).toEqual([
      {
        keyword: "When",
        clause: "when",
        text: "a reviewer whose repository resolves `workspace: share` starts a review",
      },
      { keyword: "Then", clause: "then", text: "the session binds to that checkout" },
      { keyword: "And", clause: "and", text: "no worktree is created" },
    ]);
  });

  it("keeps a GIVEN clause the host's condition/response split dropped", () => {
    const reading = readScenario(
      "Scenario: Cold start - GIVEN no session exists - WHEN the app opens - THEN the welcome shows",
    );
    expect(reading.rows.map((row) => row.keyword)).toEqual(["Given", "When", "Then"]);
  });

  it("falls back to the host's pair as Trigger/Outcome when the text carries no clause rows", () => {
    const reading = readScenario("WHEN refresh begins THEN the daemon records the attempt.", {
      condition: "refresh begins",
      response: "the daemon records the attempt.",
    });
    expect(reading.name).toBeUndefined();
    expect(reading.rows).toEqual([
      { keyword: "Trigger", clause: "condition", text: "refresh begins" },
      { keyword: "Outcome", clause: "response", text: "the daemon records the attempt." },
    ]);
  });

  it("does not split on a lower-case 'and' inside a sentence", () => {
    const reading = readScenario(
      "Scenario: Two repos - WHEN a workspace holds two repositories - and both are checked out - THEN each binds under its own key",
    );
    expect(reading.rows.map((row) => row.keyword)).toEqual(["When", "Then"]);
    expect(reading.rows[0]?.text).toBe(
      "a workspace holds two repositories - and both are checked out",
    );
  });

  it("returns no rows for plain prose with no host pair, leaving the paragraph to render", () => {
    expect(readScenario("The reviewer opens the board and reads it.")).toEqual({ rows: [] });
  });
});
