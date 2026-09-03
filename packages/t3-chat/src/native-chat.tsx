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
import { useEffect, useState } from "react";
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
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import {
  setActiveEnvironmentId,
  useEnvironmentThreadRefs,
  useThread,
  useThreadDetail,
  useThreadRefs,
  useThreadShell,
  useThreadStatus,
} from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { environmentShell } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  buildThreadRouteParams,
  resolveThreadRouteRef,
  resolveThreadRouteRenderState,
} from "~/threadRoutes";
import { resolveThreadSyncPhase } from "~/threadSync";
import { type SidecarSession, sidecarRegistration, sidecarThreadPath } from "./session";

export interface T3NativeChatProps {
  readonly session: SidecarSession;
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

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <p data-slot="t3-native-home" className="p-3 text-xs text-muted-foreground">
      No thread is bound to this review yet.
    </p>
  ),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/connections",
  component: () => (
    <p data-slot="t3-native-settings" className="p-3 text-xs text-muted-foreground">
      Connections are managed by the Rennet daemon; there is nothing to configure here.
    </p>
  ),
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
  const navigate = useNavigate();
  const threadRef = threadRoute.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const shell = useEnvironmentQuery(
    threadRef === null ? null : environmentShell.stateAtom(threadRef.environmentId),
  );
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const environmentThreadRefs = useEnvironmentThreadRefs(threadRef?.environmentId ?? null);
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const environmentHasServerThreads = environmentThreadRefs.length > 0;
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) =>
    threadRef ? store.hasDraftThreadsInEnvironment(threadRef.environmentId) : false,
  );
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadShellExists: serverThreadShell !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    draftThreadExists: draftThread !== null,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadShell !== null,
    status: serverThreadStatus,
  });
  const serverThreadStarted = threadHasStarted(serverThreadDetail);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) return;
    if (renderState === "missing" && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, renderState, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread) return;
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread, serverThreadStarted, threadRef]);

  if (!threadRef) return null;
  if (renderState !== "ready" && !(renderState === "loading" && serverThreadShell !== null)) {
    return (
      <p data-slot="t3-native-syncing" className="p-3 text-xs text-muted-foreground">
        Connecting to the T3 Code sidecar…
      </p>
    );
  }
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

export default function T3NativeChat({ session }: T3NativeChatProps) {
  const [router] = useState(() => createChatRouter(sidecarThreadPath(session)));
  return (
    <div
      data-slot="t3-native-chat"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
    >
      <AppAtomRegistryProvider>
        <SidecarEnvironment session={session} />
        <FollowPath router={router} path={sidecarThreadPath(session)} />
        <RouterProvider router={router} />
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
export function T3ThreadView({ session, thread }: T3ThreadViewProps) {
  const [router] = useState(() => createChatRouter(sidecarThreadPath(thread)));
  return (
    <div
      data-slot="t3-thread-view"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
    >
      <AppAtomRegistryProvider>
        <SidecarEnvironment session={session} />
        <FollowPath router={router} path={sidecarThreadPath(thread)} />
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>
    </div>
  );
}
