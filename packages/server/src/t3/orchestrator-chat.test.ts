import {
  type CouncilOverrideReader,
  reviewRoleJobId,
  reviewRoleMappings,
  taskOverridesFor,
} from "@rennet/core";
import type { CouncilHarnessId, CouncilPick, ReviewRoleScenario } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  orchestratorChatSelection,
  resolveSessionThreadModel,
  type SessionThreadRoutingProbes,
} from "./orchestrator-chat";

// ─────────────────────────────────────────────────────────────────────────────
// session-thread-briefing 4.4 — THE WELCOME'S ORCHESTRATOR CHOICE, END TO END.
//
// The first-run welcome asks which harness orchestrates reviews and writes the answer with
// `settings.setRoleAssignment({ roleId: "orchestrator", scenario: "dual", assignment })`,
// reading `assignment` off the `orchestrator` row of `settings.reviewRoles`. Before this
// change there WAS no such row: `reviewRoleJobId("orchestrator")` was `undefined`, the read
// found nothing, the write never went out, and on a host with both harnesses the `both`
// table sent the chat to Claude whatever the reviewer clicked — under copy reading "Codex
// will orchestrate reviews".
//
// So this walks the welcome's OWN steps, in its own order, rather than asserting on the
// catalogue: read the row, take the cell for the chosen harness, store it in the `dual`
// column, read it back through the reader every dispatch site uses, and resolve. The thread
// it lands on is the assertion.
//
// WHAT THIS CANNOT CATCH: that the welcome component still performs those steps — that is
// `first-run-welcome`'s own DOM tests — and that a Codex thread is actually briefed through
// Codex's developer instructions, which is cluster 1's vendored `CodexAdapter` test.
// ─────────────────────────────────────────────────────────────────────────────

const BOTH: readonly CouncilHarnessId[] = ["claude-code", "codex"];

/** Exactly what `ReviewSetupStage.save()` reads for the harness the reviewer clicked. */
function welcomeAssignment(choice: "claude" | "codex"): CouncilPick {
  const row = reviewRoleMappings().find((role) => role.id === "orchestrator");
  const cell = row?.[choice === "claude" ? "claudeOnly" : "codexOnly"];
  if (!cell?.value) throw new Error(`the welcome found no orchestrator cell for ${choice}`);
  return cell.value;
}

/** …and exactly what `settings.setRoleAssignment` persists, read back as a dispatch reads it. */
function storedAs(scenario: ReviewRoleScenario, assignment: CouncilPick): CouncilOverrideReader {
  const jobId = reviewRoleJobId("orchestrator");
  if (jobId === undefined) throw new Error("the orchestrator role has no council job");
  return (availability) => taskOverridesFor({ [jobId]: { [scenario]: assignment } }, availability);
}

