// Rung two of the chat slot (t3code-sidecar-chat, group 8): T3 Code's `ChatView`
// mounted natively inside Rennet's renderer. The vendored web app is imported by module
// (`~/` resolves into vendor/t3code/apps/web/src through the desktop Vite alias), never
// forked: this file supplies only what their route files would have — the atom
// registry, the toast and confirm hosts, a TanStack router over MEMORY history with the
// routes ChatView navigates to, and the review's environment registered from the
// daemon-brokered session. The thread route mirrors `_chat.$environmentId.$threadId.tsx`
// and the draft route mirrors `_chat.draft.$draftId.tsx`, minus their sidebar inset.

import "./t3.css";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import { createContext, useContext, useEffect, useState } from "react";
import ChatView from "~/components/ChatView";
import {
  resolveDraftPromotionNavigationTarget,
  threadHasStarted,
} from "~/components/ChatView.logic";
import { ConfirmDialogHost } from "~/components/ConfirmDialogHost";
import { waitForDraftHeroTransition } from "~/components/chat/draftHeroTransition";
import { ToastProvider } from "~/components/ui/toast";
import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { environmentCatalog } from "~/connection/catalog";
import { useRightPanelStore } from "~/rightPanelStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import {
  setActiveEnvironmentId,
  useThread,
  useThreadDetail,
  useThreadRefs,
  useThreadShell,
  useThreadStatus,
} from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { environmentShell } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteRef } from "~/threadRoutes";
import { resolveThreadSyncPhase } from "~/threadSync";
import {
  ConnectionsNotice,
  ThreadGoneNotice,
  ThreadSyncingNotice,
  ThreadUnavailableNotice,
} from "./placeholders";
import {
  resolvePinnedThreadView,
  type SidecarSession,
  type SidecarThread,
  sidecarRegistration,
  sidecarSessionPath,
  sidecarThreadPath,
} from "./session";

/** See `RouteFileOpens`. `false` = Rennet did not take the click. */
export type OpenFileInDiff = (path: string, line?: number) => boolean;

export interface T3NativeChatProps {
  readonly session: SidecarSession;
  readonly onOpenFile?: OpenFileInDiff;
}

/** A thread anywhere in the sidecar environment — a lens seat's, not the session's. */
export interface ThreadRef {
  readonly environmentId: string;
  readonly threadId: string;
}

export interface T3ThreadViewProps {
  readonly session: SidecarSession;
  readonly thread: ThreadRef;
  /** Read-only is what this mount IS; the literal keeps the call site saying so. */
  readonly readOnly: true;
  readonly onOpenFile?: OpenFileInDiff;
}

// ─── Routes ──────────────────────────────────────────────────────────────────
// ChatView and its hooks navigate to `/`, `/$environmentId/$threadId`, `/draft/$draftId`
// and `/settings/connections`; DiffPanel and the toast viewport read the thread params.
// Every one of those exists here, so no vendored navigate() can throw.

const rootRoute = createRootRoute({
  component: () => (
    <ToastProvider position="bottom-right">
      <ConfirmDialogHost />
      <Outlet />
    </ToastProvider>
  ),
});

/**
 * Why the mount has no thread, for the home route to say out loud.
 *
 * A route component takes no props, and the reason is a fact of the SESSION the mount was
 * handed — so it arrives by context rather than being re-derived. Undefined only in the
 * `T3ThreadView` mount, which is pointed at an explicit thread ref and never routes home.
 */
const MountThreadContext = createContext<SidecarThread | undefined>(undefined);

// The words in these routes live in ./placeholders, which imports no `~/` module and so
// can be rendered and read back by this package's own test (#849, corrected by #872).
function HomeRouteView() {
  const thread = useContext(MountThreadContext);
  return (
    <ThreadUnavailableNotice
      {...(thread?.status === "unavailable" ? { reason: thread.reason } : {})}
    />
  );
}

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeRouteView,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/connections",
  component: ConnectionsNotice,
});

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$environmentId/$threadId",
  component: ThreadRouteView,
});

const draftRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/draft/$draftId",
  component: DraftRouteView,
});

const routeTree = rootRoute.addChildren([homeRoute, settingsRoute, threadRoute, draftRoute]);

function createChatRouter(initialPath: string) {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    context: {},
  });
}

function ThreadRouteView() {
  const threadRef = threadRoute.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  // The environment's own bootstrap. Read here — not only for the decision below — because
  // subscribing to the shell atom is what starts and keeps the snapshot current.
  const shell = useEnvironmentQuery(
    threadRef === null ? null : environmentShell.stateAtom(threadRef.environmentId),
  );
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  // THE MOUNT IS PINNED TO THIS THREAD (#872), so there is no redirect here and no reading
  // of the rest of the environment to decide one — upstream's "go to the list" answer has
  // no list to go to inside Rennet's dock, and firing it lost the thread permanently.
  const view = resolvePinnedThreadView({
    bootstrapComplete: shell.data?.snapshot._tag === "Some",
    detailExists: serverThreadDetail !== null,
    draftExists: draftThread !== null,
    shellExists: serverThreadShell !== null,
    deleted: serverThreadStatus === "deleted",
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadShell !== null,
    status: serverThreadStatus,
  });
  const serverThreadStarted = threadHasStarted(serverThreadDetail);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread) return;
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread, serverThreadStarted, threadRef]);

  if (!threadRef) return null;
  if (view === "gone") return <ThreadGoneNotice />;
  if (view === "syncing") return <ThreadSyncingNotice />;
  return (
    <ChatView
      environmentId={threadRef.environmentId}
      threadId={threadRef.threadId}
      routeKind="server"
      threadSyncPhase={threadSyncPhase}
      reserveTitleBarControlInset={false}
    />
  );
}

function DraftRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = draftRoute.useParams();
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const threadRefs = useThreadRefs();
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef = draftSession?.promotedTo ?? inferredThreadRef;
  const serverThread = useThread(serverThreadRef);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(serverThreadRef);
  const canonicalThreadRef = resolveDraftPromotionNavigationTarget({
    serverThreadRef,
    serverThread,
    backgroundSubmissionPending,
  });

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) return;
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) return;
    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) return;
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  if (!draftSession) return null;
  return (
    <ChatView
      draftId={draftId}
      environmentId={draftSession.environmentId}
      threadId={draftSession.threadId}
      routeKind="draft"
      forceExpandedMobileComposer
      reserveTitleBarControlInset={false}
    />
  );
}

// ─── Environment ─────────────────────────────────────────────────────────────

/** Registers the brokered sidecar as a bearer environment and makes it the active one. */
function SidecarEnvironment({ session }: T3NativeChatProps) {
  const register = useAtomCommand(environmentCatalog.register, { reportFailure: false });
  const { origin, wsUrl, accessToken, environmentId } = session;
  useEffect(() => {
    const registration = sidecarRegistration({ origin, wsUrl, accessToken, environmentId });
    void register(registration);
    setActiveEnvironmentId(registration.target.environmentId);
  }, [register, origin, wsUrl, accessToken, environmentId]);
  return null;
}

/**
 * Sends a file reference clicked in the transcript to Rennet's Diff view.
 *
 * Upstream routes every one of them through ONE action — `useRightPanelStore.openFile(ref,
 * relativePath, line?)`, which `ChatView` hands to the timeline as `onOpenFile` — so that
 * action is the narrowest seam there is, and replacing it needs no vendored edit: the
 * store is zustand, its actions live in its state, and `setState` swaps one.
 *
 * Rennet takes the click only when it OWNS the answer. `onOpenFile` returns false for a
 * path the review never captured, and the original action runs instead, so a reference to
 * a file outside the patchset still opens T3's own viewer rather than doing nothing. The
 * original is restored on unmount, because the store is a module singleton shared with
 * every other mount in the document.
 */
function RouteFileOpens({ onOpenFile }: { readonly onOpenFile?: OpenFileInDiff }) {
  useEffect(() => {
    if (onOpenFile === undefined) return;
    const original = useRightPanelStore.getState().openFile;
    useRightPanelStore.setState({
      openFile: (ref, relativePath, line) => {
        if (onOpenFile(relativePath, line)) return;
        original(ref, relativePath, line);
      },
    });
    return () => {
      useRightPanelStore.setState({ openFile: original });
    };
  }, [onOpenFile]);
  return null;
}

/** Keeps a mounted memory router on `path` as the review — or the opened lens — changes. */
function FollowPath({
  router,
  path,
}: {
  readonly router: ReturnType<typeof createChatRouter>;
  readonly path: string;
}) {
  useEffect(() => {
    if (router.state.location.pathname !== path) {
      void router.navigate({ to: path, replace: true });
    }
  }, [router, path]);
  return null;
}

export default function T3NativeChat({ session, onOpenFile }: T3NativeChatProps) {
  const [router] = useState(() => createChatRouter(sidecarSessionPath(session)));
  return (
    <div
      data-slot="t3-native-chat"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
    >
      <AppAtomRegistryProvider>
        <MountThreadContext.Provider value={session.thread}>
          <SidecarEnvironment session={session} />
          <RouteFileOpens {...(onOpenFile === undefined ? {} : { onOpenFile })} />
          <FollowPath router={router} path={sidecarSessionPath(session)} />
          <RouterProvider router={router} />
        </MountThreadContext.Provider>
      </AppAtomRegistryProvider>
    </div>
  );
}

/**
 * A lens seat's transcript (t3-lens-threads 3.3): the same providers, the same routes and
 * the same `ChatView` as the session mount, pointed at an arbitrary thread on the same
 * sidecar environment, with the composer hidden by the `t3-thread-view` rule in t3.css —
 * upstream's composer overlay carries `data-chat-composer-overlay`, so no vendored edit is
 * needed. Streaming is upstream's thread subscription: a seat still running keeps writing
 * into this view, and the transcript stays readable once it settles.
 */
export function T3ThreadView({ session, thread, onOpenFile }: T3ThreadViewProps) {
  const [router] = useState(() => createChatRouter(sidecarThreadPath(thread)));
  return (
    <div
      data-slot="t3-thread-view"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
    >
      <AppAtomRegistryProvider>
        <SidecarEnvironment session={session} />
        <RouteFileOpens {...(onOpenFile === undefined ? {} : { onOpenFile })} />
        <FollowPath router={router} path={sidecarThreadPath(thread)} />
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>
    </div>
  );
}
