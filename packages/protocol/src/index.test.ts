import { describe, expect, it } from "vitest";
import {
  commands,
  daemonHostStatusSchema,
  dispositionSchema,
  forgeHostDetectionSchema,
  gitHubAuthStatusSchema,
  globalConfigSchema,
  harnessHostDetectionSchema,
  isCommandName,
  parseCommandInput,
  parseCommandOutput,
  projectDetailSchema,
  projectSchema,
  settingsLayerSchema,
  settingsProjectSchema,
  successorAccountSchema,
} from "./index";

describe("GitHub auth status", () => {
  it("carries the connected credential source and defaults a legacy payload to fallback", () => {
    for (const source of ["gh", "fallback"] as const) {
      expect(
        gitHubAuthStatusSchema.safeParse({
          state: "connected",
          source,
          login: "rbutera",
          scopes: ["repo", "workflow"],
        }).success,
      ).toBe(true);
    }

    expect(
      gitHubAuthStatusSchema.parse({
        state: "connected",
        login: "rbutera",
        scopes: ["repo", "workflow"],
      }),
    ).toEqual({
      state: "connected",
      source: "fallback",
      login: "rbutera",
      scopes: ["repo", "workflow"],
    });
  });

  it("keeps not-connected source-free and carries a known source on failures", () => {
    expect(
      gitHubAuthStatusSchema.parse({
        state: "not-connected",
        copy: "No GitHub credential is available.",
        source: "gh",
      }),
    ).toEqual({ state: "not-connected", copy: "No GitHub credential is available." });

    expect(
      gitHubAuthStatusSchema.safeParse({
        state: "token-invalid",
        copy: "The GitHub CLI token was rejected.",
        source: "gh",
      }).success,
    ).toBe(true);
    expect(
      gitHubAuthStatusSchema.safeParse({
        state: "insufficient-scope",
        copy: "The fallback token is missing repo scope.",
        scopes: [],
        source: "fallback",
      }).success,
    ).toBe(true);
    expect(
      gitHubAuthStatusSchema.safeParse({
        state: "network",
        copy: "GitHub is unreachable.",
      }).success,
    ).toBe(true);
    expect(
      gitHubAuthStatusSchema.safeParse({
        state: "token-invalid",
        copy: "Unknown credential owner.",
        source: "other",
      }).success,
    ).toBe(false);
  });

  it("carries a known credential source on a project-detail auth failure", () => {
    const detail = projectDetailSchema.parse({
      viewer: { login: "rbutera" },
      locals: [],
      prs: [],
      truncated: false,
      authUnavailable: "token-invalid",
      authUnavailableSource: "gh",
      authUnavailableCopy: "Run `gh auth status --hostname github.com`.",
    });
    expect(detail.authUnavailableSource).toBe("gh");
    expect(detail.authUnavailableCopy).toContain("gh auth status");

    expect(
      projectDetailSchema.safeParse({
        viewer: { login: "rbutera" },
        locals: [],
        prs: [],
        truncated: false,
        authUnavailable: "token-invalid",
        authUnavailableSource: "other",
      }).success,
    ).toBe(false);
  });
});

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

  it("device.registerPush requires a token XOR remove (#383 batch)", () => {
    // Set: a token, no remove.
    expect(
      parseCommandInput("device.registerPush", { pushToken: "t", platform: "ios" }),
    ).toMatchObject({ pushToken: "t" });
    // Clear: remove:true, no token.
    expect(
      parseCommandInput("device.registerPush", { platform: "ios", remove: true }),
    ).toMatchObject({ remove: true });
    // Neither (no-op) and both (contradictory) are rejected.
    expect(() => parseCommandInput("device.registerPush", { platform: "ios" })).toThrow();
    expect(() =>
      parseCommandInput("device.registerPush", { pushToken: "t", platform: "ios", remove: true }),
    ).toThrow();
  });

  it("attention.acknowledge requires a non-empty selector (#383 batch)", () => {
    expect(parseCommandInput("attention.acknowledge", { reviewId: "r1" })).toMatchObject({
      reviewId: "r1",
    });
    expect(() => parseCommandInput("attention.acknowledge", {})).toThrow();
  });
});

