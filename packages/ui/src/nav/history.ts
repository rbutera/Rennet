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

export function crumb(stack: Surface[]): CrumbSegment[] {
  return stack.map((surface, index) => {
    switch (surface.kind) {
      case "projects":
        return { label: "Projects", kind: surface.kind, index };
      case "project":
        return { label: surface.projectId, kind: surface.kind, index };
      case "review":
        return { label: surface.reviewId, kind: surface.kind, index };
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
