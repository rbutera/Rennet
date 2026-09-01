import {
  newCommandId,
  type RennetBridge,
  type SessionPreparation,
  type SettingsView,
  type SidebarSession,
} from "@rennet/protocol";
import { Button } from "@rennet/ui";
import { FolderPlus } from "lucide-react";
import { Component, lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { Redirect, Route, Router, Switch, useLocation, useSearch } from "wouter";
import { ReviewWorkspace } from "../app/review-workspace-route";
import { Icon } from "../components/icon";
import { BridgeProvider, useCommand, useMutation, useRefreshCommand } from "../data";
import { ArchivedView } from "../project/archived-view";
import { BackgroundNarration } from "../project/indexing/background-narration";
import { IndexingView } from "../project/indexing/indexing-view";
import { NewChatView } from "../project/new-chat-view";
import { coverageNote, coverageStatus } from "../rounds/round-machine";
import { RoundsSourceProvider, useLiveRoundsSource } from "../rounds/rounds-data";
import { RunRoute, StatusIcon } from "../rounds/run-route";
import {
  LiveSettingsProjectionProvider,
  PriorSurfaceTracker,
  SettingsScreen,
  ThemePrefProvider,
} from "../settings";
import { useConnectionCapabilities } from "../shell/connection-capabilities";
import { useRennetStore } from "../store";
import type { RennetHistory } from "./history";
import { AppLayout } from "./layout";
import { resolveProject } from "./project-resolution";
import { useSlugResolution } from "./slug";
import { newChatPath, ROUTES } from "./url";

// The welcome wizard is CODE-SPLIT (perf audit 2026-08-31, §6 H2). It is the only
// module in the whole renderer that imports `motion/react`, and it is the one screen
// most sessions never mount — an install that has finished the wizard once never sees
// it again. Eagerly imported, it dragged the animation runtime into the single startup
// chunk every window parses. `lazy` moves it, and motion with it, into a chunk fetched
// only when the wizard is actually elected.
//
// The fallback is nothing. The welcome owns the whole window, the chunk is a local
// file, and a spinner for a few milliseconds would be ceremony — the same reason
// `StartupGate` renders an invisible tree rather than a loading state while settings
// resolve. Both call sites go through this wrapper so neither has to know it is lazy.
const FirstRunWelcomeChunk = lazy(async () => ({
  default: (await import("../welcome/first-run-welcome")).FirstRunWelcome,
}));

/**
 * A chunk that fails to load must not take the window with it.
 *
 * `Suspense` catches the WAIT, never the rejection: a failed `import()` throws through the
 * fallback and unmounts the whole tree, so a corrupt or missing chunk file turned the very
 * first screen an install ever renders into a white void with nothing in it. That is the
 * one case a lazy boundary buys, and it is why this exists.
 *
 * It renders the SAME calm blank as the fallback and the pre-claimed state, plus a console
 * error for whoever is looking. No dialog, no retry button, no "something went wrong" —
 * the wizard is elective and the app behind it is intact.
 */
export class WelcomeChunkBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error("[rennet] the welcome chunk failed to load", error);
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

function FirstRunWelcome({ settings }: { readonly settings: SettingsView }) {
  return (
    <WelcomeChunkBoundary>
      <Suspense fallback={null}>
        <FirstRunWelcomeChunk settings={settings} />
      </Suspense>
    </WelcomeChunkBoundary>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RennetRouterApp (C01 §4) — the router foundation the later Track-C surfaces mount
// into. It wires the injected history + bridge and the #480 route table onto the
// persistent layout (sidebar + chat-dock slot outside the outlet). The screens here are
// INTERIM: they read real commands through the data seam and render minimal-but-honest
// content, and C3–C13 replace each with its full surface. Project detail remains mounted
// at its interim route (reconciliation 2).
// ─────────────────────────────────────────────────────────────────────────────

/** An honest interim placeholder for a screen a later C-change rebuilds. */
function Interim({ screen, title }: { readonly screen: string; readonly title: string }) {
  return (
    <section
      data-screen={screen}
      className="grid min-h-screen place-content-center justify-items-center gap-2 p-8 text-center"
    >
      <h1 className="font-display text-xl font-medium text-ink">{title}</h1>
      <p className="max-w-[520px] text-ink-soft">This surface lands with the Board rebuild.</p>
    </section>
  );
}

function NotFound({ label }: { readonly label: string }) {
  return (
    <section
      data-screen="not-found"
      role="status"
      className="grid min-h-screen place-content-center justify-items-center gap-2 p-8 text-center"
    >
      <h1 className="font-display text-xl font-medium text-ink">Not found</h1>
      <p className="max-w-[520px] text-ink-soft">Nothing here for {label}.</p>
    </section>
  );
}

/** An honest load-failure surface: the review could not be opened for a real reason
 *  (daemon disconnect, IPC fault, server exception) — NOT the same as "doesn't exist". */
function LoadError({ slug, error }: { readonly slug: string; readonly error: unknown }) {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    <section
      data-screen="load-error"
      role="alert"
      className="grid min-h-screen place-content-center justify-items-center gap-2 p-8 text-center"
    >
      <h1 className="font-display text-xl font-medium text-ink">Couldn’t open this review</h1>
      <p className="max-w-[520px] text-ink-soft">
        Opening “{slug}” failed: {detail}
      </p>
    </section>
  );
}

function NewChatScreen() {
  const search = useSearch();
  const requestedId = new URLSearchParams(search).get("project");
  const { data: listed, pending } = useCommand("projects.list", {});
  const { data: settings } = useCommand("settings.get", {});
  const { activeSource } = useConnectionCapabilities();
  const [, navigate] = useLocation();
  const { mutate: remember } = useMutation("settings.setLastProject", {
    invalidates: ["settings.get"],
  });
  const projects = listed?.projects ?? [];
  const rememberedId = settings?.navigation?.lastProjectBySource?.[activeSource];
  const resolved = resolveProject(projects, requestedId, rememberedId);
  const recorded = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!resolved || recorded.current === resolved.id) return;
    recorded.current = resolved.id;
    void remember({ source: resolved.source, projectId: resolved.id }).catch(() => {
      recorded.current = undefined;
    });
    if (requestedId !== resolved.id) navigate(newChatPath(resolved.id), { replace: true });
  }, [navigate, remember, requestedId, resolved]);

  if (pending || !settings) return <div className="min-h-screen bg-canvas" />;
  if (resolved) return <NewChatView projectId={resolved.id} />;
  return <EmptyProjectEntry />;
}

