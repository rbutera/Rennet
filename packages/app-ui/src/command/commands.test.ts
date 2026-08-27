import { describe, expect, it, vi } from "vitest";
import type { RecentSurface } from "../nav/history";
import {
  buildCommands,
  COMMAND_CATALOGUE,
  type CommandContext,
  catalogueDef,
  chordFromEvent,
  effectiveKeybinding,
  findConflicts,
  formatKeybinding,
  matchKeybinding,
  normalizeChord,
  type Screen,
} from "./commands";

// A context whose handlers are all spies, so a test can assert a command runs the
// EXACT app handler it wraps (never a reimplementation). Overrides tune the screen
// and presentation flags per case.
function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    screen: "workspace" as Screen,
    surfaceKind: "review",
    currentSurface: { kind: "review", reviewId: "review-current" },
    recents: [],
    surfaceLabels: { project: () => undefined, review: () => undefined },
    canBack: true,
    canForward: false,
    canGoToProject: true,
    retrospective: false,
    back: vi.fn(),
    forward: vi.fn(),
    goToProjects: vi.fn(),
    goToProject: vi.fn(),
    goToRecent: vi.fn<(surface: RecentSurface) => void>(),
    openSettings: vi.fn(),
    reviewDirectly: vi.fn(),
    chooseRepository: vi.fn(),
    ...overrides,
  };
}

describe("buildCommands — context-aware registry", () => {
  it("offers no review/lens commands when the front door is showing", () => {
    const commands = buildCommands(
      context({
        screen: "frontDoor",
        surfaceKind: "projects",
        canBack: false,
        canGoToProject: false,
      }),
    );
    const ids = commands.map((command) => command.id);
    expect(ids).toEqual(["nav.settings", "nav.reviewDirectly"]);
  });

  it("offers navigation + settings on an open review (the canvas surface is stubbed, B2)", () => {
    // The review command surface (files/canvases/retry/regenerate/dual/lens/zoom/scheme)
    // was deleted in the delete-first cutover (#489); a review-family surface now offers
    // only navigation, settings, and recents until Track C rebuilds it.
    const ids = buildCommands(context()).map((command) => command.id);
    expect(ids).toContain("nav.back");
    expect(ids).toContain("nav.projects");
    expect(ids).toContain("nav.settings");
    expect(ids).not.toContain("nav.files");
    expect(ids).not.toContain("review.retry");
    expect(ids.some((id) => id.startsWith("lens."))).toBe(false);
    expect(ids).not.toContain("zoom.in");
    expect(ids).not.toContain("view.scheme");
  });

  it("runs the same back handler exposed by the navigation controls", () => {
    const ctx = context();
    buildCommands(ctx)
      .find((command) => command.id === "nav.back")
      ?.run();
    expect(ctx.back).toHaveBeenCalledTimes(1);
  });

  it("lists resolved recents except the current surface and runs the injected navigation", () => {
    const recentProject: RecentSurface = { kind: "project", projectId: "project-1" };
    const ctx = context({
      currentSurface: { kind: "projects" },
      recents: [{ kind: "projects" }, recentProject],
      surfaceLabels: {
        project: (id) => (id === "project-1" ? "Rennet" : undefined),
        review: () => undefined,
      },
    });

    const recents = buildCommands(ctx).filter((command) => command.group === "Recent");
    expect(recents.map((command) => command.title)).toEqual(["Rennet"]);
    recents[0]?.run();
    expect(ctx.goToRecent).toHaveBeenCalledWith(recentProject);
  });

  it("opens Settings through the injected overlay handler", () => {
    const ctx = context();
    buildCommands(ctx)
      .find((command) => command.id === "nav.settings")
      ?.run();
    expect(ctx.openSettings).toHaveBeenCalledTimes(1);
  });
});

describe("formatKeybinding (add-windows-support)", () => {
  it("renders a mod+ chord as ⌘ on macOS and Ctrl on Windows/Linux", () => {
    expect(formatKeybinding("mod+[", true)).toBe("⌘[");
    expect(formatKeybinding("mod+[", false)).toBe("Ctrl+[");
    expect(formatKeybinding("mod+K", false)).toBe("Ctrl+K");
  });

  it("passes a bare key through unchanged", () => {
    expect(formatKeybinding("l", true)).toBe("l");
    expect(formatKeybinding("l", false)).toBe("l");
  });
});