describe("review.load — reopen a persisted review by id (#324)", () => {
  it("app.bootstrap reports presence for its nullable latest review", () => {
    const output = commands["app.bootstrap"].output;
    expect(output.safeParse({ review: null, repositoryPresent: false }).success).toBe(true);
    expect(output.safeParse({ review: null }).success).toBe(false);
  });

  it("is a known command taking { commandId, reviewId }", () => {
    expect(isCommandName("review.load")).toBe(true);
    const parsed = parseCommandInput("review.load", {
      commandId: "92e8f263-a7ee-4fd8-9c11-40c9f6682661",
      reviewId: "review-7",
    });
    expect(parsed).toEqual({
      commandId: "92e8f263-a7ee-4fd8-9c11-40c9f6682661",
      reviewId: "review-7",
    });
  });

  it("rejects an empty reviewId", () => {
    expect(() =>
      parseCommandInput("review.load", {
        commandId: "92e8f263-a7ee-4fd8-9c11-40c9f6682661",
        reviewId: "",
      }),
    ).toThrow();
  });

  it("outputs { review, repositoryPresent }", () => {
    const output = commands["review.load"].output;
    // repositoryPresent is required, boolean; review is the review schema.
    expect(output.safeParse({ review: null, repositoryPresent: true }).success).toBe(false);
    // A minimal valid review shape is exercised elsewhere; here we prove the boolean is required.
    expect(
      output.safeParse({
        review: {
          id: "r",
          repository: {
            id: "repo",
            root: "/repo",
            commonDir: "/repo/.git",
            baseRef: "main",
            baseOid: "b",
            headOid: "h",
          },
          patchsets: [],
          activePatchsetId: "",
          status: "active",
          dispositions: [],
        },
      }).success,
    ).toBe(false);
  });
});

