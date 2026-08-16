export type Surface =
  | { kind: "projects" }
  | { kind: "project"; projectId: string }
  | { kind: "review"; reviewId: string }
  | { kind: "draft"; reviewId: string }
  | { kind: "paper"; reviewId: string }
  | { kind: "handoff"; reviewId: string };

export type NavHistoryState = {
  stack: Surface[];
  future: Surface[];
};

export type RecentSurface = Extract<Surface, { kind: "projects" | "project" }>;

/**
 * The persisted navigation blob (issue #324 / #297 remainder): recents PLUS the
 * back/forward stack, so the app reopens where the user left off. `stack`/`future`
 * carry any surface kind — review-family surfaces are restorable now that
 * `review.load` exists, so the old #305 recents-only exclusion is gone.
 */
export type PersistedNavState = {
  recents: RecentSurface[];
  stack: Surface[];
  future: Surface[];
};

export type NavHistoryAction =
  | { type: "push"; surface: Surface }
  | { type: "back" }
  | { type: "forward" }
  | { type: "ascendTo"; index: number }
  | { type: "replaceTop"; surface: Surface };

export type CrumbSegment = {
  label: string;
  kind: Surface["kind"];
  index: number;
};

export type SurfaceLabels = {
  project(id: string): string | undefined;
  review(id: string): string | undefined;
};

export const RECENT_LIMIT = 8;

export function surfaceIdentity(surface: Surface): string {
  switch (surface.kind) {
    case "projects":
      return surface.kind;
    case "project":
      return `${surface.kind}:${surface.projectId}`;
    case "review":
    case "draft":
    case "paper":
    case "handoff":
      return `${surface.kind}:${surface.reviewId}`;
  }
}

export function recordRecent(
  recents: readonly RecentSurface[],
  surface: RecentSurface,
): RecentSurface[] {
  const identity = surfaceIdentity(surface);
  return [surface, ...recents.filter((recent) => surfaceIdentity(recent) !== identity)].slice(
    0,
    RECENT_LIMIT,
  );
}

export const push = (surface: Surface): NavHistoryAction => ({
  type: "push",
  surface,
});

export const back = (): NavHistoryAction => ({ type: "back" });

export const forward = (): NavHistoryAction => ({ type: "forward" });

export const ascendTo = (index: number): NavHistoryAction => ({
  type: "ascendTo",
  index,
});

export const replaceTop = (surface: Surface): NavHistoryAction => ({
  type: "replaceTop",
  surface,
});

export function navHistoryReducer(
  state: NavHistoryState,
  action: NavHistoryAction,
): NavHistoryState {
  switch (action.type) {
    case "push":
      return { stack: [...state.stack, action.surface], future: [] };
    case "back": {
      if (state.stack.length <= 1) return state;
      const surface = state.stack.at(-1);
      if (!surface) return state;
      return {
        stack: state.stack.slice(0, -1),
        future: [...state.future, surface],
      };
    }
    case "forward": {
      const surface = state.future.at(-1);
      if (!surface) return state;
      return {
        stack: [...state.stack, surface],
        future: state.future.slice(0, -1),
      };
    }
    case "ascendTo":
      return { stack: state.stack.slice(0, action.index + 1), future: [] };
    case "replaceTop":
      if (state.stack.length === 0) return state;
      return {
        stack: [...state.stack.slice(0, -1), action.surface],
        future: [],
      };
  }
}

export const NAV_HISTORY_VERSION = 3;
export const NAV_HISTORY_STORAGE_KEY = `rennet.nav.v${NAV_HISTORY_VERSION}`;
/** The pre-stack (recents-only) key, still read once on upgrade to keep recents. */
export const NAV_HISTORY_LEGACY_KEY = "rennet.nav.v2";

const cleanState = (): PersistedNavState => ({ recents: [], stack: [], future: [] });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRecentSurface(value: unknown): value is RecentSurface {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "projects":
      return true;
    case "project":
      return typeof value.projectId === "string" && value.projectId.length > 0;
    default:
      return false;
  }
}

/** A full surface (any kind) is valid iff its kind is known and its id is non-empty. */
function isValidSurface(value: unknown): value is Surface {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "projects":
      return true;
    case "project":
      return typeof value.projectId === "string" && value.projectId.length > 0;
    case "review":
    case "draft":
    case "paper":
    case "handoff":
      return typeof value.reviewId === "string" && value.reviewId.length > 0;
    default:
      return false;
  }
}

/** Validated recents: known kind, deduped by identity, capped. Invalid → empty. */
function parseRecents(value: unknown): RecentSurface[] {
  if (!Array.isArray(value) || !value.every(isRecentSurface)) return [];
  const identities = new Set<string>();
  const recents: RecentSurface[] = [];
  for (const surface of value as RecentSurface[]) {
    const identity = surfaceIdentity(surface);
    if (identities.has(identity)) continue;
    identities.add(identity);
    recents.push(surface);
    if (recents.length === RECENT_LIMIT) break;
  }
  return recents;
}

/**
 * A validated surface list (stack/future): absent → empty; a present-but-wrong or
 * any-invalid-entry list → null, so the caller drops the whole stack (recents
 * survive independently — a bad stack entry never wipes recents).
 */
function parseSurfaceList(value: unknown): Surface[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isValidSurface)) return null;
  return value as Surface[];
}

export function serialize(
  recents: readonly RecentSurface[],
  stack: readonly Surface[] = [],
  future: readonly Surface[] = [],
): string {
  return JSON.stringify({ version: NAV_HISTORY_VERSION, recents, stack, future });
}

export function parse(raw: string | null | undefined): PersistedNavState {
  if (!raw) return cleanState();
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return cleanState();
    // A v2 blob (recents-only) keeps its recents across the upgrade — no stack then.
    if (value.version === 2) {
      return { recents: parseRecents(value.recents), stack: [], future: [] };
    }
    if (value.version !== NAV_HISTORY_VERSION) return cleanState();
    const recents = parseRecents(value.recents);
    const stack = parseSurfaceList(value.stack);
    const future = parseSurfaceList(value.future);
    // Any invalid stack/future entry invalidates the whole stack, not the recents.
    if (stack === null || future === null) return { recents, stack: [], future: [] };
    return { recents, stack, future };
  } catch {
    return cleanState();
  }
}

function resolvedLabel(label: string | undefined, fallback: string): string {
  return label?.trim() ? label : fallback;
}

export function crumb(stack: Surface[], labels?: SurfaceLabels): CrumbSegment[] {
  return stack.map((surface, index) => {
    switch (surface.kind) {
      case "projects":
        return { label: "Projects", kind: surface.kind, index };
      case "project":
        return {
          label: resolvedLabel(labels?.project(surface.projectId), surface.projectId),
          kind: surface.kind,
          index,
        };
      case "review":
        return {
          label: resolvedLabel(labels?.review(surface.reviewId), surface.reviewId),
          kind: surface.kind,
          index,
        };
      case "draft":
        return { label: "Draft", kind: surface.kind, index };
      case "paper":
        return { label: "Paper", kind: surface.kind, index };
      case "handoff":
        return { label: "Handoff", kind: surface.kind, index };
      default: {
        const exhaustive: never = surface;
        return exhaustive;
      }
    }
  });
}