function EmptyProjectEntry() {
  const openDialog = useRennetStore((state) => state.uiActions.openDialog);
  return (
    <section
      data-screen="add-project-entry"
      className="grid min-h-screen place-content-center justify-items-center gap-4 p-10 text-center"
    >
      <span className="grid size-16 place-items-center rounded-window bg-accent-soft text-accent">
        <Icon icon={FolderPlus} className="size-8" />
      </span>
      <h1 className="font-display text-display font-medium text-ink">Add a project to begin.</h1>
      <p className="max-w-lg text-ink-soft">
        Choose a repository or workspace, then Rennet will open its branches and pull requests in
        New Chat.
      </p>
      <Button size="lg" onClick={() => openDialog("add-project")}>
        <Icon icon={FolderPlus} />
        Add Project
      </Button>
    </section>
  );
}

/**
 * The chat-only session — a real, minted session with no review attached yet.
 *
 * A real session with neither an attached review nor active preparation. New Chat now
 * opens its durable preparation screen immediately; this remains the honest surface for
 * older and intentionally bare sessions. The chat dock is mounted by the layout outside
 * this outlet, so the reviewer can still talk to the orchestrator here.
 */
function ChatOnlySession({ session }: { readonly session: SidebarSession }) {
  return (
    <section
      data-screen="chat-only-session"
      className="grid h-full place-content-center justify-items-center gap-2 p-10 text-center"
    >
      <h1 className="font-display text-xl font-medium text-ink">{session.title}</h1>
      <p className="max-w-[420px] font-serif text-ink-soft">
        This session is open on
        {session.claim ? ` ${session.claim.branch}` : " this project"}. Nothing has been captured to
        review yet, so there is no change to show.
      </p>
    </section>
  );
}

function preparationLaneNote(
  lane: Extract<SessionPreparation, { status: "drafting" }>["lanes"][number],
): string {
  if (lane.status === "done")
    return lane.verdict === "carrying-forward" ? "carrying forward" : "ready";
  if (lane.status === "absent" || lane.status === "failed") return lane.reason;
  if (lane.status === "drafted") return "drafted";
  return lane.status;
}

