import { describe, expect, it } from "vitest";
import { z } from "zod";
import { commands, isCommandName, parseCommandInput, parseCommandOutput } from "./index";

// The recorded registry snapshot (B3 clusters 4+6): the 62 ids absorbed from
// the pre-B3 definitions table, plus patchset.readSpan (new in cluster 6 — the
// span-read contract, client asset risk 2), plus the 12 `ask.*` durable-asks
// command shapes (B11 cluster 1 — the sole write path onto the ask event log;
// handlers land in cluster 2), plus review.reviseSpan (B11 cluster 5 — the
// living-draft span-rework command), plus the two session READS B9/B10 deferred
// (session.transcript — the chat dock's honest-absent transcript read; session.rounds
// — the rounds-ledger read), plus forge.detect (C17 cluster 1 — the per-host forge/`gh`
// CLI detection command that mirrors harness.detect and feeds `sourceControlByHost`), plus
// daemon.status (C17 cluster 2 — per-host daemon reachable/version/lastSeenVersion/
// updateAvailable, where an unreachable host invents nothing) and daemon.reconnect (C17
// cluster 5 — the on-demand re-handshake behind the host card's Reconnect button, whose
// failure carries the reason rather than reading green), plus harness.hosts
// (C17 cluster 3 — SERVER-side per-host agent detection, where a host that cannot be
// asked reads honestly absent instead of inheriting the local machine's agents) and
// harness.setEnabled (C17 cluster 3.2 — the served per-host enable store the toggle writes
// through, so a ruled-out agent stays ruled out across reload), plus forge.setEnabled (C17
// amendment A — the same served store for the Source Control row's toggle, which until now
// wrote nowhere and silently reset on reload), plus forge.hosts (C17 amendment B — the
// per-host mirror of harness.hosts, so a WSL card shows ITS own `gh` instead of a section
// it is structurally incapable of filling) and daemon.update (C17 cluster 6 — the real
// per-host daemon update behind the Update Daemon button, honest when there is no
// mechanism for that host), plus board.read (C18 — the lens-board read B3 froze the shape
// for and left to "B4/B10's business": the persisted board for one (reviewId, generation,
// lens), honest-null when that lens drafted no board that generation), plus project.rename
// (C18 — the C12 cluster-7 write both the sidebar row and the Settings identity field call,
// where an emptied name restores the org/repo fallback) and the four session commands the
// sidebar honest-empty projection was waiting on (session.list plus rename/setPinned/
// archive, each persisted so it survives reload). A
// dropped or renamed command fails this loudly; a NEW command is added here deliberately,
// with its registry row.
const ABSORBED_IDS = [
  "app.bootstrap",
  "ask.clearLineComment",
  "ask.edit",
  "ask.quoteClose",
  "ask.quoteOpen",
  "ask.quoteReply",
  "ask.read",
  "ask.restore",
  "ask.retire",
  "ask.setLineComment",
  "ask.setVerdictOverride",
  "ask.stage",
  "ask.unstage",
  "attention.acknowledge",
  "board.read",
  "daemon.reconnect",
  "daemon.status",
  "daemon.update",
  "device.registerPush",
  "flagged.adjudication",
  "flagged.review",
  "forge.detect",
  "forge.hosts",
  "forge.setEnabled",
  "fs.listDir",
  "github.connectCancel",
  "github.connectPoll",
  "github.connectStart",
  "github.disconnect",
  "github.setToken",
  "github.status",
  "harness.detect",
  "harness.hosts",
  "harness.setEnabled",
  "noise.review",
  "openspec.change",
  "openspec.coverage",
  "pairing.exchange",
  "pairing.listDevices",
  "pairing.mint",
  "pairing.revokeDevice",
  "patchset.readSpan",
  "project.cleanupWorktree",
  "project.contextAsk",
  "project.contextMap",
  "project.detail",
  "project.discover",
  "project.knowledgeDisposition",
  "project.process",
  "project.rename",
  "projects.add",
  "projects.list",
  "projects.remove",
  "publish.compose",
  "publish.review",
  "publish.submitPr",
  "repository.choose",
  "review.ask",
  "review.capture",
  "review.checkFreshness",
  "review.deltaDigest",
  "review.draftPrBody",
  "review.handoff.compose",
  "review.handoff.prepare",
  "review.handoff.run",
  "review.interrupt",
  "review.load",
  "review.openInEditor",
  "review.openPr",
  "review.prWorktree",
  "review.reattach",
  "review.refine",
  "review.regenerate",
  "review.reviseSpan",
  "review.setDisposition",
  "review.symbolLookup",
  "review.uiEvidence",
  "round.dispatch",
  "session.archive",
  "session.list",
  "session.rename",
  "session.rounds",
  "session.setPinned",
  "session.transcript",
  "settings.get",
  "settings.guidance",
  "settings.pinRepoValue",
  "settings.resetRepoValue",
  "settings.setAppearance",
  "settings.setCoachmarks",
  "settings.setGuidance",
  "settings.setKeybinding",
  "settings.setProjectValue",
  "settings.setRepoVisibility",
  "settings.setRoleAssignment",
] as const;

