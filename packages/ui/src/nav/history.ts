export type Surface =
  | { kind: "projects" }
  | { kind: "project"; projectId: string }
  | { kind: "review"; reviewId: string }
  | { kind: "draft"; reviewId: string }
  | { kind: "paper"; reviewId: string };

export type NavHistoryState = {
  stack: Surface[];
  future: Surface[];
};

export type RecentSurface = Extract<Surface, { kind: "projects" | "project" }>;

export type PersistedRecentsState = {
  recents: RecentSurface[];
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

export const NAV_HISTORY_VERSION = 2;
export const NAV_HISTORY_STORAGE_KEY = `rennet.nav.v${NAV_HISTORY_VERSION}`;

const cleanRecents = (): PersistedRecentsState => ({ recents: [] });

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

export function serialize(recents: readonly RecentSurface[]): string {
  return JSON.stringify({ version: NAV_HISTORY_VERSION, recents });
}

export function parse(raw: string | null | undefined): PersistedRecentsState {
  if (!raw) return cleanRecents();
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      value.version !== NAV_HISTORY_VERSION ||
      !Array.isArray(value.recents) ||
      !value.recents.every(isRecentSurface)
    )
      return cleanRecents();

    const identities = new Set<string>();
    const recents: RecentSurface[] = [];
    for (const surface of value.recents) {
      const identity = surfaceIdentity(surface);
      if (identities.has(identity)) continue;
      identities.add(identity);
      recents.push(surface);
      if (recents.length === RECENT_LIMIT) break;
    }
    return { recents };
  } catch {
    return cleanRecents();
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
      default: {
        const exhaustive: never = surface;
        return exhaustive;
      }
    }
  });
}
