// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../test/dom";
import { completedRoundRecord, reportBoardFixture } from "../test/fixtures/rounds/report-board";
import { RoundGreeting } from "./round-greeting";
import { initialRoundState } from "./round-machine";

// The round's PROVENANCE, on the surface the reviewer actually reads
// (round-harness-dispatch: "the client SHALL display that provenance"). A round is a turn
// in the session's bound workspace now, so the two facts that say where the work happened
// and how to undo it are the bound root and the sidecar checkpoint — never a detached
// worktree path, because there is no longer one to name.
describe("RoundGreeting — where the round ran", () => {
  const receipt = { record: completedRoundRecord, roundNumber: 1 } as const;

  it("names the bound workspace root and the checkpoint reference", () => {
    const { container } = mount(
      <RoundGreeting
        board={reportBoardFixture}
        state={initialRoundState}
        onReveal={() => undefined}
        receipt={receipt}
      />,
    );
    const provenance = container.querySelector('[data-testid="round-run-workspace"]');
    expect(provenance?.textContent).toContain("/Users/rai/code/rennet");
    expect(provenance?.textContent).toContain("turn-12");
    // Not "3" — any digit anywhere satisfies that, including the turn id.
    expect(provenance?.textContent).toContain("(turn 3)");
    // Control: the ordinary round says nothing about a rewritten branch, so the sentence
    // below is not boilerplate every round carries.
    expect(provenance?.textContent).not.toContain("rewritten");
  });

  // A round the reviewer amended or rebased under is not refused — it runs and the account
  // records it, so this is the only place the reviewer learns the round's base was not the
  // commit they reviewed.
  it("says so when the branch was rewritten past the reviewed head", () => {
    const { container } = mount(
      <RoundGreeting
        board={reportBoardFixture}
        state={initialRoundState}
        onReveal={() => undefined}
        receipt={{
          record: {
            ...completedRoundRecord,
            run:
              completedRoundRecord.run === undefined
                ? undefined
                : { ...completedRoundRecord.run, branchRewritten: true },
          },
          roundNumber: 1,
        }}
      />,
    );
    expect(container.querySelector('[data-testid="round-run-workspace"]')?.textContent).toContain(
      "rewritten past the reviewed commit",
    );
  });

  // A row from before the binding carries neither fact. It says nothing rather than
  // guessing a root — the absent line is the honest one.
  it("says nothing at all for a legacy row that carries neither", () => {
    const { container } = mount(
      <RoundGreeting
        board={reportBoardFixture}
        state={initialRoundState}
        onReveal={() => undefined}
        receipt={{
          record: {
            ...completedRoundRecord,
            run: {
              startedAt: completedRoundRecord.run?.startedAt ?? 0,
              sourceTarget: completedRoundRecord.run?.sourceTarget ?? {
                kind: "branch",
                branch: "main",
              },
              gate: { outcome: "skipped", reason: "not-configured" },
            },
          },
          roundNumber: 1,
        }}
      />,
    );
    expect(container.querySelector('[data-testid="round-run-receipt"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="round-run-workspace"]')).toBeNull();
  });
});
