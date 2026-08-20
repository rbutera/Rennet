import type { CanvasAngle } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import type { ZoomLevel } from "../canvas/logic";
import {
  crumb,
  type RecentSurface,
  type Surface,
  type SurfaceLabels,
  surfaceIdentity,
} from "../nav/history";

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
// Keybindings live HERE, in the registry (the `COMMAND_CATALOGUE` below), not
// hardcoded at each call site. That is the "remappable" structure the wireframe asks
// for: the Settings → Keyboard surface edits user overrides, and key dispatch matches
// through the effective binding (default overlaid by override). ⌘K plus history's
// ⌘[ / ⌘] are matched at the window listener (app.tsx); the diff-canvas keys (`l h`)
// are matched at the workspace's own keydown — both route through this one catalogue.
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
   * The declared keybinding, as a platform-NEUTRAL token: `mod+[` for a
   * Cmd/Ctrl chord (rendered `⌘[` on macOS, `Ctrl+[` on Windows/Linux via
   * {@link formatKeybinding}), or a bare key like `l`. The registry is its canonical
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
  currentSurface: Surface;
  recents: readonly RecentSurface[];
  surfaceLabels: SurfaceLabels;
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
  goToRecent(surface: RecentSurface): void;
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

// ─────────────────────────────────────────────────────────────────────────────
// The catalogue — the SINGLE source of every stable command's title, group, and
// default keybinding. `buildCommands` reads its emitted commands' presentation from
// here (so there is no second table of titles or chords), key dispatch matches
// against these defaults overlaid by user overrides, and the settings Keyboard
// section lists these. Dynamic entries (`recent.*`, `lens.*`) are generated per
// context and deliberately NOT catalogued.
// ─────────────────────────────────────────────────────────────────────────────

/** A catalogued command definition. `title` may depend on live context (toggles). */
export interface CommandDef {
  id: string;
  group: string;
  title: string | ((ctx: CommandContext) => string);
  /** Default platform-neutral keybinding token (`mod+[`, `l`); absent = no default chord. */
  keybinding?: string;
}

/** A user keybinding-override map: command id → chord token, or `null` for explicit unbound. */
export type KeybindingOverrides = Record<string, string | null>;

export const COMMAND_CATALOGUE: readonly CommandDef[] = [
  { id: "palette.toggle", title: "Toggle command palette", group: "General", keybinding: "mod+k" },
  { id: "nav.back", title: "Back", group: "Navigate", keybinding: "mod+[" },
  { id: "nav.forward", title: "Forward", group: "Navigate", keybinding: "mod+]" },
  { id: "nav.projects", title: "Back to projects", group: "Navigate" },
  { id: "nav.project", title: "Go to project…", group: "Navigate" },
  { id: "nav.draft", title: "Go to Draft", group: "Navigate" },
  { id: "nav.paper", title: "Go to Paper", group: "Navigate" },
  { id: "nav.settings", title: "Open Settings", group: "Navigate", keybinding: "mod+," },
  { id: "nav.openReview", title: "Open review…", group: "Navigate" },
  { id: "nav.reviewDirectly", title: "Review directly", group: "Navigate" },
  { id: "nav.files", title: "Show Files view", group: "Navigate" },
  { id: "nav.canvases", title: "Show Canvases view", group: "Navigate" },
  { id: "review.retry", title: "Retry the AI review", group: "Review" },
  { id: "review.regenerate", title: "Regenerate the review", group: "Review" },
  {
    id: "review.dual",
    group: "Review",
    title: (ctx) =>
      ctx.deepReviewOn
        ? "Dual-model review: switch to quick single-model"
        : "Dual-model review: switch back on",
  },
  { id: "zoom.in", title: "Zoom in", group: "Zoom", keybinding: "l" },
  { id: "zoom.out", title: "Zoom out", group: "Zoom", keybinding: "h" },
  {
    id: "view.scheme",
    group: "Appearance",
    title: (ctx) => (ctx.scheme === "dark" ? "Switch to light" : "Switch to dark"),
  },
  { id: "door.choose", title: "Choose a repository", group: "Start" },
];

const catalogueById = new Map(COMMAND_CATALOGUE.map((def) => [def.id, def] as const));

/** The catalogue definition for an id, or undefined for a dynamic/uncatalogued id. */
export function catalogueDef(id: string): CommandDef | undefined {
  return catalogueById.get(id);
}

/**
 * Build a live `Command` for a catalogued id: title/group/keybinding come from the
 * catalogue (the single source), `run` is the app's own handler. The keydown sites
 * and the palette therefore agree on every chord and label by construction.
 */
