import type { CanvasAngle } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import type { ZoomLevel } from "../canvas/logic";
import type { Surface } from "../nav/history";

// ─────────────────────────────────────────────────────────────────────────────
// The command registry (wireframes screen 16: "⌘K, every action a named
// remappable command").
//
// A command is a NAMED wrapper over an action the app ALREADY performs — it never
// invents a new behaviour, it just gives an existing handler a title, an optional
// keybinding, and a home in one searchable list. `buildCommands` is a PURE function
// of the current context (which screen is showing, what handlers are live), so the
// exact set that surfaces is context-aware — review-only commands are simply absent
// when no review is open — and the whole thing is unit-testable without a DOM.
//
// Keybindings live HERE, in the registry, not hardcoded at each call site. That is
// the "remappable" structure the wireframe asks for: a later remap UI edits these
// fields, and a later key-dispatch routes through them. Today ⌘K plus history's
// ⌘[ / ⌘] are wired globally (in app.tsx); the diff-canvas keys (`l h`) still live
// in the workspace's own keydown and are declared here as their canonical home.
// ─────────────────────────────────────────────────────────────────────────────

/** A named, runnable action. `run` invokes the SAME handler the UI's own control does. */
export interface Command {
  /** Stable id (also the registry key). */
  id: string;
  /** Human title shown in the palette and matched by the fuzzy filter. */
  title: string;
  /** The section the command groups under in the palette. */
  group: string;
  /**
   * The declared keybinding label (e.g. "⌘K", "l"). The registry is its canonical
   * home so it is remappable; optional because most palette entries have no default.
   */
  keybinding?: string;
  /** Perform the wrapped action. */
  run(): void;
}

/** Which top-level surface is showing — decides which commands are live. */
export type Screen = "projectDetail" | "frontDoor" | "directEntry" | "workspace";

/**
 * Everything `buildCommands` needs: the current screen + presentation flags (to
 * label toggles and gate the diff-canvas commands), and the real handlers each
 * command wraps. The handlers are the app's own — a command is a thin named shell
 * over them, never a reimplementation.
 */
export interface CommandContext {
  screen: Screen;
  surfaceKind: Surface["kind"];
  canBack: boolean;
  canForward: boolean;
  canGoToProject: boolean;
  retrospective: boolean;
  /** The Canvases view is showing a loaded review, so the lens/zoom/scheme act live. */
  canvasReady: boolean;
  view: "review" | "canvases";
  deepReviewOn: boolean;
  overlayOn: boolean;
  scheme: "dark" | "light";
  angle: CanvasAngle;
  /** The live zoom altitude — used to omit the zoom command that would clamp (no-op). */
  zoomLevel: ZoomLevel;

  // Navigation + review actions (app.tsx handlers).
  back(): void;
  forward(): void;
  goToProjects(): void;
  goToProject(): void;
  goToDraft(): void;
  goToPaper(): void;
  openSettings(): void;
  showFiles(): void;
  showCanvases(): void;
  reviewDirectly(): void;
  chooseRepository(): void;
  retryReview(): void;
  regenerate(): void;
  toggleDeepReview(): void;

  // Canvas view-store actions (the same methods the lens switcher + zoom bar call).
  goToAngle(angle: CanvasAngle): void;
  zoomIn(): void;
  zoomOut(): void;
  toggleOverlay(): void;
  toggleScheme(): void;
}

/** The lens titles, in the canonical angle order. */
const ANGLE_LABELS: Partial<Record<CanvasAngle, string>> = {
  spec: "Spec",
  sequence: "Sequence",
  decisions: "Decisions",
  noise: "Noise",
  flagged: "Flagged",
};

/**
 * Assemble the commands live for the given context. Only enabled commands are
 * returned — a command absent from the list is one that cannot act right now (no
 * review open, wrong view), which is exactly the "review-only commands disabled/
 * absent when no review is open" the palette wants. Order here is the palette's
 * order; the fuzzy filter re-ranks by match, an empty query keeps this order.
 */