describe("command catalogue (single source)", () => {
  it("carries palette.toggle + the bound commands with unique ids and default chords", () => {
    const byId = new Map(COMMAND_CATALOGUE.map((def) => [def.id, def]));
    expect(byId.get("palette.toggle")?.keybinding).toBe("mod+k");
    expect(byId.get("nav.back")?.keybinding).toBe("mod+[");
    expect(byId.get("nav.forward")?.keybinding).toBe("mod+]");
    expect(byId.get("nav.settings")?.keybinding).toBe("mod+,");
    // Every id is unique.
    expect(byId.size).toBe(COMMAND_CATALOGUE.length);
  });

  it("does not catalogue the dynamic recent/lens ids", () => {
    const ids = COMMAND_CATALOGUE.map((def) => def.id);
    expect(ids.some((id) => id.startsWith("recent."))).toBe(false);
    expect(ids.some((id) => id.startsWith("lens."))).toBe(false);
  });

  it("catalogueDef resolves a known id and misses an unknown one", () => {
    expect(catalogueDef("nav.settings")?.group).toBe("Navigate");
    expect(catalogueDef("lens.spec")).toBeUndefined();
  });

  it("pins the full id/title/group/keybinding matrix across catalogue and palette contexts", () => {
    const expected = [
      ["palette.toggle", "Toggle command palette", "General", "mod+k"],
      ["nav.back", "Back", "Navigate", "mod+["],
      ["nav.forward", "Forward", "Navigate", "mod+]"],
      ["nav.projects", "Back to projects", "Navigate", null],
      ["nav.project", "Go to project…", "Navigate", null],
      ["nav.settings", "Open Settings", "Navigate", "mod+,"],
      ["nav.openReview", "Open review…", "Navigate", null],
      ["nav.reviewDirectly", "Review directly", "Navigate", null],
      ["door.choose", "Choose a repository", "Start", null],
    ];
    const workspace = context();
    const matrix = COMMAND_CATALOGUE.map((def) => [
      def.id,
      typeof def.title === "function" ? def.title(workspace) : def.title,
      def.group,
      def.keybinding ?? null,
    ]);
    expect(matrix).toEqual(expected);

    const contexts = [
      workspace,
      context({ screen: "frontDoor", surfaceKind: "projects" }),
      context({ screen: "directEntry", surfaceKind: "projects" }),
    ];
    // Every command the palette builds agrees with its catalogue def (the single source):
    // same title (resolved for this context), group, and default keybinding.
    for (const ctx of contexts) {
      for (const command of buildCommands(ctx)) {
        const def = catalogueDef(command.id);
        if (!def) continue;
        const label = typeof def.title === "function" ? def.title(ctx) : def.title;
        expect([command.title, command.group, command.keybinding ?? null]).toEqual([
          label,
          def.group,
          def.keybinding ?? null,
        ]);
      }
    }
  });
});

describe("normalizeChord + effectiveKeybinding", () => {
  it("parses a mod chord, a bare key, and rejects garbage", () => {
    expect(normalizeChord("mod+[")).toEqual({ mod: true, key: "[" });
    expect(normalizeChord("mod+K")).toEqual({ mod: true, key: "k" });
    expect(normalizeChord("l")).toEqual({ mod: false, key: "l" });
    expect(normalizeChord("")).toBeNull();
    expect(normalizeChord("mod+")).toBeNull();
    expect(normalizeChord("%%%")).toBeNull();
  });

  it("overlays the override map: default, override, explicit unbind", () => {
    const def = { id: "nav.back", keybinding: "mod+[" };
    expect(effectiveKeybinding(def, {})).toBe("mod+[");
    expect(effectiveKeybinding(def, { "nav.back": "mod+e" })).toBe("mod+e");
    expect(effectiveKeybinding(def, { "nav.back": null })).toBeNull();
    // A command with no default and no override fires from no chord.
    expect(effectiveKeybinding({ id: "review.retry" }, {})).toBeNull();
    // A garbage stored token stays in the override map for Settings to report, while
    // the effective binding falls back to the catalogue default.
    expect(effectiveKeybinding(def, { "nav.back": "mod+" })).toBe("mod+[");
  });
});

