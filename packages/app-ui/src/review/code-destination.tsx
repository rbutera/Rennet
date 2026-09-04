import { counterpartPathFor, isTestPath } from "@rennet/protocol";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import { useLocation, useRoute, useSearch } from "wouter";
import { useSlugResolution } from "../routes/slug";
import { ROUTES, readSessionQuery, type SessionQuery, sessionPath } from "../routes/url";
import { activePatchsetFiles } from "./diff-source";

interface CodeDestinationSource {
  readonly capturedPaths: ReadonlySet<string>;
  openPath(path: string): void;
}

export interface CodeDestination {
  readonly onOpenPath?: (path: string) => void;
  readonly counterpart?: {
    readonly label: string;
    readonly path: string;
    onView(): void;
  };
}

const CodeDestinationContext = createContext<CodeDestinationSource | null>(null);
const NO_FILES: ReturnType<typeof activePatchsetFiles> = [];
const NO_DESTINATION: CodeDestination = {};

function currentQuery(search: string): SessionQuery {
  const query = readSessionQuery(new URLSearchParams(search));
  return {
    lens: query.lens,
    ...(query.generation === null ? {} : { generation: query.generation }),
    ...(query.file === null ? {} : { file: query.file }),
    ...(query.round === null ? {} : { round: query.round }),
    ...(query.ask === null ? {} : { ask: query.ask }),
  };
}

/**
 * Bind code evidence to the review resolved by the active session route. The provider
 * reads only the active patchset's captured paths. A project root or an uncaptured path
 * cannot become a Diff destination.
 */
export function CodeDestinationProvider({ children }: { readonly children: ReactNode }) {
  const [, navigate] = useLocation();
  const [, sessionParams] = useRoute(ROUTES.session);
  const [, runParams] = useRoute(ROUTES.sessionRun);
  const search = useSearch();
  const slugParam = sessionParams?.slug ?? runParams?.slug;
  const slug = slugParam === undefined ? "" : decodeURIComponent(slugParam);
  const resolution = useSlugResolution(slug);
  const review = resolution.status === "review" ? resolution.review : null;
  const hasReview = review !== null;
  const files = review === null ? NO_FILES : activePatchsetFiles(review);
  const capturedPaths = useMemo(() => new Set(files.map((file) => file.path)), [files]);
  const query = useMemo(() => currentQuery(search), [search]);

  const openPath = useCallback(
    (path: string) => {
      if (slug === "" || !hasReview || !capturedPaths.has(path)) return;
      navigate(sessionPath(slug, { ...query, view: "diff", file: path }), { replace: true });
    },
    [capturedPaths, hasReview, navigate, query, slug],
  );

  const value = useMemo<CodeDestinationSource>(
    () => ({ capturedPaths, openPath }),
    [capturedPaths, openPath],
  );

  return (
    <CodeDestinationContext.Provider value={value}>{children}</CodeDestinationContext.Provider>
  );
}

/**
 * Open a path in the Diff view when the review actually captured it, and SAY whether it
 * did. `useCodeDestination` needs its path at render time, which suits a code block and
 * not a callback handed to another surface — the chat slot learns a path only when the
 * reader clicks one.
 *
 * The boolean is the honest half. An uncaptured path is not a Diff destination (the
 * provider's own rule), so a caller that ignored the answer would swallow the click and
 * leave the reader looking at an unchanged screen. Returning `false` lets the caller fall
 * back to whatever it would have done.
 */
export function useOpenCapturedPath(): (path: string) => boolean {
  const source = useContext(CodeDestinationContext);
  return useCallback(
    (path: string) => {
      if (source === null || !source.capturedPaths.has(path)) return false;
      source.openPath(path);
      return true;
    },
    [source],
  );
}

/** Resolve one CodeBlock's route defaults. Outside the provider it stays inert. */
export function useCodeDestination(path: string): CodeDestination {
  const source = useContext(CodeDestinationContext);
  return useMemo(() => {
    if (source === null || !source.capturedPaths.has(path)) return NO_DESTINATION;
    const counterpartPath = counterpartPathFor(path, source.capturedPaths);
    return {
      onOpenPath: source.openPath,
      ...(counterpartPath === null
        ? {}
        : {
            counterpart: {
              label: isTestPath(path) ? "View implementation" : "View test",
              path: counterpartPath,
              onView: () => source.openPath(counterpartPath),
            },
          }),
    };
  }, [path, source]);
}