describe("the welcome's orchestrator choice reaches the session thread", () => {
  it("is a live write at all — the role maps onto the council's own job", () => {
    // The single line the whole feature hung on. `settings.ts` throws "unknown review role"
    // when this is undefined, and the welcome's read of the row returns nothing.
    expect(reviewRoleJobId("orchestrator")).toBe("orchestrator-chat");
  });

  it("yields a CODEX thread when the reviewer chooses Codex with both harnesses installed", () => {
    const selection = orchestratorChatSelection({
      installed: BOTH,
      overrides: storedAs("dual", welcomeAssignment("codex")),
    });
    expect(selection?.instanceId).toBe("codex");
    // The council's codex-only pick for this job, in Codex's own vocabulary (no model-id
    // mapping on that leg), with the effort riding the selection.
    expect(selection?.model).toBe("gpt-5.6-terra");
    expect(selection?.options).toEqual([{ id: "reasoningEffort", value: "medium" }]);
  });

  it("yields a CLAUDE thread when the reviewer chooses Claude, on the same host", () => {
    const selection = orchestratorChatSelection({
      installed: BOTH,
      overrides: storedAs("dual", welcomeAssignment("claude")),
    });
    expect(selection?.instanceId).toBe("claudeAgent");
    // T3's Claude catalog takes the FULL model id `mapCouncilModel` produces, not the
    // council's short name — a seat gets the same treatment.
    expect(selection?.model).toContain("sonnet");
    expect(selection?.model).not.toBe("sonnet-5");
    expect(selection?.options).toEqual([{ id: "effort", value: "medium" }]);
  });

  it("routes to Claude with NO choice stored, which is what made the dead write invisible", () => {
    // The control for the two above: without an override the `both` table decides, and it
    // says Claude. That is why a broken write looked like a working one for a Claude user
    // and only ever showed up for someone who picked Codex.
    const selection = orchestratorChatSelection({ installed: BOTH });
    expect(selection?.instanceId).toBe("claudeAgent");
  });

  it("answers nothing when the choice names a harness this host does not have", () => {
    // A reviewer who chose Codex on a dual host and later uninstalled it. The resolution is
    // real (#89: the harness follows the model) and simply unrunnable, so the bind falls to
    // the sidecar's default and LOGS, rather than silently opening on Claude.
    const selection = orchestratorChatSelection({
      installed: ["claude-code"],
      overrides: storedAs("claudeOnly", { model: "gpt-5.6-terra", effort: "medium" }),
    });
    expect(selection).toBeUndefined();
  });

  it("answers nothing when no council harness is installed at all", () => {
    expect(orchestratorChatSelection({ installed: [] })).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// session-thread-briefing 4.1 (review) — WHAT "INSTALLED" MEANS FOR THIS THREAD.
//
// The first version asked `resolveProviderBinaries` directly and cached the answer for the
// daemon's life. Two things were wrong with that and both are silent:
//
//  • that probe catches each harness INDEPENDENTLY, so a transient Codex failure returns a
//    partial `{ claude }` rather than rejecting — and the cache-resetting `catch` never
//    fired, because nothing had rejected. A reviewer's stored Codex choice then routed to
//    Claude for the rest of the daemon's life, with no line anywhere;
//  • it ignored the enable choice entirely: a reviewer who turned Codex OFF in Settings
//    could still be handed a Codex conversation, which is the surface lying about its own
//    switch.
//
// So availability is now three vetoes over fresh probes. These drive the resolver directly;
// `create-server` supplies the real ones (the per-repo locus probes, the daemon settings,
// the sidecar's seeded binaries).
// ─────────────────────────────────────────────────────────────────────────────
describe("what counts as installed for the session thread", () => {
  const BOTH_SEEDED = { claude: "/bin/claude", codex: "/bin/codex" };
  const probes = (over: Partial<SessionThreadRoutingProbes> = {}): SessionThreadRoutingProbes => ({
    claudeAvailable: async () => true,
    codexAvailable: async () => true,
    disabledHarnesses: () => [],
    sidecarBinaries: () => BOTH_SEEDED,
    ...over,
  });

  it("does not pin a transient probe failure: the next bind sees the recovered host", async () => {
    let attempt = 0;
    const codexAvailable = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("codex app-server handshake timed out");
      return true;
    };
    const chosen = storedAs("dual", welcomeAssignment("codex"));
    // First bind: the probe rejects, so NOTHING is claimed — the thread opens on the
    // sidecar's default and the daemon logs it.
    expect(
      await resolveSessionThreadModel("/repo", probes({ codexAvailable, overrides: chosen })),
    ).toBeUndefined();
    // Second bind: the host is fine, and the reviewer's own choice is honoured. Under the
    // cache this stayed Claude forever.
    const recovered = await resolveSessionThreadModel(
      "/repo",
      probes({ codexAvailable, overrides: chosen }),
    );
    expect(recovered?.instanceId).toBe("codex");
  });

  it("honours the reviewer's enable choice even with both binaries present", async () => {
    const chosen = storedAs("dual", welcomeAssignment("codex"));
    const selection = await resolveSessionThreadModel(
      "/repo",
      probes({ disabledHarnesses: () => ["codex"], overrides: chosen }),
    );
    // Codex is installed, seeded and CHOSEN — and switched off. Claude-only availability
    // resolves the job to Claude rather than running a provider they disabled.
    expect(selection?.instanceId).toBe("claudeAgent");
    // Control: the same call with the switch on gives Codex, so the assertion above is
    // about the switch and not about the override never arriving.
    expect(
      (await resolveSessionThreadModel("/repo", probes({ overrides: chosen })))?.instanceId,
    ).toBe("codex");
  });

  it("answers nothing when the running sidecar has no binary for the routed provider", async () => {
    // An ADOPTED sidecar was seeded by a daemon this process never was. The council can
    // route the chat to Codex all it likes; that sidecar cannot start a Codex session.
    const selection = await resolveSessionThreadModel(
      "/repo",
      probes({
        sidecarBinaries: () => ({}),
        overrides: storedAs("dual", welcomeAssignment("codex")),
      }),
    );
    expect(selection).toBeUndefined();
  });

  it("falls to the harness the host actually has when the other is absent", async () => {
    const selection = await resolveSessionThreadModel(
      "/repo",
      probes({ codexAvailable: async () => false }),
    );
    expect(selection?.instanceId).toBe("claudeAgent");
  });
});
