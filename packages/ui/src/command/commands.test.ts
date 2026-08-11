import { describe, expect, it, vi } from "vitest";
import {
  buildCommands,
  type CommandContext,
  filterCommands,
  fuzzyScore,
  type Screen,
} from "./commands";

// A context whose handlers are all spies, so a test can assert a command runs the
// EXACT app handler it wraps (never a reimplementation). Overrides tune the screen
// and presentation flags per case.
function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    screen: "workspace" as Screen,
    canvasReady: true,
    view: "canvases",
    deepReviewOn: true,
    overlayOn: false,
    scheme: "dark",
    angle: "decisions",
    backToProjects: vi.fn(),
    backToProjectList: vi.fn(),
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
    const commands = buildCommands(context({ screen: "frontDoor" }));
    const ids = commands.map((command) => command.id);
    // The one front-door action, and nothing that needs an open review.
    expect(ids).toEqual(["door.direct"]);
    expect(ids).not.toContain("lens.decisions");
    expect(ids).not.toContain("review.retry");
  });

  it("offers the review + lens + zoom + appearance commands in the workspace", () => {
    const ids = buildCommands(context()).map((command) => command.id);
    expect(ids).toContain("nav.files");
    expect(ids).toContain("review.retry");
    // All six lenses.
    for (const angle of ["spec", "sequence", "decisions", "claims", "noise", "flagged"]) {
      expect(ids).toContain(`lens.${angle}`);
    }
    expect(ids).toContain("zoom.in");
    expect(ids).toContain("view.scheme");
  });

  it("drops the lens/zoom/appearance commands when the Canvases view is not live", () => {
    // A workspace on the Files view (or before the canvases load): the store-driven
    // commands cannot act, so they are absent — but the review commands remain.
    const ids = buildCommands(context({ canvasReady: false, view: "review" })).map((c) => c.id);
    expect(ids).toContain("review.retry");
    expect(ids).not.toContain("lens.decisions");
    expect(ids).not.toContain("zoom.in");
  });

  it("runs the EXACT wrapped handler — a lens command calls goToAngle with its angle", () => {
    const ctx = context();
    const flagged = buildCommands(ctx).find((command) => command.id === "lens.flagged");
    flagged?.run();
    expect(ctx.goToAngle).toHaveBeenCalledWith("flagged");
    expect(ctx.goToAngle).toHaveBeenCalledTimes(1);
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