describe("span-grained disposition anchor schema (issue #78)", () => {
  const base = { type: "comment", body: "" } as const;

  it("accepts a path-grained anchor", () => {
    const result = dispositionSchema.safeParse({
      ...base,
      anchor: { path: "a.ts", contentDigest: "d" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a full span anchor", () => {
    const result = dispositionSchema.safeParse({
      ...base,
      anchor: {
        path: "a.ts",
        contentDigest: "d",
        span: { startLine: 3, endLine: 5 },
        side: "additions",
        spanDigest: "sd",
      },
    });
    expect(result.success).toBe(true);
  });

  // Reddening: drop the all-or-none refine → this partial-anchor test reddens.
  it("rejects a partial span anchor (span without side/spanDigest)", () => {
    const result = dispositionSchema.safeParse({
      ...base,
      anchor: { path: "a.ts", contentDigest: "d", span: { startLine: 3 } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a span with endLine < startLine", () => {
    const result = dispositionSchema.safeParse({
      ...base,
      anchor: {
        path: "a.ts",
        contentDigest: "d",
        span: { startLine: 5, endLine: 3 },
        side: "context",
        spanDigest: "sd",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("ordering is agent-owned: no user-approval command exists (issue #9)", () => {
  it("has no command that approves an ordering (structural, not a prompt)", () => {
    // The user does NOT approve the comprehension ordering (Q2, 2026-08-06).
    // "The human does not approve ordering" is a property of the wiring: the
    // command registry simply contains no such operation.
    expect(isCommandName("ordering.approve")).toBe(false);
    const orderingApproval = Object.keys(commands).filter(
      (name) => /order/i.test(name) && /(approve|accept|confirm|dispose)/i.test(name),
    );
    expect(orderingApproval).toEqual([]);
  });
});

describe("successor account schema — hunk grain + handoff attribution round-trip (#73 wave 3)", () => {
  it("round-trips beyondAskHunks and per-ask handoffTask through the IPC schema", () => {
    const account = {
      asks: [
        {
          path: "a.ts",
          span: { startLine: 10, endLine: 11 },
          side: "additions" as const,
          type: "request-change" as const,
          summary: "Fix the loop bound",
          status: "partially-addressed" as const,
          handoffTask: { index: 2, title: "Tighten the parser" },
        },
      ],
      beyondAsks: ["d.ts"],
      beyondAskHunks: [
        {
          path: "a.ts",
          span: { startLine: 40, endLine: 41 },
          bucket: "asked-file" as const,
          excerpt: "+d",
        },
        {
          path: "d.ts",
          span: { startLine: 3 },
          side: "deletions" as const,
          bucket: "unasked-file" as const,
          excerpt: "-gone",
        },
      ],
    };
    const parsed = successorAccountSchema.parse(account);
    expect(parsed).toEqual(account);
  });

  it("still parses a LEGACY account with no hunk-grain fields (additive-optional)", () => {
    const legacy = {
      asks: [{ path: "a.ts", type: "comment" as const, summary: "", status: "untouched" as const }],
      beyondAsks: ["d.ts"],
    };
    const parsed = successorAccountSchema.parse(legacy);
    expect(parsed.beyondAskHunks).toBeUndefined();
    expect(parsed.asks[0]?.handoffTask).toBeUndefined();
  });
});

describe("settings v1 — registry ladder wire shapes (#28)", () => {
  const provenance = {
    layer: "detected" as const,
    contributions: [
      { layer: "builtin" as const, value: "host", effective: false },
      { layer: "detected" as const, value: "WSL · Ubuntu", effective: true },
    ],
  };
  const repoProvenance = {
    layer: "repo" as const,
    contributions: [{ layer: "repo" as const, value: "local", effective: true }],
  };
  const project = {
    projectId: "p1",
    name: "orbital",
    repoPath: "/orbital",
    visibility: "local" as const,
    visibilityProvenance: repoProvenance,
    promoted: false,
    promotedProvenance: repoProvenance,
    locus: { kind: "wsl" as const, distro: "Ubuntu" },
    locusProvenance: provenance,
    configMalformed: false,
  };

  it("settingsLayerSchema accepts the new `detected` rung", () => {
    expect(settingsLayerSchema.parse("detected")).toBe("detected");
  });

  it("settingsProjectSchema normalizes locusProvenance to the detected fact (#476)", () => {
    // Execution locus is a detected fact now — provenance is always `detected`.
    expect(settingsProjectSchema.parse(project).locusProvenance.layer).toBe("detected");
    const withoutProvenance: Record<string, unknown> = { ...project };
    delete withoutProvenance.locusProvenance;
    expect(settingsProjectSchema.parse(withoutProvenance).locusProvenance).toEqual({
      layer: "detected",
      contributions: [{ layer: "detected", value: "WSL · Ubuntu", effective: true }],
    });
  });

  it("resetRepoValue / pinRepoValue accept only `visibility` — locus is no longer a repo key (#476)", () => {
    for (const command of ["settings.resetRepoValue", "settings.pinRepoValue"] as const) {
      expect(
        parseCommandInput(command, { projectId: "p1", repoPath: "/o", key: "visibility" }).key,
      ).toBe("visibility");
      // Locus was demoted to a detected fact — it is no longer a reset/pin-able repo key.
      expect(() =>
        parseCommandInput(command, { projectId: "p1", repoPath: "/o", key: "locus" }),
      ).toThrow();
      // A non-repo-scoped key (e.g. scheme) is rejected too — reset/pin are repo-scoped.
      expect(() =>
        parseCommandInput(command, { projectId: "p1", repoPath: "/o", key: "scheme" }),
      ).toThrow();
    }
  });

  it("reset/pin outcome parses with the re-resolved row", () => {
    const outcome = parseCommandOutput("settings.resetRepoValue", {
      status: "applied",
      key: "visibility",
      project,
    });
    expect(outcome.status).toBe("applied");
    expect(outcome.project?.repoPath).toBe("/orbital");
    // A refused/unresolved write carries a null row (nothing was written).
    expect(
      parseCommandOutput("settings.pinRepoValue", {
        status: "malformed",
        key: "visibility",
        project: null,
      }).project,
    ).toBeNull();
  });

  it("setAppearance accepts a null scheme (reset to the builtin) additively", () => {
    expect(parseCommandInput("settings.setAppearance", { scheme: null }).scheme).toBeNull();
    expect(parseCommandInput("settings.setAppearance", { scheme: "light" }).scheme).toBe("light");
  });

  it("globalConfig parses keybindings additively — an old config without the field still parses (#44)", () => {
    const withOverrides = globalConfigSchema.parse({
      version: 1,
      keybindings: { "nav.back": "mod+e", "zoom.in": null },
    });
    expect(withOverrides.keybindings).toEqual({ "nav.back": "mod+e", "zoom.in": null });
    // Additive control: a config without the field parses unchanged.
    const legacy = globalConfigSchema.parse({ version: 1 });
    expect(legacy.keybindings).toBeUndefined();
  });

  it("setKeybinding: a string sets, null unbinds, omitted resets (#44)", () => {
    expect(
      parseCommandInput("settings.setKeybinding", { id: "nav.back", keybinding: "mod+e" }),
    ).toEqual({ id: "nav.back", keybinding: "mod+e" });
    expect(
      parseCommandInput("settings.setKeybinding", { id: "nav.back", keybinding: null }).keybinding,
    ).toBeNull();
    expect(
      parseCommandInput("settings.setKeybinding", { id: "nav.back" }).keybinding,
    ).toBeUndefined();
    expect(
      parseCommandOutput("settings.setKeybinding", { keybindings: { "nav.back": "mod+e" } })
        .keybindings,
    ).toEqual({ "nav.back": "mod+e" });
  });
});

describe("fs.listDir — source directory browser contract", () => {
  it("accepts an optional path and returns dir entries", () => {
    const input = commands["fs.listDir"].args.parse({});
    expect(input).toEqual({});
    const out = commands["fs.listDir"].output.parse({
      result: {
        path: "/home/rai",
        home: "/home/rai",
        parent: "/home",
        entries: [{ name: "dev", path: "/home/rai/dev", isRepo: false, unreadable: false }],
      },
    });
    expect(out.result.entries[0]?.name).toBe("dev");
  });
});

describe("projectSchema — source defaults to local for pre-existing rows", () => {
  it("projectSchema defaults missing source to local and accepts wsl/remote", () => {
    const legacy = projectSchema.parse({
      id: "1",
      name: "x",
      path: "/p",
      kind: "repo",
      repoCount: 1,
      branchCount: 0,
      primaryBranch: "main",
      openPath: "/p",
      addedAt: new Date().toISOString(),
    });
    expect(legacy.source).toBe("local");
    expect(projectSchema.parse({ ...legacy, source: "wsl:Ubuntu" }).source).toBe("wsl:Ubuntu");
  });
});

// #681 / C14 D3. `unavailable` exists to say something `failed` cannot: nothing was
// attempted, and here is what resolved instead. A bare `{status:"unavailable",edges:[]}`
// says neither, and the Spec view could only render it as an unexplained blank — so the
// wire refuses it rather than the UI inventing an explanation for it.
describe("openspec.coverage — an unavailable result must account for itself", () => {
  it("refuses an unavailable coverage result with no reason", () => {
    expect(() =>
      parseCommandOutput("openspec.coverage", { status: "unavailable", edges: [] }),
    ).toThrow();
    // An empty reason is the same absence wearing a string.
    expect(() =>
      parseCommandOutput("openspec.coverage", { status: "unavailable", edges: [], reason: "" }),
    ).toThrow();
  });

  it("accepts an unavailable result carrying its reason and what did resolve", () => {
    expect(
      parseCommandOutput("openspec.coverage", {
        status: "unavailable",
        edges: [],
        harness: { id: "codex", version: "0.146.0" },
        reason: "Requirement coverage needs a Claude Code seat; this repository resolved Codex.",
      }),
    ).toMatchObject({ status: "unavailable", harness: { id: "codex" } });
  });

  it("still parses coverage persisted before unavailable existed", () => {
    // The refinement is scoped to `unavailable`, so the two states that predate it keep
    // parsing WITHOUT a reason — an added state must not invalidate stored history.
    for (const status of ["ok", "failed"] as const) {
      expect(parseCommandOutput("openspec.coverage", { status, edges: [] })).toEqual({
        status,
        edges: [],
      });
    }
    expect(parseCommandOutput("openspec.coverage", null)).toBeNull();
  });
});

// C17 review finding 8 — the per-host detection shapes are DISCRIMINATED UNIONS, so the
// contradictory states are not merely discouraged, they are unrepresentable. These schemas
// are unreleased, which is exactly when this is cheap to encode.
describe("per-host detection wire shapes reject contradictory states (C17)", () => {
  it("an unreachable daemon status cannot carry a running version ACROSS the boundary", () => {
    // The union has no `version` on the unreachable arm, so the field is not merely
    // discouraged — it does not survive parsing, and nothing downstream can read it. (The arms
    // are not `.strict()`: unknown keys are STRIPPED, not rejected, because every field on this
    // protocol is additive-optional and a newer engine must stay parseable by an older client.)
    const parsed = daemonHostStatusSchema.parse({
      source: "local",
      reachable: false,
      version: "1.2.3",
    });
    expect(parsed).toEqual({ source: "local", reachable: false });
    expect(parsed).not.toHaveProperty("version");
    // …and the two legal shapes parse.
    expect(
      daemonHostStatusSchema.safeParse({ source: "local", reachable: true, version: "1.2.3" })
        .success,
    ).toBe(true);
    expect(
      daemonHostStatusSchema.safeParse({
        source: "local",
        reachable: false,
        lastSeenVersion: "1.2.3",
      }).success,
    ).toBe(true);
  });

  it("an UNASKED host cannot carry detected rows — agents or forge CLIs", () => {
    const harnessRow = { id: "claude", version: "2.1.0", enabled: true };
    expect(
      harnessHostDetectionSchema.safeParse({
        source: "wsl:Ubuntu",
        asked: false,
        detected: [harnessRow],
      }).success,
    ).toBe(false);
    const forgeRow = {
      id: "github",
      version: "2.89.0",
      status: "available",
      detail: "Authenticated with GitHub through the `gh` CLI.",
    };
    expect(
      forgeHostDetectionSchema.safeParse({
        source: "wsl:Ubuntu",
        asked: false,
        detected: [forgeRow],
      }).success,
    ).toBe(false);

    // Asked-with-rows and unasked-with-none are the two legal shapes, and a DECISION
    // (the forge ruling) is still valid on a host that could not be asked.
    expect(
      harnessHostDetectionSchema.safeParse({
        source: "local",
        asked: true,
        detected: [harnessRow],
      }).success,
    ).toBe(true);
    expect(
      harnessHostDetectionSchema.safeParse({
        source: "wsl:Ubuntu",
        asked: false,
        detected: [],
        disabledForges: ["github"],
      }).success,
    ).toBe(true);
    expect(
      forgeHostDetectionSchema.safeParse({ source: "local", asked: true, detected: [] }).success,
    ).toBe(true);
  });
});