function PreparationLanes({ preparation }: { readonly preparation: SessionPreparation }) {
  const lanes = "lanes" in preparation ? preparation.lanes : undefined;
  const coverage = "coverage" in preparation ? preparation.coverage : undefined;
  if (lanes === undefined) return null;
  return (
    <div className="flex w-full flex-col divide-y divide-border/60 rounded-lg border border-border">
      {lanes.map((lane) => (
        <div
          key={lane.id}
          data-row={lane.id}
          data-status={lane.status}
          className="flex items-center gap-2.5 px-3.5 py-2 text-sm"
        >
          <StatusIcon status={lane.status} />
          <span className="text-foreground">{lane.label}</span>
          <span
            className={
              lane.status === "failed"
                ? "ml-auto max-w-[55%] truncate text-2xs text-destructive"
                : "ml-auto max-w-[55%] truncate text-2xs text-muted-foreground"
            }
          >
            {preparationLaneNote(lane)}
          </span>
        </div>
      ))}
      {coverage !== undefined && (
        <div
          data-row="coverage"
          data-testid="cross-lens-coverage"
          data-coverage={coverage.state}
          data-status={coverageStatus(coverage)}
          className="flex items-center gap-2.5 px-3.5 py-2 text-sm"
        >
          <StatusIcon status={coverageStatus(coverage)} />
          <span className="text-muted-foreground">{coverageNote(coverage)}</span>
        </div>
      )}
    </div>
  );
}

function SessionPreparationScreen({ session }: { readonly session: SidebarSession }) {
  const preparation = session.preparation;
  const refreshSessions = useRefreshCommand("session.list");
  const cancel = useMutation("session.cancelPreparation", { invalidates: ["session.list"] });
  const retry = useMutation("session.retryPreparation", { invalidates: ["session.list"] });
  const active = preparation?.status === "capturing" || preparation?.status === "drafting";

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(refreshSessions, 400);
    return () => window.clearInterval(timer);
  }, [active, refreshSessions]);

  if (preparation === undefined) return <ChatOnlySession session={session} />;
  const failed = preparation.status === "failed";
  const cancelled = preparation.status === "cancelled";
  const stage =
    preparation.status === "capturing"
      ? preparation.step === "resolving-repository"
        ? "Resolving the repository"
        : "Capturing the change"
      : preparation.status === "drafting"
        ? "Generating the Boards"
        : preparation.stage === "capture"
          ? "Capture"
          : "Board generation";

  return (
    <section
      data-screen="session-preparation"
      data-status={preparation.status}
      role={failed ? "alert" : "status"}
      className="mx-auto flex h-full w-full max-w-[720px] flex-col justify-center gap-5 p-8"
    >
      <div className="flex flex-col gap-1">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground/70">
          {failed ? `${stage} failed` : cancelled ? `${stage} cancelled` : stage}
        </span>
        <h1 className="font-display text-2xl font-medium text-ink">{session.title}</h1>
        <p className="font-serif text-ink-soft">
          {failed
            ? preparation.reason
            : cancelled
              ? "The review is still here. Retry when you’re ready."
              : preparation.status === "capturing"
                ? "The review route is open while Rennet pins the exact change."
                : "Boards appear here as each lens finishes."}
        </p>
      </div>
      <PreparationLanes preparation={preparation} />
      <div className="flex gap-2">
        {active ? (
          <Button
            variant="outline"
            disabled={cancel.pending}
            onClick={() => void cancel.mutate({ sessionId: session.id })}
          >
            Cancel
          </Button>
        ) : (
          <Button
            variant="accent"
            disabled={retry.pending}
            onClick={() => void retry.mutate({ sessionId: session.id, commandId: newCommandId() })}
          >
            Retry
          </Button>
        )}
      </div>
    </section>
  );
}

function useRememberProject(projectId?: string): void {
  const { data: listed } = useCommand("projects.list", {});
  const { mutate: remember } = useMutation("settings.setLastProject", {
    invalidates: ["settings.get"],
  });
  const recorded = useRef<string | null>(null);
  const project = listed?.projects.find((candidate) => candidate.id === projectId);

  useEffect(() => {
    if (!project || recorded.current === project.id) return;
    recorded.current = project.id;
    void remember({ source: project.source, projectId: project.id }).catch(() => {
      recorded.current = null;
    });
  }, [project, remember]);
}

function ProjectRoute({
  projectId,
  children,
}: {
  readonly projectId: string;
  readonly children: ReactNode;
}) {
  useRememberProject(projectId);
  return children;
}