describe("matchKeybinding", () => {
  const commands = [
    { id: "palette.toggle", keybinding: "mod+k" },
    { id: "nav.back", keybinding: "mod+[" },
    { id: "zoom.in", keybinding: "l" },
  ];

  it("matches a mod chord and a bare key, and misses when nothing binds", () => {
    expect(
      matchKeybinding(commands, chordFromEvent({ key: "k", metaKey: true, ctrlKey: false }, true))
        ?.id,
    ).toBe("palette.toggle");
    expect(
      matchKeybinding(commands, chordFromEvent({ key: "l", metaKey: false, ctrlKey: false }))?.id,
    ).toBe("zoom.in");
    expect(
      matchKeybinding(commands, chordFromEvent({ key: "z", metaKey: false, ctrlKey: false })),
    ).toBeUndefined();
  });

  it("honours overrides: the new chord runs, the replaced chord does not", () => {
    const overrides = { "nav.back": "mod+e" };
    expect(
      matchKeybinding(
        commands,
        chordFromEvent({ key: "e", metaKey: true, ctrlKey: false }, true),
        overrides,
      )?.id,
    ).toBe("nav.back");
    expect(
      matchKeybinding(
        commands,
        chordFromEvent({ key: "[", metaKey: true, ctrlKey: false }, true),
        overrides,
      ),
    ).toBeUndefined();
  });

  it("an unbound command matches no chord", () => {
    expect(
      matchKeybinding(commands, chordFromEvent({ key: "l", metaKey: false, ctrlKey: false }), {
        "zoom.in": null,
      }),
    ).toBeUndefined();
  });

  it("resolves a collision to the first command in registry order", () => {
    const colliding = [
      { id: "nav.back", keybinding: "mod+[" },
      { id: "nav.forward", keybinding: "mod+[" },
    ];
    expect(
      matchKeybinding(colliding, chordFromEvent({ key: "[", metaKey: true, ctrlKey: false }, true))
        ?.id,
    ).toBe("nav.back");
  });

  it("requires the platform-primary modifier and rejects Shift/Alt combinations", () => {
    const toggle = [{ id: "palette.toggle", keybinding: "mod+k" }];
    expect(
      matchKeybinding(toggle, chordFromEvent({ key: "k", metaKey: false, ctrlKey: true }, true)),
    ).toBeUndefined();
    expect(
      matchKeybinding(
        toggle,
        chordFromEvent(
          { key: "K", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false },
          true,
        ),
      ),
    ).toBeUndefined();
  });

  it("normalizes uppercase event keys and bracket symbols without losing them", () => {
    expect(
      matchKeybinding(
        [{ id: "palette.toggle", keybinding: "mod+k" }],
        chordFromEvent({ key: "K", metaKey: true, ctrlKey: false }, true),
      )?.id,
    ).toBe("palette.toggle");
    expect(
      matchKeybinding(
        [{ id: "nav.back", keybinding: "mod+[" }],
        chordFromEvent({ key: "[", metaKey: true, ctrlKey: false }, true),
      )?.id,
    ).toBe("nav.back");
  });
});

describe("findConflicts", () => {
  it("reports two commands on one effective chord and stays silent otherwise", () => {
    const distinct = findConflicts([
      { id: "nav.back", keybinding: "mod+[" },
      { id: "nav.forward", keybinding: "mod+]" },
    ]);
    expect(distinct.size).toBe(0);

    const collide = findConflicts([
      { id: "nav.back", keybinding: "mod+[" },
      { id: "zoom.in", keybinding: "mod+[" },
    ]);
    expect(collide.get("mod+[")).toEqual(["nav.back", "zoom.in"]);
  });

  it("detects a collision an override CREATES", () => {
    const conflicts = findConflicts(
      [
        { id: "nav.back", keybinding: "mod+[" },
        { id: "zoom.in", keybinding: "l" },
      ],
      { "zoom.in": "mod+[" },
    );
    expect(conflicts.get("mod+[")).toEqual(["nav.back", "zoom.in"]);
  });
});