export function commandFromCatalogue(
  id: string,
  ctx: CommandContext | undefined,
  run: () => void,
): Command {
  const def = catalogueById.get(id);
  if (!def) throw new Error(`command not in catalogue: ${id}`);
  if (typeof def.title === "function" && !ctx) {
    throw new Error(`command requires live context: ${id}`);
  }
  const title = typeof def.title === "function" ? def.title(ctx as CommandContext) : def.title;
  return def.keybinding
    ? { id, title, group: def.group, keybinding: def.keybinding, run }
    : { id, title, group: def.group, run };
}

const mk = commandFromCatalogue;

/**
 * Assemble the commands live for the given context. Only enabled commands are
 * returned — a command absent from the list is one that cannot act right now (no
 * review open, wrong view), which is exactly the "review-only commands disabled/
 * absent when no review is open" the palette wants. Order here is the palette's
 * order; the fuzzy filter re-ranks by match, an empty query keeps this order.
 */
export function buildCommands(ctx: CommandContext): Command[] {
  const commands: Command[] = [];

  const currentIdentity = surfaceIdentity(ctx.currentSurface);
  for (const surface of ctx.recents) {
    const identity = surfaceIdentity(surface);
    if (identity === currentIdentity) continue;
    const title = crumb([surface], ctx.surfaceLabels)[0]?.label ?? identity;
    commands.push({
      id: `recent.${identity}`,
      title,
      group: "Recent",
      run: () => ctx.goToRecent(surface),
    });
  }

  if (ctx.canBack) {
    commands.push(mk("nav.back", ctx, ctx.back));
  }
  if (ctx.canForward) {
    commands.push(mk("nav.forward", ctx, ctx.forward));
  }
  if (ctx.surfaceKind !== "projects") {
    commands.push(mk("nav.projects", ctx, ctx.goToProjects));
  }
  if (ctx.canGoToProject && ctx.surfaceKind !== "project") {
    commands.push(mk("nav.project", ctx, ctx.goToProject));
  }
  if (
    !ctx.retrospective &&
    (ctx.surfaceKind === "review" || ctx.surfaceKind === "draft" || ctx.surfaceKind === "paper")
  ) {
    if (ctx.surfaceKind !== "draft") {
      commands.push(mk("nav.draft", ctx, ctx.goToDraft));
    }
    if (ctx.surfaceKind !== "paper") {
      commands.push(mk("nav.paper", ctx, ctx.goToPaper));
    }
  }
  commands.push(mk("nav.settings", ctx, ctx.openSettings));
  if (ctx.screen === "projectDetail") {
    commands.push(mk("nav.openReview", ctx, ctx.reviewDirectly));
  }
  if (ctx.screen === "frontDoor") {
    commands.push(mk("nav.reviewDirectly", ctx, ctx.reviewDirectly));
  }

  if (ctx.screen === "workspace") {
    // A view command is offered only when it CHANGES the view — the destination that
    // is already shown would be inert, so it is omitted (never a dead entry).
    if (ctx.view !== "review") {
      commands.push(mk("nav.files", ctx, ctx.showFiles));
    }
    if (ctx.view !== "canvases") {
      commands.push(mk("nav.canvases", ctx, ctx.showCanvases));
    }
    commands.push(
      mk("review.retry", ctx, ctx.retryReview),
      mk("review.regenerate", ctx, ctx.regenerate),
      mk("review.dual", ctx, ctx.toggleDeepReview),
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
        commands.push(mk("zoom.in", ctx, ctx.zoomIn));
      }
      if (ctx.zoomLevel !== "rollup") {
        commands.push(mk("zoom.out", ctx, ctx.zoomOut));
      }
      commands.push(mk("view.scheme", ctx, ctx.toggleScheme));
    }
  }

  if (ctx.screen === "directEntry") {
    commands.push(mk("door.choose", ctx, ctx.chooseRepository));
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

/**
 * Whether the renderer is running on macOS — decides the modifier SYMBOL only
 * (add-windows-support). Safe when `navigator` is absent (SSR/tests): defaults to
 * non-mac. `userAgentData.platform` is preferred (`navigator.platform` is deprecated)
 * with a graceful fallback.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaPlatform = (navigator as unknown as { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  const platform = uaPlatform ?? navigator.platform ?? navigator.userAgent ?? "";
  return /mac/i.test(platform);
}

/**
 * Render a keybinding token for display (add-windows-support). A `mod+X` chord shows
 * as `⌘X` on macOS and `Ctrl+X` on Windows/Linux; a bare key (`l`, `h`) renders
 * as-is. Matching requires the platform-primary modifier, so label and behavior agree.
 */
export function formatKeybinding(token: string, mac: boolean = isMacPlatform()): string {
  if (!token.startsWith("mod+")) return token;
  const key = token.slice("mod+".length);
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard dispatch over the registry. A pressed key becomes a normalized chord;
// the effective binding (default overlaid by the user's override) is what dispatch
// matches, what the palette displays, and what conflict detection inspects.
// ─────────────────────────────────────────────────────────────────────────────

/** A normalized chord: modifier (Cmd/Ctrl) state + the lowercased key. */
export interface Chord {
  mod: boolean;
  key: string;
  /** True when the event carries a modifier the v1 grammar cannot represent. */
  unsupported?: true;
}

const NAMED_KEYS = new Set([
  "arrowdown",
  "arrowleft",
  "arrowright",
  "arrowup",
  "backspace",
  "delete",
  "end",
  "enter",
  "escape",
  "home",
  "pagedown",
  "pageup",
  "space",
  "tab",
]);

function normalizeKeyToken(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  if (NAMED_KEYS.has(lower)) return lower;
  if (Array.from(trimmed).length !== 1) return null;
  return /^[a-z0-9]$/i.test(trimmed) || "`-=[]\\;',./".includes(trimmed) ? lower : null;
}

/**
 * Parse a keybinding token into a normalized chord, or `null` when it is not a
 * recognizable binding (empty, or `mod+` with no key — garbage in config.json). A
 * command with an unparseable stored override falls back to its default; the stored
 * value stays reportable so the settings row can show it honestly (never a throw).
 */
export function normalizeChord(token: string): Chord | null {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("mod+")) {
    const key = normalizeKeyToken(trimmed.slice("mod+".length));
    return key === null ? null : { mod: true, key };
  }
  const key = normalizeKeyToken(trimmed);
  return key === null ? null : { mod: false, key };
}

/**
 * The effective binding for a command: the user's override if the map carries the id
 * (`null` = explicitly unbound), otherwise the catalogue default. `null` means the
 * command fires from no chord.
 */
export function effectiveKeybinding(
  def: { id: string; keybinding?: string },
  overrides: KeybindingOverrides = {},
): string | null {
  const override = overrides[def.id];
  if (override === null) return null;
  if (override !== undefined && normalizeChord(override)) return override;
  return def.keybinding && normalizeChord(def.keybinding) ? def.keybinding : null;
}

/**
 * The command in `commands` whose EFFECTIVE binding matches the pressed chord, or
 * `undefined`. Overrides are overlaid per command; an unbound or unparseable binding
 * never matches. First match wins — deterministic in catalogue/emit order, so a
 * conflict resolves to the earlier command (documented tie-break).
 */
export function matchKeybinding<T extends { id: string; keybinding?: string }>(
  commands: readonly T[],
  pressed: Chord,
  overrides: KeybindingOverrides = {},
): T | undefined {
  if (pressed.unsupported) return undefined;
  for (const command of commands) {
    const token = effectiveKeybinding(command, overrides);
    if (token === null) continue;
    const chord = normalizeChord(token);
    if (chord && chord.mod === pressed.mod && chord.key === pressed.key) return command;
  }
  return undefined;
}

/** A pressed keyboard event reduced to a normalized chord (mod = Cmd or Ctrl). */
export function chordFromEvent(
  event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  },
  mac: boolean = isMacPlatform(),
): Chord {
  const primary = mac ? event.metaKey : event.ctrlKey;
  const nonPrimary = mac ? event.ctrlKey : event.metaKey;
  return {
    mod: primary,
    key: event.key.toLowerCase(),
    ...(event.shiftKey || event.altKey || nonPrimary ? { unsupported: true } : {}),
  };
}

/**
 * Every effective chord claimed by more than one command, keyed by a canonical chord
 * string (`mod+e`, `l`). Conflict detection is disclosure only — a conflicting write
 * is never refused; this simply reports who collides so both rows can name it.
 */
export function findConflicts(
  entries: readonly { id: string; keybinding?: string }[],
  overrides: KeybindingOverrides = {},
): Map<string, string[]> {
  const byChord = new Map<string, string[]>();
  for (const entry of entries) {
    const token = effectiveKeybinding(entry, overrides);
    const chord = token ? normalizeChord(token) : null;
    if (!chord) continue;
    const key = `${chord.mod ? "mod+" : ""}${chord.key}`;
    const ids = byChord.get(key) ?? [];
    ids.push(entry.id);
    byChord.set(key, ids);
  }
  for (const [key, ids] of byChord) {
    if (ids.length < 2) byChord.delete(key);
  }
  return byChord;
}