function StartupGate({ children }: { readonly children: ReactNode }) {
  const {
    data: settings,
    pending: settingsPending,
    error: settingsError,
  } = useCommand("settings.get", {});
  if (settingsError) return <div className="contents">{children}</div>;
  if (settingsPending || !settings)
    return <div className="contents opacity-0 pointer-events-none">{children}</div>;
  // A replay request (`settings.resetWelcome`, from Settings or ⌘K) reopens the welcome
  // even on a machine full of projects. It has to bypass FirstRunEligibility entirely:
  // that resolver elects the wizard only for a client with NO projects, so a reset that
  // merely cleared the completion stamp would be a no-op on every real install — which
  // is exactly the state that made the welcome unreachable before this branch existed.
  // The ORDER of these two lines is load-bearing: `resetWelcome` PRESERVES an existing
  // `completedAt` (an older v1 build requires that field), so the two stamps stand
  // together and the request has to win. Finishing the wizard writes `{ completedAt }`
  // over the whole slice, which drops the request and lets the second line through.
  if (settings.welcome?.replayRequestedAt) return <FirstRunWelcome settings={settings} />;
  if (settings.welcome?.completedAt) return <div className="contents">{children}</div>;
  return <FirstRunEligibility settings={settings}>{children}</FirstRunEligibility>;
}

function FirstRunEligibility({
  settings,
  children,
}: {
  readonly settings: SettingsView;
  readonly children: ReactNode;
}) {
  const {
    data: listed,
    pending: projectsPending,
    error: projectsError,
  } = useCommand("projects.list", {});
  const [welcomeClaimed, setWelcomeClaimed] = useState<boolean>();

  useEffect(() => {
    if (welcomeClaimed !== undefined || !listed) return;
    setWelcomeClaimed(listed.projects.length === 0);
  }, [listed, welcomeClaimed]);

  if (projectsError) return <div className="contents">{children}</div>;
  if (projectsPending || welcomeClaimed === undefined) {
    return <div className="contents opacity-0 pointer-events-none">{children}</div>;
  }
  // The shell must NOT mount beneath the welcome. A hidden-but-mounted underlay is
  // not inert enough: its coach anchors still register, the coach store still elects
  // a mark, and the coachmark portals to `document.body` — so it paints OVER the
  // wizard, and a click in the wizard burns an unseen mark. Unmounting is the fix at
  // the root; the shell comes up once, on the other side of the welcome.
  if (welcomeClaimed) return <FirstRunWelcome settings={settings} />;
  return <div className="contents">{children}</div>;
}

/** A session route (#480 `/s/:slug`). The slug is the durable session id (C21); it
 *  resolves to the review workspace, an honest chat-only session when no review is
 *  attached yet, or an honest not-found / load-error. */
function SessionScreen({ slug }: { readonly slug: string }) {
  const { data: sessions } = useCommand("session.list", {});
  const session = sessions?.sessions.find((candidate) => candidate.id === slug);
  useRememberProject(session?.projectId);
  const resolution = useSlugResolution(slug);
  if (session?.preparation !== undefined) return <SessionPreparationScreen session={session} />;
  if (resolution.status === "pending") {
    return <p className="p-10 font-serif text-ink-soft">Opening…</p>;
  }
  if (resolution.status === "not-found") return <NotFound label={`session “${slug}”`} />;
  if (resolution.status === "error") return <LoadError slug={slug} error={resolution.error} />;
  if (resolution.status === "session") return <ChatOnlySession session={resolution.session} />;
  return <ReviewWorkspace review={resolution.review} />;
}

function SessionRunScreen({ slug }: { readonly slug: string }) {
  const { data: sessions } = useCommand("session.list", {});
  useRememberProject(sessions?.sessions.find((session) => session.id === slug)?.projectId);
  return <RunRoute slug={slug} />;
}

/**
 * App-wide appearance (wireframe #15): the reviewer's saved scheme is applied to the
 * document ROOT, so EVERY surface inherits it — not only the screens that thread a
 * `scheme` prop. `system` resolves live through the OS `prefers-color-scheme`, so an
 * OS appearance change re-themes without a reload. Mounts under `BridgeProvider`
 * (reads `settings.get` through the seam) and renders nothing — a pure synchronizer.
 * This restores what the deleted legacy shell owned, lost in the router cutover.
 */
