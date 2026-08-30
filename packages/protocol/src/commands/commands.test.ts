import { describe, expect, it } from "vitest";
import { z } from "zod";
import { commands, isCommandName, parseCommandInput, parseCommandOutput } from "./index";

// The recorded registry snapshot (B3 clusters 4+6): the 62 ids absorbed from
// the pre-B3 definitions table, plus patchset.readSpan (new in cluster 6 — the
// span-read contract, client asset risk 2), plus the 14 `ask.*` durable-asks
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
// archive, each persisted so it survives reload), plus session.mint (C21 — the New Chat
// front door: a row click mints a durable session AND claims its target in one act, the
// server path C12's cluster 7 was gated on and never came back for). A
// dropped or renamed command fails this loudly; a NEW command is added here deliberately,
// with its registry row — and with its row in docs/developing/reference/command-menu-exposure.md,
// which carries a menu-exposure verdict for every command in this list.
const ABSORBED_IDS = [
  "app.bootstrap",
  "ask.clearLineComment",
  "ask.dismissFinding",
  "ask.edit",
  "ask.quoteClose",
  "ask.quoteOpen",
  "ask.quoteReply",
  "ask.read",
  "ask.restore",
  "ask.restoreFinding",
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
  "session.cancelPreparation",
  "session.list",
  "session.mint",
  "session.rename",
  "session.retryPreparation",
  "session.roundEvents",
  "session.rounds",
  "session.setPinned",
  "session.transcript",
  "settings.completeWelcome",
  "settings.get",
  "settings.guidance",
  "settings.pinRepoValue",
  "settings.resetRepoValue",
  "settings.setAppearance",
  "settings.setCoachmarks",
  "settings.setGuidance",
  "settings.setKeybinding",
  "settings.setLastProject",
  "settings.setProjectValue",
  "settings.setRepoVisibility",
  "settings.setRoleAssignment",
  "settings.setThemePack",
] as const;