// The #465 v1 agent inventory, mapped by inspection (the session.* reads exist but stay
// unexposed; no navigate command exists yet). Mirrors AGENT_EXPOSED in index.ts so an
// exposure edit is deliberate.
// `repository.choose` + `project.discover` are the add-project prerequisites (the
// tool cannot fabricate a DiscoveryResult); `navigate` stays out until C11 (a
// client-locus row would force a host dispatch handler). Kept sorted — the invariant
// test compares against the alphabetically sorted list of agent-exposed ids.
const AGENT_INVENTORY = [
  "project.discover",
  "projects.add",
  "projects.list",
  "repository.choose",
  "review.capture",
  "review.openPr",
  "settings.get",
  "settings.pinRepoValue",
  "settings.resetRepoValue",
  "settings.setAppearance",
  "settings.setKeybinding",
  "settings.setRepoVisibility",
] as const;

describe("command registry invariants (#465)", () => {
  it("matches the recorded command snapshot (settings.setRepoLocus demoted, #476)", () => {
    expect(Object.keys(commands).sort()).toEqual([...ABSORBED_IDS]);
    expect(ABSORBED_IDS).toHaveLength(95);
  });

  it("every row carries label, exposure, and locus with today's uniform values", () => {
    for (const [id, row] of Object.entries(commands)) {
      // #465: tool name = command id = menu label.
      expect(row.label, id).toBe(id);
      expect(row.locus, id).toBe("host");
      expect(row.exposure.ui, id).toBe(true);
      expect(row.exposure.commandMenu, id).toBe(false);
      expect(row.exposure.agent, id).toBe(AGENT_INVENTORY.includes(id as never));
    }
  });

  it("agent exposure is exactly the v1 inventory", () => {
    const agentIds = Object.entries(commands)
      .filter(([, row]) => row.exposure.agent)
      .map(([id]) => id)
      .sort();
    expect(agentIds).toEqual([...AGENT_INVENTORY]);
  });

  it("patchset.readSpan parses a CodeRef citation in and cited lines out (B3 cluster 6)", () => {
    const citation = {
      patchsetId: "ps-1",
      path: "packages/core/src/pipeline.ts",
      side: "head",
      startLine: 12,
      endLine: 14,
    };
    expect(parseCommandInput("patchset.readSpan", citation)).toEqual(citation);
    // A working-tree-style absolute path is still a string — the NEVER-a-working-tree
    // rule is dispatch's contract (B4/B10); the shape pins patchsetId as mandatory.
    expect(() => parseCommandInput("patchset.readSpan", { ...citation, patchsetId: "" })).toThrow();
    const served = {
      lines: ["const a = 1;", "const b = 2;", "export { a, b };"],
      contextBefore: ["// pipeline floor"],
      contextAfter: [""],
    };
    expect(parseCommandOutput("patchset.readSpan", served)).toEqual(served);
    expect(() => parseCommandOutput("patchset.readSpan", { lines: "not-an-array" })).toThrow();
  });

  it("settings.setRoleAssignment validates its input (C16 write, #485)", () => {
    // A real cell edit: role + scenario + a concrete model+effort pick.
    const edit = {
      roleId: "lens-workers",
      scenario: "dual",
      assignment: { model: "opus-4.8", effort: "high" },
    };
    expect(parseCommandInput("settings.setRoleAssignment", edit)).toEqual(edit);
    // `assignment: null` is the Reset-to-council-default path.
    const reset = { roleId: "lens-workers", scenario: "claudeOnly", assignment: null };
    expect(parseCommandInput("settings.setRoleAssignment", reset)).toEqual(reset);
    // Model + effort only — no harness field (#89); an unknown scenario is rejected.
    expect(() =>
      parseCommandInput("settings.setRoleAssignment", { ...edit, scenario: "both" }),
    ).toThrow();
    expect(() =>
      parseCommandInput("settings.setRoleAssignment", {
        ...edit,
        assignment: { model: "gpt-4o", effort: "high" },
      }),
    ).toThrow();
    // Output echoes the re-resolved mappings for the optimistic adopt.
    const served = {
      reviewRoles: [
        {
          id: "lens-workers",
          label: "Lens Drafters",
          hint: "The heavy seat.",
          dual: { value: { model: "opus-4.8", effort: "high" }, layer: "override" },
          claudeOnly: { value: { model: "opus-4.8", effort: "high" }, layer: "default" },
          codexOnly: { value: { model: "gpt-5.6-sol", effort: "high" }, layer: "default" },
        },
      ],
    };
    expect(parseCommandOutput("settings.setRoleAssignment", served)).toEqual(served);
  });

  it("every row's args/output are the parse seams' schemas", () => {
    for (const [id, row] of Object.entries(commands)) {
      expect(row.args, id).toBeInstanceOf(z.ZodType);
      expect(row.output, id).toBeInstanceOf(z.ZodType);
      // The parse seams route through THIS row: a non-object payload must be
      // rejected by every command's object schema — proves per-row routing
      // without needing 62 hand-built fixtures.
      expect(() => parseCommandInput(id as never, Symbol("not-a-payload"))).toThrow();
      expect(() => parseCommandOutput(id as never, Symbol("not-a-payload"))).toThrow();
    }
  });

  it("round-trips a real payload through a known row", () => {
    expect(parseCommandInput("app.bootstrap", {})).toEqual({});
    expect(parseCommandInput("fs.listDir", { path: "/tmp" })).toEqual({ path: "/tmp" });
  });

  it("isCommandName answers from the registry", () => {
    expect(isCommandName("app.bootstrap")).toBe(true);
    expect(isCommandName("canvas.read")).toBe(false);
    expect(isCommandName("ordering.approve")).toBe(false);
  });
});
