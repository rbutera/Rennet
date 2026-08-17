import { describe, expect, it, vi } from "vitest";
import type { RecentSurface } from "../nav/history";
import {
  buildCommands,
  catalogueDef,
  COMMAND_CATALOGUE,
  type CommandContext,
  chordFromEvent,
  effectiveKeybinding,
  filterCommands,
  findConflicts,
  formatKeybinding,
  fuzzyScore,
  matchKeybinding,
  menuTemplate,
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
    canvasReady: true,
    view: "canvases",
    deepReviewOn: true,
    overlayOn: false,
    scheme: "dark",
    angle: "decisions",
    zoomLevel: "cohort",
    back: vi.fn(),
    forward: vi.fn(),
    goToProjects: vi.fn(),
    goToProject: vi.fn(),
    goToDraft: vi.fn(),
    goToPaper: vi.fn(),
    goToRecent: vi.fn<(surface: RecentSurface) => void>(),
    openSettings: vi.fn(),
    showFiles: vi.fn(),
    showCanvases: vi.fn(),
    reviewDirectly: vi.fn(),
    chooseRepository: vi.fn(),
    retryReview: vi.fn(),
    regenerate: vi.fn(),
    toggleDeepReview: vi.fn(),
    goToAngle: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    toggleOverlay: vi.fn(),
    toggleScheme: vi.fn(),
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
    expect(ids).not.toContain("lens.decisions");
    expect(ids).not.toContain("review.retry");
  });

  it("offers the review + lens + zoom + appearance commands in the workspace", () => {
    // On the Canvases view at a mid zoom, lens decisions (the active angle) is the one
    // omitted; every OTHER lens plus both zoom directions and the toggles are present.
    const ids = buildCommands(context()).map((command) => command.id);
    expect(ids).toContain("nav.back");
    expect(ids).toContain("nav.files");
    expect(ids).toContain("review.retry");
    for (const angle of ["spec", "sequence", "noise", "flagged"]) {
      expect(ids).toContain(`lens.${angle}`);
    }
    expect(ids).not.toContain("lens.claims");
    expect(ids).toContain("zoom.in");
    expect(ids).toContain("zoom.out");
    expect(ids).toContain("view.scheme");
  });

  it("omits the inert command: the current view, the active lens, a clamped zoom", () => {
    // Current view (Canvases) → no "Show Canvases view"; the OTHER view is offered.
    const canvases = buildCommands(context({ view: "canvases" })).map((c) => c.id);
    expect(canvases).not.toContain("nav.canvases");
    expect(canvases).toContain("nav.files");
    // Current view (Files) → no "Show Files view"; the OTHER view is offered.
    const files = buildCommands(context({ view: "review" })).map((c) => c.id);
    expect(files).not.toContain("nav.files");
    expect(files).toContain("nav.canvases");

    // Active lens is omitted; the others remain.
    const onFlagged = buildCommands(context({ angle: "flagged" })).map((c) => c.id);
    expect(onFlagged).not.toContain("lens.flagged");
    expect(onFlagged).toContain("lens.decisions");

    // Zoom clamps: no "Zoom in" at diff, no "Zoom out" at the roll-up.
    const atDiff = buildCommands(context({ zoomLevel: "diff" })).map((c) => c.id);
    expect(atDiff).not.toContain("zoom.in");
    expect(atDiff).toContain("zoom.out");
    const atRollup = buildCommands(context({ zoomLevel: "rollup" })).map((c) => c.id);
    expect(atRollup).not.toContain("zoom.out");
    expect(atRollup).toContain("zoom.in");
  });

  it("drops the lens/zoom/appearance commands when the Canvases view is not live", () => {
    // A workspace on the Files view (or before the canvases load): the store-driven
    // commands cannot act, so they are absent — but the review commands remain.
    const ids = buildCommands(context({ canvasReady: false, view: "review" })).map((c) => c.id);
    expect(ids).toContain("review.retry");
    expect(ids).not.toContain("lens.decisions");
    expect(ids).not.toContain("zoom.in");
  });

  it("offers no Draft or Paper navigation for a retrospective review", () => {
    const ids = buildCommands(context({ retrospective: true })).map((command) => command.id);

    expect(ids).not.toContain("nav.draft");
    expect(ids).not.toContain("nav.paper");
  });

  it("runs the EXACT wrapped handler — a lens command calls goToAngle with its angle", () => {
    const ctx = context();
    const flagged = buildCommands(ctx).find((command) => command.id === "lens.flagged");
    flagged?.run();
    expect(ctx.goToAngle).toHaveBeenCalledWith("flagged");
    expect(ctx.goToAngle).toHaveBeenCalledTimes(1);
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

  it("labels the dual-model + scheme toggles from live state", () => {
    const on = buildCommands(context({ deepReviewOn: true })).find((c) => c.id === "review.dual");
    expect(on?.title).toMatch(/quick single-model/i);
    const off = buildCommands(context({ deepReviewOn: false })).find((c) => c.id === "review.dual");
    expect(off?.title).toMatch(/switch back on/i);
    const bright = buildCommands(context({ scheme: "dark" })).find((c) => c.id === "view.scheme");
    expect(bright?.title).toMatch(/bright room/i);
  });
});

