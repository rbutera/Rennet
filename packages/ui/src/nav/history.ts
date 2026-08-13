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

export type PersistedNavigationState = NavHistoryState & {
  recents: Surface[];
};

export type NavHistoryAction =
  | { type: "push"; surface: Surface }
  | { type: "back" }
  | { type: "forward" }
  | { type: "ascendTo"; index: number }
  | { type: "replaceTop"; surface: Surface }
  | { type: "restore"; state: NavHistoryState };

export type CrumbSegment = {
  label: string;
  kind: Surface["kind"];
  index: number;
};

export type SurfaceLabels = {
  project(id: string): string | undefined;
  review(id: string): string | undefined;
};

const RECENT_LIMIT = 8;

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

export function recordRecent(recents: readonly Surface[], surface: Surface): Surface[] {
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

export const restore = (state: NavHistoryState): NavHistoryAction => ({ type: "restore", state });

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
    case "restore":
      return action.state;
  }
}

export const NAV_HISTORY_VERSION = 1;
export const NAV_HISTORY_STORAGE_KEY = `rennet.nav.v${NAV_HISTORY_VERSION}`;

const cleanNavigation = (): PersistedNavigationState => ({
  stack: [{ kind: "projects" }],
  future: [],
  recents: [],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSurface(value: unknown): value is Surface {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "projects":
      return true;
    case "project":
      return typeof value.projectId === "string" && value.projectId.length > 0;
    case "review":
    case "draft":
    case "paper":
      return typeof value.reviewId === "string" && value.reviewId.length > 0;
    default:
      return false;
  }
}

export function serialize(state: PersistedNavigationState): string {
  return JSON.stringify({ version: NAV_HISTORY_VERSION, ...state });
}

export function parse(raw: string): PersistedNavigationState | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== NAV_HISTORY_VERSION) return undefined;
    if (
      !Array.isArray(value.stack) ||
      !Array.isArray(value.future) ||
      !Array.isArray(value.recents)
    ) {
      return undefined;
    }
    if (
      value.stack.length === 0 ||
      value.stack[0]?.kind !== "projects" ||
      !value.stack.every(isSurface) ||
      !value.future.every(isSurface) ||
      !value.recents.every(isSurface)
    ) {
      return undefined;
    }
    return {
      stack: value.stack,
      future: value.future,
      recents: value.recents,
    };
  } catch {
    return undefined;
  }
}

function reviewIdFor(surface: Surface): string | undefined {
  return surface.kind === "review" || surface.kind === "draft" || surface.kind === "paper"
    ? surface.reviewId
    : undefined;
}

export function hydrate(
  stored: string | null | undefined,
  bootstrapReviewId?: string | null,
): PersistedNavigationState {
  const parsed = stored ? parse(stored) : undefined;
  if (!parsed) {
    const clean = cleanNavigation();
    return bootstrapReviewId
      ? {
          ...clean,
          stack: [...clean.stack, { kind: "review", reviewId: bootstrapReviewId }],
        }
      : clean;
  }
  if (bootstrapReviewId === undefined) return parsed;

  const tip = parsed.stack.at(-1);
  if (!tip) return cleanNavigation();
  const tipReviewId = reviewIdFor(tip);
  if (tipReviewId !== undefined) {
    if (tipReviewId === bootstrapReviewId) return parsed;
    const projectIndex = parsed.stack.map((surface) => surface.kind).lastIndexOf("project");
    return {
      stack: projectIndex >= 0 ? parsed.stack.slice(0, projectIndex + 1) : [{ kind: "projects" }],
      future: [],
      recents: parsed.recents,
    };
  }

  if (bootstrapReviewId) {
    return {
      stack: [...parsed.stack, { kind: "review", reviewId: bootstrapReviewId }],
      future: [],
      recents: parsed.recents,
    };
  }
  return parsed;
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
