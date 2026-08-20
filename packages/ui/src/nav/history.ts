export type Surface =
  | { kind: "projects" }
  | { kind: "project"; projectId: string }
  | { kind: "review"; reviewId: string }
  | { kind: "draft"; reviewId: string }
  | { kind: "paper"; reviewId: string }
  | { kind: "handoff"; reviewId: string }
  | { kind: "contextMap"; projectId: string };

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
  | { type: "replaceTop"; surface: Surface }
  | { type: "discardTip" };

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
/** Local navigation stays bounded so persistence cannot grow until storage writes fail. */
export const NAV_HISTORY_LIMIT = 100;

export function surfaceIdentity(surface: Surface): string {
  switch (surface.kind) {
    case "projects":
      return surface.kind;
    case "project":
      return `${surface.kind}:${surface.projectId}`;
    case "contextMap":
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

export const discardTip = (): NavHistoryAction => ({ type: "discardTip" });

function cappedStack(stack: readonly Surface[]): Surface[] {
  if (stack.length <= NAV_HISTORY_LIMIT) return [...stack];
  if (stack[0]?.kind !== "projects") return stack.slice(-NAV_HISTORY_LIMIT);
  let prefixLength = 1;
  if (stack[prefixLength]?.kind === "project") prefixLength += 1;
  if (stack[prefixLength]?.kind === "review") prefixLength += 1;
  return [...stack.slice(0, prefixLength), ...stack.slice(-(NAV_HISTORY_LIMIT - prefixLength))];
}

function cappedFuture(future: readonly Surface[]): Surface[] {
  return future.slice(-NAV_HISTORY_LIMIT);
}

export function navHistoryReducer(
  state: NavHistoryState,
  action: NavHistoryAction,
): NavHistoryState {
  switch (action.type) {
    case "push":
      return { stack: cappedStack([...state.stack, action.surface]), future: [] };
    case "back": {
      if (state.stack.length <= 1) return state;
      const surface = state.stack.at(-1);
      if (!surface) return state;
      return {
        stack: state.stack.slice(0, -1),
        future: cappedFuture([...state.future, surface]),
      };
    }
    case "forward": {
      const surface = state.future.at(-1);
      if (!surface) return state;
      return {
        stack: cappedStack([...state.stack, surface]),
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
    case "discardTip": {
      const remaining = state.stack.slice(0, -1);
      return {
        stack: remaining.length > 0 ? remaining : [{ kind: "projects" }],
        future: [],
      };
    }
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

function hasValidTopology(stack: readonly Surface[], future: readonly Surface[]): boolean {
  if (stack.length === 0) return future.length === 0;
  const route = [...stack, ...future.toReversed()];
  if (route[0]?.kind !== "projects") return false;
  let index = 1;
  if (route[index]?.kind === "project") index += 1;
  if (index === route.length) return true;
  const review = route[index];
  if (review?.kind !== "review") return false;
  index += 1;
  for (; index < route.length; index += 1) {
    const surface = route[index];
    if (
      !surface ||
      (surface.kind !== "draft" && surface.kind !== "paper" && surface.kind !== "handoff") ||
      surface.reviewId !== review.reviewId
    ) {
      return false;
    }
  }
  return true;
}

export function serialize(
  recents: readonly RecentSurface[],
  stack: readonly Surface[] = [],
  future: readonly Surface[] = [],
): string {
  return JSON.stringify({
    version: NAV_HISTORY_VERSION,
    recents,
    stack: cappedStack(stack),
    future: cappedFuture(future),
  });
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
    // Any malformed or semantically impossible route invalidates the whole stack,
    // not the recents. Forward is stored in pop order, so validate it reversed.
    if (stack === null || future === null || !hasValidTopology(stack, future)) {
      return { recents, stack: [], future: [] };
    }
    return { recents, stack: cappedStack(stack), future: cappedFuture(future) };
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
      case "contextMap":
        return { label: "Context Map", kind: surface.kind, index };
      default: {
        const exhaustive: never = surface;
        return exhaustive;
      }
    }
  });
}