export function buildCommands(ctx: CommandContext): Command[] {
  const commands: Command[] = [];

  if (ctx.canBack) {
    commands.push({
      id: "nav.back",
      title: "Back",
      group: "Navigate",
      keybinding: "⌘[",
      run: ctx.back,
    });
  }
  if (ctx.canForward) {
    commands.push({
      id: "nav.forward",
      title: "Forward",
      group: "Navigate",
      keybinding: "⌘]",
      run: ctx.forward,
    });
  }
  if (ctx.surfaceKind !== "projects") {
    commands.push({
      id: "nav.projects",
      title: "Back to projects",
      group: "Navigate",
      run: ctx.goToProjects,
    });
  }
  if (ctx.canGoToProject && ctx.surfaceKind !== "project") {
    commands.push({
      id: "nav.project",
      title: "Go to project…",
      group: "Navigate",
      run: ctx.goToProject,
    });
  }
  if (
    !ctx.retrospective &&
    (ctx.surfaceKind === "review" || ctx.surfaceKind === "draft" || ctx.surfaceKind === "paper")
  ) {
    if (ctx.surfaceKind !== "draft") {
      commands.push({
        id: "nav.draft",
        title: "Go to Draft",
        group: "Navigate",
        run: ctx.goToDraft,
      });
    }
    if (ctx.surfaceKind !== "paper") {
      commands.push({
        id: "nav.paper",
        title: "Go to Paper",
        group: "Navigate",
        run: ctx.goToPaper,
      });
    }
  }
  commands.push({
    id: "nav.settings",
    title: "Open Settings",
    group: "Navigate",
    run: ctx.openSettings,
  });
  if (ctx.screen === "projectDetail") {
    commands.push({
      id: "nav.openReview",
      title: "Open review…",
      group: "Navigate",
      run: ctx.reviewDirectly,
    });
  }
  if (ctx.screen === "frontDoor") {
    commands.push({
      id: "nav.reviewDirectly",
      title: "Review directly",
      group: "Navigate",
      run: ctx.reviewDirectly,
    });
  }

  if (ctx.screen === "workspace") {
    // A view command is offered only when it CHANGES the view — the destination that
    // is already shown would be inert, so it is omitted (never a dead entry).
    if (ctx.view !== "review") {
      commands.push({
        id: "nav.files",
        title: "Show Files view",
        group: "Navigate",
        run: ctx.showFiles,
      });
    }
    if (ctx.view !== "canvases") {
      commands.push({
        id: "nav.canvases",
        title: "Show Canvases view",
        group: "Navigate",
        run: ctx.showCanvases,
      });
    }
    commands.push(
      {
        id: "review.retry",
        title: "Retry the AI review",
        group: "Review",
        run: ctx.retryReview,
      },
      {
        id: "review.regenerate",
        title: "Regenerate the review",
        group: "Review",
        run: ctx.regenerate,
      },
      {
        id: "review.dual",
        title: ctx.deepReviewOn
          ? "Dual-model review: switch to quick single-model"
          : "Dual-model review: switch back on",
        group: "Review",
        run: ctx.toggleDeepReview,
      },
    );

    // The diff-canvas commands act on the live view store; they are only meaningful
    // while the Canvases view is showing a loaded review (the lens switcher + zoom
    // bar are on screen). Absent otherwise, never a dead entry.
    if (ctx.canvasReady) {
      // Every lens EXCEPT the one already active — "go to the lens I'm on" is inert.
      for (const angle of CANVAS_ANGLES) {
        const label = ANGLE_LABELS[angle];
        if (angle === ctx.angle || label === undefined) continue;
        commands.push({
          id: `lens.${angle}`,
          title: `Go to ${label} lens`,
          group: "Lens",
          run: () => ctx.goToAngle(angle),
        });
      }
      // Zoom clamps at the ends (zoomReducer), so the clamped direction is omitted:
      // no "Zoom in" at the deepest (diff) altitude, no "Zoom out" at the roll-up.
      if (ctx.zoomLevel !== "diff") {
        commands.push({
          id: "zoom.in",
          title: "Zoom in",
          group: "Zoom",
          keybinding: "l",
          run: ctx.zoomIn,
        });
      }
      if (ctx.zoomLevel !== "rollup") {
        commands.push({
          id: "zoom.out",
          title: "Zoom out",
          group: "Zoom",
          keybinding: "h",
          run: ctx.zoomOut,
        });
      }
      commands.push(
        {
          id: "view.overlay",
          title: ctx.overlayOn ? "Hide the blast-radius overlay" : "Paint the blast-radius overlay",
          group: "Appearance",
          run: ctx.toggleOverlay,
        },
        {
          id: "view.scheme",
          title: ctx.scheme === "dark" ? "Switch to the bright room" : "Switch to dark",
          group: "Appearance",
          run: ctx.toggleScheme,
        },
      );
    }
  }

  if (ctx.screen === "directEntry") {
    commands.push({
      id: "door.choose",
      title: "Choose a repository",
      group: "Start",
      run: ctx.chooseRepository,
    });
  }

  return commands;
}

/**
 * A subsequence fuzzy match: `query`'s characters must appear in order in `text`.
 * Returns a cost (lower is better: leading gap + gaps between matches) or null when
 * it is not a subsequence at all. Contiguous, early matches score best.
 */
export function fuzzyScore(text: string, query: string): number | null {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  let cost = 0;
  let previous = -1;
  for (const char of needle) {
    const at = haystack.indexOf(char, from);
    if (at === -1) return null;
    cost += previous === -1 ? at : at - previous - 1;
    previous = at;
    from = at + 1;
  }
  return cost;
}

/**
 * Filter + rank commands against a query. An empty query keeps the registry order
 * (so the palette opens on the full, stably-ordered list); otherwise commands whose
 * "Group Title" contains the query as a subsequence pass, ranked by match cost then
 * original order (a stable tiebreak).
 */
export function filterCommands(commands: Command[], query: string): Command[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return commands;
  const scored: { command: Command; cost: number; index: number }[] = [];
  commands.forEach((command, index) => {
    const cost = fuzzyScore(`${command.group} ${command.title}`, trimmed);
    if (cost !== null) scored.push({ command, cost, index });
  });
  scored.sort((a, b) => a.cost - b.cost || a.index - b.index);
  return scored.map((entry) => entry.command);
}