// The #465 v1 agent inventory, mapped by inspection (the session.* reads exist but stay
// unexposed; no navigate command exists yet). Mirrors AGENT_EXPOSED in index.ts so an
// exposure edit is deliberate.
// `repository.choose` + `project.discover` are the add-project prerequisites (the
// tool cannot fabricate a DiscoveryResult); `navigate` stays out (a client-locus row
// would force a host dispatch handler, and C11 shipped the menu without one). Kept sorted — the invariant
// test compares against the alphabetically sorted list of agent-exposed ids.
const AGENT_INVENTORY = [
  "ask.stage",
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

// The ⌘K command-menu inventory (#477, C11 exposure pass). Mirrors MENU_EXPOSED in
// index.ts so a menu exposure edit is deliberate; the row-by-row walk of all 104 commands
// lives in `docs/developing/reference/command-menu-exposure.md`. The menu invokes with no
// input and shows no result, so a row qualifies only if `{}` satisfies its schema, it is
// an action rather than a UI-driven read, its output is not the point, and it does not
// depend on live surface context. No command qualifies today: `github.disconnect` only
// acts on a Rennet-managed fallback, which Settings identifies before rendering it.
const MENU_INVENTORY: readonly string[] = [];

describe("command registry invariants (#465)", () => {
  it("matches the recorded command snapshot (settings.setRepoLocus demoted, #476)", () => {
    expect(Object.keys(commands).sort()).toEqual([...ABSORBED_IDS]);
    expect(ABSORBED_IDS).toHaveLength(104);
  });

  it("every row carries label, exposure, and locus with today's uniform values", () => {
    for (const [id, row] of Object.entries(commands)) {
      // #465: tool name = command id = menu label.
      expect(row.label, id).toBe(id);
      expect(row.locus, id).toBe("host");
      expect(row.exposure.ui, id).toBe(true);
      expect(row.exposure.commandMenu, id).toBe(MENU_INVENTORY.includes(id));
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

  it("command-menu exposure is exactly the menu inventory", () => {
    const menuIds = Object.entries(commands)
      .filter(([, row]) => row.exposure.commandMenu)
      .map(([id]) => id)
      .sort();
    expect(menuIds).toEqual([...MENU_INVENTORY]);
  });

  // The structural rule behind the inventory: the menu invokes a row with NO input, so a
  // menu-exposed command whose schema rejects `{}` would be a row that can only fail.
  it("every menu-exposed row is invocable with no input", () => {
    for (const [id, row] of Object.entries(commands)) {
      if (!row.exposure.commandMenu) continue;
      expect(row.args.safeParse({}).success, id).toBe(true);
    }
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

  it("keeps Context Map repository addresses provider-qualified and non-contradictory", () => {
    const address = {
      projectId: "project-1",
      repository: "acme/repo-b",
      forgeRepository: { forge: "gitlab", owner: "acme", name: "repo-b" },
    };
    expect(parseCommandInput("project.contextMap", address)).toEqual(address);
    expect(
      parseCommandOutput("project.contextMap", {
        status: "members",
        members: [
          {
            repository: "acme/repo-a",
            forgeRepository: { forge: "github", owner: "acme", name: "repo-a" },
          },
          {
            repository: "acme/repo-b",
            forgeRepository: address.forgeRepository,
          },
        ],
      }),
    ).toMatchObject({ status: "members" });
    expect(() =>
      parseCommandInput("project.contextMap", {
        ...address,
        forgeRepository: { forge: "gitlab", owner: "acme", name: "repo-a" },
      }),
    ).toThrow();
  });

  it("refuses an empty staged-ask anchor before it can become provenance-free body content", () => {
    expect(() =>
      parseCommandInput("ask.stage", {
        sessionId: "review-1",
        ask: { id: "ask-1", anchor: "", type: "comment", body: "missing provenance" },
      }),
    ).toThrow();
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

  it("preserves review-body-note identity and provenance across the publish wire", () => {
    const artifact = {
      opener: "I checked the retry policy and the anchored comment below.",
      comments: [],
      bodyNotes: [
        {
          id: "ask-overall",
          anchor: "Design · Retry policy",
          type: "comment" as const,
          body: "the policy matches its documented boundary",
        },
      ],
    };
    const post = {
      event: "COMMENT" as const,
      body: `${artifact.opener}\n\n## Review notes\n- the policy matches its documented boundary`,
      threads: [],
    };
    const composed = {
      status: "review" as const,
      artifact,
      post,
      ledger: [{ kind: "body-note" as const, path: "", detail: "woven into the body" }],
      payload: "canonical-review-bytes",
      destination: "acme/orbital#7",
      title: "acme/orbital#7",
      compositionId: "composition-1",
    };

    expect(parseCommandOutput("publish.compose", composed)).toEqual(composed);
    expect(
      parseCommandOutput("publish.compose", {
        status: "unavailable",
        reason: "The current review boards are still drafting.",
        retryable: true,
      }),
    ).toEqual({
      status: "unavailable",
      reason: "The current review boards are still drafting.",
      retryable: true,
    });
  });

  it("round-trips a provider-qualified PR target from compose into submit", () => {
    const target = {
      repo: { forge: "gitlab", owner: "acme", name: "widget" },
    };
    const composed = {
      status: "pr" as const,
      target,
      submission: {
        title: "Bind the forge destination",
        body: "The preview names the GitLab repository that receives this merge request.",
        base: "main",
        head: "feat/forge-target",
        draft: true,
      },
      payload: "canonical-pr-bytes",
      destination: "gitlab:acme/widget · feat/forge-target → main",
      title: "Bind the forge destination",
      compositionId: "composition-gitlab-1",
    };

    const parsed = parseCommandOutput("publish.compose", composed);
    expect(parsed).toEqual(composed);
    if (parsed.status !== "pr") throw new Error("Expected a composed pull request");

    const submit = {
      commandId: "00000000-0000-4000-8000-000000000001",
      reviewId: "review-gitlab-1",
      target: parsed.target,
      submission: parsed.submission,
      payload: parsed.payload,
      compositionId: parsed.compositionId,
    };
    expect(parseCommandInput("publish.submitPr", submit)).toEqual(submit);
    const { target: _composedTarget, ...legacyComposed } = composed;
    void _composedTarget;
    expect(parseCommandOutput("publish.compose", legacyComposed)).toEqual(legacyComposed);
    const { target: _submitTarget, ...legacySubmit } = submit;
    void _submitTarget;
    expect(parseCommandInput("publish.submitPr", legacySubmit)).toEqual(legacySubmit);
  });

  it("requires a byte-preserved opener and exact post with no caller target or verdict", () => {
    const artifact = {
      opener: "  I checked this exact review.  ",
      comments: [],
      bodyNotes: [],
    };
    const post = {
      event: "APPROVE" as const,
      body: `${artifact.opener}\n\n<!-- rennet:review:marker -->`,
      threads: [],
    };
    const input = {
      commandId: "00000000-0000-4000-8000-000000000001",
      reviewId: "review-1",
      artifact,
      post,
      payload: "canonical-review-bytes",
      compositionId: "composition-1",
      dryRun: true,
    };

    expect(parseCommandInput("publish.review", input)).toEqual(input);
    expect(
      parseCommandInput("publish.review", {
        ...input,
        verdict: "COMMENT",
        target: {
          repo: { forge: "github", owner: "wrong", name: "caller-target" },
          number: 99,
          forgeRef: "caller-node",
          headOid: "caller-head",
        },
      }),
    ).toEqual(input);
    expect(() =>
      parseCommandInput("publish.review", {
        ...input,
        artifact: { ...artifact, opener: " \n\t " },
      }),
    ).toThrow(/opener/i);
    expect(() =>
      parseCommandInput("publish.review", {
        ...input,
        post: { ...post, marker: "must-not-cross-the-wire" },
      }),
    ).toThrow();
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