/**
 * The LIVE rounds source for the session subtree (C15 3.2) — the cluster-8 swap. Must sit
 * inside `<Router>`: the source resolves the current session slug off the route, so the
 * live round it reads is the one the reviewer is looking at. Off a session route the
 * source is honest-absent, exactly as the constant it replaces was.
 */
function LiveRoundsScope({ children }: { readonly children: React.ReactNode }) {
  return <RoundsSourceProvider value={useLiveRoundsSource()}>{children}</RoundsSourceProvider>;
}

function AppearanceSync() {
  const { data } = useCommand("settings.get", {});
  const scheme = data?.scheme ?? "system";
  const [systemDark, setSystemDark] = useState(
    () => typeof matchMedia === "undefined" || matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const effective: "dark" | "light" =
    scheme === "light" ? "light" : scheme === "dark" ? "dark" : systemDark ? "dark" : "light";
  useEffect(() => {
    // The resolved scheme stamps BOTH `data-scheme` (the --rn-* swap in palette.css)
    // and the `dark` class on the root (C10 §6.3, claim 635 — the Tailwind dark-mode
    // selector, so any `dark:` utility and dark-aware kit component resolves too).
    const root = document.documentElement;
    root.dataset.scheme = effective;
    root.classList.toggle("dark", effective === "dark");
  }, [effective]);
  return null;
}

export interface RennetRouterAppProps {
  readonly bridge: RennetBridge;
  /** Injected history (hash / browser / memory). Omitted ⇒ the wouter browser default. */
  readonly history?: RennetHistory;
}

export function RennetRouterApp({ bridge, history }: RennetRouterAppProps) {
  return (
    <BridgeProvider bridge={bridge}>
      <AppearanceSync />
      {/* Background narration is collected ABOVE the route switch so a knowledge
          pass that fails while the reader is elsewhere is still there when the
          indexing screen opens (#592). Renders nothing. */}
      <BackgroundNarration />
      <ThemePrefProvider>
        <Router hook={history?.hook} searchHook={history?.searchHook}>
          <StartupGate>
            <PriorSurfaceTracker>
              {/* The live settings projection is mounted ABOVE the route switch, so a
                reader's per-session agent enablement (the `disabled` set) survives
                leaving and reopening Settings — it resets only on a full app remount
                (a reload), which is the spec (C10 §10.2). Settings is a route-local
                takeover; wrapping it there would drop the state on every exit. */}
              <LiveSettingsProjectionProvider>
                {/* One rounds source for the whole session subtree (C09 cluster 7). The
                  top-bar's History pill and the run/workspace routes must read the SAME
                  source, so the provider wraps the layout that owns both. C15 3.2 swapped
                  the honest-absent constant for the LIVE source: the run state folds real
                  `roundProgress` events, the ledger reads `session.rounds`, and Dispatch
                  runs `round.dispatch`. The provider did not move — only its value. */}
                <LiveRoundsScope>
                  <AppLayout>
                    <Switch>
                      <Route path={ROUTES.home}>
                        <Redirect to={ROUTES.newChat} />
                      </Route>
                      <Route path={ROUTES.newChat} component={NewChatScreen} />
                      <Route path={ROUTES.sessionRun}>
                        {(p) => <SessionRunScreen slug={p.slug ?? ""} />}
                      </Route>
                      <Route path={ROUTES.session}>
                        {(p) => <SessionScreen slug={p.slug ?? ""} />}
                      </Route>
                      <Route path={ROUTES.archived}>
                        <ArchivedView />
                      </Route>
                      <Route path={ROUTES.projectIndexing}>
                        {(p) => (
                          <ProjectRoute projectId={p.id ?? ""}>
                            <IndexingView projectId={p.id ?? ""} />
                          </ProjectRoute>
                        )}
                      </Route>
                      <Route path={ROUTES.settings}>
                        {(p) => <SettingsScreen page={p.page ?? ""} />}
                      </Route>
                      <Route path={ROUTES.projectDetail}>
                        {(p) => <Interim screen="project-detail" title={`Project — ${p.id}`} />}
                      </Route>
                      <Route path={ROUTES.projects}>
                        <Interim screen="projects" title="Projects" />
                      </Route>
                      <Route>
                        <NotFound label="this address" />
                      </Route>
                    </Switch>
                  </AppLayout>
                </LiveRoundsScope>
              </LiveSettingsProjectionProvider>
            </PriorSurfaceTracker>
          </StartupGate>
        </Router>
      </ThemePrefProvider>
    </BridgeProvider>
  );
}