describe("fuzzy filter", () => {
  it("keeps registry order for an empty query", () => {
    const commands = buildCommands(context());
    expect(filterCommands(commands, "  ")).toEqual(commands);
  });

  it("matches a subsequence and drops non-matches", () => {
    const commands = buildCommands(context());
    const titles = filterCommands(commands, "flag").map((command) => command.title);
    expect(titles.some((title) => /flagged/i.test(title))).toBe(true);
    expect(titles.every((title) => /zoom in/i.test(title))).toBe(false);
  });

  it("ranks a tighter (earlier, more contiguous) match ahead of a looser one", () => {
    // "zoom" hits "Zoom in" contiguously; it must outrank an incidental subsequence.
    const commands = buildCommands(context());
    const first = filterCommands(commands, "zoom")[0];
    expect(first?.title).toMatch(/^Zoom/);
  });

  it("scores a non-subsequence as null", () => {
    expect(fuzzyScore("Zoom in", "xyz")).toBeNull();
    expect(fuzzyScore("Zoom in", "zi")).not.toBeNull();
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
    expect(byId.get("zoom.in")?.keybinding).toBe("l");
    expect(byId.get("zoom.out")?.keybinding).toBe("h");
    // Every id is unique.
    expect(byId.size).toBe(COMMAND_CATALOGUE.length);
  });

  it("does not catalogue the dynamic recent/lens ids", () => {
    const ids = COMMAND_CATALOGUE.map((def) => def.id);
    expect(ids.some((id) => id.startsWith("recent."))).toBe(false);
    expect(ids.some((id) => id.startsWith("lens."))).toBe(false);
  });

  it("catalogueDef resolves a known id and misses an unknown one", () => {
    expect(catalogueDef("zoom.in")?.group).toBe("Zoom");
    expect(catalogueDef("lens.spec")).toBeUndefined();
  });
});

describe("normalizeChord + effectiveKeybinding", () => {
  it("parses a mod chord, a bare key, and rejects garbage", () => {
    expect(normalizeChord("mod+[")).toEqual({ mod: true, key: "[" });
    expect(normalizeChord("mod+K")).toEqual({ mod: true, key: "k" });
    expect(normalizeChord("l")).toEqual({ mod: false, key: "l" });
    expect(normalizeChord("")).toBeNull();
    expect(normalizeChord("mod+")).toBeNull();
  });

  it("overlays the override map: default, override, explicit unbind", () => {
    const def = { id: "nav.back", keybinding: "mod+[" };
    expect(effectiveKeybinding(def, {})).toBe("mod+[");
    expect(effectiveKeybinding(def, { "nav.back": "mod+e" })).toBe("mod+e");
    expect(effectiveKeybinding(def, { "nav.back": null })).toBeNull();
    // A command with no default and no override fires from no chord.
    expect(effectiveKeybinding({ id: "review.retry" }, {})).toBeNull();
    // A garbage stored token stays reportable but the command falls back to default.
    const garbage = effectiveKeybinding(def, { "nav.back": "%%%" });
    expect(garbage).toBe("%%%");
    expect(normalizeChord(garbage ?? "")).toEqual({ mod: false, key: "%%%" });
  });
});

describe("matchKeybinding", () => {
  const commands = [
    { id: "palette.toggle", keybinding: "mod+k" },
    { id: "nav.back", keybinding: "mod+[" },
    { id: "zoom.in", keybinding: "l" },
  ];

  it("matches a mod chord and a bare key, and misses when nothing binds", () => {
    expect(matchKeybinding(commands, chordFromEvent({ key: "k", metaKey: true, ctrlKey: false }))?.id).toBe(
      "palette.toggle",
    );
    expect(matchKeybinding(commands, chordFromEvent({ key: "l", metaKey: false, ctrlKey: false }))?.id).toBe(
      "zoom.in",
    );
    expect(
      matchKeybinding(commands, chordFromEvent({ key: "z", metaKey: false, ctrlKey: false })),
    ).toBeUndefined();
  });

  it("honours overrides: the new chord runs, the replaced chord does not", () => {
    const overrides = { "nav.back": "mod+e" };
    expect(
      matchKeybinding(commands, chordFromEvent({ key: "e", metaKey: true, ctrlKey: false }), overrides)?.id,
    ).toBe("nav.back");
    expect(
      matchKeybinding(commands, chordFromEvent({ key: "[", metaKey: true, ctrlKey: false }), overrides),
    ).toBeUndefined();
  });

  it("an unbound command matches no chord", () => {
    expect(
      matchKeybinding(commands, chordFromEvent({ key: "l", metaKey: false, ctrlKey: false }), {
        "zoom.in": null,
      }),
    ).toBeUndefined();
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

describe("menuTemplate", () => {
  it("labels/accelerators from the catalogue+overrides, disables out-of-context, excludes dynamic", () => {
    const sections = menuTemplate(context({ screen: "frontDoor", surfaceKind: "projects" }), {
      "nav.back": "mod+e",
    });
    const items = sections.flatMap((section) => section.items);
    const byId = new Map(items.map((item) => [item.id, item]));

    // No dynamic entries ever.
    expect(items.some((item) => item.id.startsWith("recent."))).toBe(false);
    expect(items.some((item) => item.id.startsWith("lens."))).toBe(false);

    // The override rides the accelerator (mod+ token preserved for MAIN to translate).
    expect(byId.get("nav.back")?.accelerator).toBe("mod+e");

    // On the front door, zoom.in is not offered → disabled, not absent.
    expect(byId.get("zoom.in")?.enabled).toBe(false);
    expect(byId.has("zoom.in")).toBe(true);

    // The palette toggle is always enabled.
    expect(byId.get("palette.toggle")?.enabled).toBe(true);

    // A command the front door DOES offer is enabled.
    expect(byId.get("nav.settings")?.enabled).toBe(true);
  });
})
