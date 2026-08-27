import type {
  AppearanceScheme,
  Project,
  ProjectDetail as ProjectDetailData,
  ProjectKind,
  ProjectSource,
  RennetBridge,
  Review,
} from "@rennet/protocol";
import { Button, Input } from "@rennet/ui";
import { ArrowLeft, ArrowRight, Folder } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  buildCommands,
  type Command,
  type CommandContext,
  chordFromEvent,
  commandFromCatalogue,
  type KeybindingOverrides,
  matchKeybinding,
  type Screen,
} from "../command/commands";
import { RennetBrandMark } from "../components/brand-mark";
import { Breadcrumb } from "../components/breadcrumb";
import { CommandPalette } from "../components/command-palette";
import { ContextMapView } from "../components/context-map-view";
import { DirectoryPickerModal } from "../components/directory-picker-modal";
import { FrontDoor } from "../components/front-door";
import { Icon } from "../components/icon";
import { ProjectDetail } from "../components/project-detail";
import { SettingsScreen } from "../components/settings-screen";
import type { SourceOption } from "../components/source-switcher";
import { ChromeMenu, UpdateReadyPrompt, useUpdateReady } from "../components/update-ready";
import {
  ascendTo as ascendNavigationTo,
  crumb as deriveCrumb,
  discardTip as discardNavigationTip,
  NAV_HISTORY_LEGACY_KEY,
  NAV_HISTORY_STORAGE_KEY,
  navHistoryReducer,
  back as navigateBack,
  forward as navigateForward,
  type PersistedNavState,
  parse as parseNavigation,
  push as pushSurface,
  type RecentSurface,
  recordRecent,
  type Surface,
  type SurfaceLabels,
  serialize as serializeNavigation,
  surfaceIdentity,
} from "../nav/history";
import type { SmartRow } from "../project/smart-list";
import { ReviewWorkspace } from "./review-workspace-route";
import { activePatchset } from "./shared";

// ─────────────────────────────────────────────────────────────────────────────
// RennetApp — the navigation shell. B2 (#489) deleted the canvas review surface
// delete-first; the review route is a stub (`ReviewWorkspace`) that renders a
// placeholder for any review-family surface (review/draft/paper/handoff). What
// survives here is navigation: the front door, project detail, the context map,
// settings, direct entry, the command palette, and the history stack. Track C
// rebuilds the review surface on the Board.
// ─────────────────────────────────────────────────────────────────────────────

// Read the persisted navigation blob (#324/#297): the v3 stack + future + recents,
// falling back to the pre-stack v2 key so an upgrade keeps the user's recents. A
// bad/absent blob degrades to the clean default (no migration ceremony).
function readStoredNav(): PersistedNavState {
  try {
    const raw =
      globalThis.localStorage?.getItem(NAV_HISTORY_STORAGE_KEY) ??
      globalThis.localStorage?.getItem(NAV_HISTORY_LEGACY_KEY);
    return parseNavigation(raw);
  } catch {
    return { recents: [], stack: [], future: [] };
  }
}

function persistNav(
  recents: readonly RecentSurface[],
  stack: readonly Surface[],
  future: readonly Surface[],
): void {
  try {
    globalThis.localStorage?.setItem(
      NAV_HISTORY_STORAGE_KEY,
      serializeNavigation(recents, stack, future),
    );
  } catch {
    return;
  }
}

export function RennetApp({
  bridge,
  connectionSlot,
  connectDaemonForPath,
  pendingRepoPath,
  onPendingRepoConsumed,
  pendingAddPath,
  onPendingAddConsumed,
  sources,
  activeSource,
  connectSource,
  pendingSourceBrowse,
  onPendingSourceBrowseConsumed,
  logWslConnect,
}: {
  bridge: RennetBridge;
  connectionSlot?: ReactNode;
  /**
   * Connect the daemon that should serve a just-picked repo path (WSL connect flow). Present
   * only in the desktop shell; when a pick resolves to a WSL distro this switches the whole app
   * onto that distro's daemon (a remount) and returns `switched:true` — this app instance is
   * then tearing down, and the remounted one captures the repo via {@link pendingRepoPath}. A
   * host path is `switched:false` and the pick proceeds here unchanged; an `error` is honest
   * failure copy (e.g. no Node in the distro), shown inline — never a gate.
   */
  connectDaemonForPath?: (
    path: string,
    add?: { readonly kind: ProjectKind },
  ) => Promise<{ switched: boolean; error?: string }>;
  /** A distro-native repo path this freshly mounted app should capture on itself, once. */
  pendingRepoPath?: string;
  /** Called after {@link pendingRepoPath} is consumed, so the host clears it. */
  onPendingRepoConsumed?: () => void;
  /**
   * The front-door sibling of {@link pendingRepoPath}: a distro-native path (+kind) this freshly
   * mounted app should ADD (discover + projects.add) on itself, once — set when a WSL pick in the
   * add flow switched onto the distro daemon. Consumed by the front door, cleared via
   * {@link onPendingAddConsumed}.
   */
  pendingAddPath?: { readonly path: string; readonly kind: ProjectKind };
  /** Called after {@link pendingAddPath} is consumed, so the host clears it. */
  onPendingAddConsumed?: () => void;
  /** The add flow's selectable sources (source-aware project selection): Local + WSL distros +
   *  paired remotes. Absent in the browser shell (Local only). Forwarded straight to the front door. */
  sources?: SourceOption[];
  /** The `ProjectSource` of the daemon currently attached — a FRESH add defaults its source to
   *  this (not always "local"), so the SourceSwitcher's selection matches the attached daemon. */
  activeSource?: ProjectSource;
  /** Attach the daemon a chosen source lives on (a non-local source remounts the app). Forwarded to
   *  the front door; the browse is restored on the fresh mount via {@link pendingSourceBrowse}. */
  connectSource?: (
    source: ProjectSource,
    kind: ProjectKind,
  ) => Promise<{ switched: boolean; error?: string }>;
  /** A source (+kind) this freshly mounted app should restore the browse step on, once. */
  pendingSourceBrowse?: { readonly source: ProjectSource; readonly kind: ProjectKind };
  /** Called after {@link pendingSourceBrowse} is consumed, so the host clears it. */
  onPendingSourceBrowseConsumed?: () => void;
  /** Append one line to the desktop's wsl-connect.log (shell-owned); traces the add flow's
   *  completion on the distro daemon. Absent in the browser shell. */
  logWslConnect?: (entry: {
    readonly event: string;
    readonly path?: string;
    readonly detail?: Record<string, unknown>;
  }) => void;
}) {
  const [review, setReview] = useState<Review | null | undefined>(undefined);
  // Whether the open review's original repository root still exists on disk (#324).
  const [repositoryPresent, setRepositoryPresent] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Read the persisted navigation blob ONCE at mount (#324/#297).
  const storedNav = useRef<PersistedNavState | null>(null);
  if (storedNav.current === null) storedNav.current = readStoredNav();
  const [navigation, navigate] = useReducer(navHistoryReducer, null, () => {
    const stored = storedNav.current ?? { recents: [], stack: [], future: [] };
    // A persisted stack wins: the app reopens where the user left off. Absent → the
    // default Projects root (fresh install, or a v2/corrupt blob that carried no stack).
    return stored.stack.length > 0
      ? { stack: stored.stack, future: stored.future }
      : { stack: [{ kind: "projects" as const }], future: [] };
  });
  const currentSurface = navigation.stack.at(-1) ?? { kind: "projects" as const };
  const [recents, setRecents] = useState<RecentSurface[]>(() => storedNav.current?.recents ?? []);
  // The landing rehydrator's in-flight guard (#324): the surface identity currently
  // being reopened, so a re-render never double-fires a load.
  const rehydrating = useRef<string | null>(null);
  const navigationReady = review !== undefined;
  useEffect(() => {
    if (!navigationReady) return;
    if (currentSurface.kind !== "project" && currentSurface.kind !== "projects") return;
    setRecents((current) => recordRecent(current, currentSurface));
  }, [currentSurface, navigationReady]);
  // Persist recents AND the back/forward stack (#297 remainder) on every change, so a
  // restart reopens where the user left off.
  useEffect(() => persistNav(recents, navigation.stack, navigation.future), [recents, navigation]);
  // The legacy direct-entry capability is palette-only. It is an overlay beside
  // the surface stack, never a location recorded in navigation history.
  const [directEntryOpen, setDirectEntryOpen] = useState(false);
  // The in-app directory picker (source-aware project selection): the native OS folder
  // dialog is retired, so `chooseRepository` and the PR clone fallback pick a path THROUGH
  // the DirectoryBrowser modal on the CURRENT daemon. A pending pick holds its title +
  // resolve; the modal (rendered globally beside `updatePrompt`) settles the promise.
  const [pickRequest, setPickRequest] = useState<{
    title: string;
    confirmLabel?: string;
    resolve: (path: string | null) => void;
  } | null>(null);
  function pickDirectory(title: string, confirmLabel?: string): Promise<string | null> {
    return new Promise((resolve) => setPickRequest({ title, confirmLabel, resolve }));
  }
  // The settings screen (wireframe #15): opened from the front door, closed back
  // to it. `scheme` is the reviewer's chosen appearance, fetched once and applied
  // to the front door's `data-scheme` — so changing it in settings re-themes here.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const goBack = useCallback(() => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    if (directEntryOpen) {
      setDirectEntryOpen(false);
      return;
    }
    navigate(navigateBack());
  }, [directEntryOpen, settingsOpen]);
  const goForward = useCallback(() => navigate(navigateForward()), []);
  const [scheme, setScheme] = useState<AppearanceScheme>("system");
  // Project detail (issue #37): the unified smart list. Clicking a project row opens
  // this surface (local work + every PR in one list); a row there opens the review.
  const [projectDetail, setProjectDetail] = useState<Project | null>(null);
  const [projectDetailData, setProjectDetailData] = useState<ProjectDetailData | null>(null);
  // The GitHub PR front door (the second v1 source): the ref the user typed
  // (`owner/repo#123` or a PR URL). Opening it picks the local clone, then lands
  // in the same review surface a working-tree capture does.
  const [prRef, setPrRef] = useState("");
  // Retrospective open (read-only): review an already-merged PR to READ the code,
  // with posting structurally off. Drives `review.openPr`'s `retrospective` flag.
  const [prRetrospective, setPrRetrospective] = useState(false);

  // User keybinding overrides (#44), fetched with settings and overlaid on the
  // catalogue defaults at dispatch. A remap here is what key dispatch, the palette,
  // and conflict detection all read — so a remapped chord actually runs the command.
  const [keybindingOverrides, setKeybindingOverrides] = useState<KeybindingOverrides>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The live dispatch list + overrides, held in a ref so the window keydown listener
  // stays stable (subscribed once) while always reading the current commands.
  const dispatchRef = useRef<{ commands: Command[]; overrides: KeybindingOverrides }>({
    commands: [],
    overrides: {},
  });

  // App-wide keyboard dispatch routes through the registry (#44): every pressed chord
  // is matched against the live commands' EFFECTIVE bindings (catalogue default overlaid
  // by the user's overrides), so a remapped chord runs its command and the old chord
  // stops. Bare chords never fire from an editing control; the modified palette toggle
  // remains available there.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const { commands, overrides } = dispatchRef.current;
      const pressed = chordFromEvent(event);
      const match = matchKeybinding(commands, pressed, overrides);
      if (!match) return;
      const target = event.target;
      const editing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (editing && (!pressed.mod || match.id !== "palette.toggle")) return;
      event.preventDefault();
      match.run();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    bridge
      .invoke("app.bootstrap", {})
      .then(({ review: restored, repositoryPresent: restoredRepositoryPresent }) => {
        setReview(restored);
        setRepositoryPresent(restoredRepositoryPresent);
        // A persisted stack restored (more than the Projects root) wins for
        // navigation — the rehydrator reconciles the held review to the tip. Only
        // when NO stack was restored do we land the latest review as before (#297).
        const hadRestoredStack = (storedNav.current?.stack.length ?? 0) > 0;
        if (restored && !hadRestoredStack) {
          navigate(pushSurface({ kind: "review", reviewId: restored.id }));
        }
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [bridge]);

  // The landing rehydrator (#324/#297): load whatever the surface we land on needs —
  // review-family → review.load (by id); project → project.detail + projects.list. One
  // mechanism serves boot restore, back/forward into a not-yet-loaded surface, and any
  // programmatic navigation, so there is no separate boot special-path.
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadProjectDetail is a stable-by-intent body function (reads only bridge + setters); listing it would re-run the effect every render. The load-firing decision is keyed on currentSurface/review/projectDetail, which ARE listed.
  useEffect(() => {
    if (review === undefined) return; // bootstrap still resolving; the reducer holds the stack
    const surface = currentSurface;
    const identity = surfaceIdentity(surface);
    const isReviewFamily =
      surface.kind === "review" ||
      surface.kind === "draft" ||
      surface.kind === "paper" ||
      surface.kind === "handoff";
    if (isReviewFamily) {
      if (review && review.id === surface.reviewId) return; // already held
      if (rehydrating.current === identity) return; // in flight
      rehydrating.current = identity;
      const reviewId = surface.reviewId;
      void bridge
        .invoke("review.load", { commandId: crypto.randomUUID(), reviewId })
        .then((result) => {
          rehydrating.current = null;
          setReview(result.review);
          setRepositoryPresent(result.repositoryPresent);
        })
        .catch((reason: unknown) => {
          rehydrating.current = null;
          setError(reason instanceof Error ? reason.message : String(reason));
          navigate(discardNavigationTip());
        });
      return;
    }
    if (surface.kind === "project") {
      if (projectDetail && projectDetail.id === surface.projectId) return; // already loaded
      if (rehydrating.current === identity) return; // in flight
      rehydrating.current = identity;
      void loadProjectDetail(surface.projectId)
        .then(() => {
          rehydrating.current = null;
        })
        .catch((reason: unknown) => {
          rehydrating.current = null;
          setError(reason instanceof Error ? reason.message : String(reason));
          navigate(discardNavigationTip());
        });
    }
    // The Projects root needs no data — nothing to rehydrate.
  }, [currentSurface, review, projectDetail, bridge]);

  // The reviewer's appearance scheme (wireframe #15), fetched once so the front
  // door themes to it. Settings updates it live via `onSchemeChange`. Fail-quiet:
  // an unavailable settings surface leaves the builtin `system` default.
  useEffect(() => {
    bridge
      .invoke("settings.get", {})
      .then(({ scheme: loaded, keybindings }) => {
        setScheme(loaded);
        if (keybindings) setKeybindingOverrides(keybindings);
      })
      .catch(() => undefined);
  }, [bridge]);

  // `system` resolves through the OS via `prefers-color-scheme`, live: an OS
  // appearance change re-themes the app without a reload. `matchMedia` is guarded
  // for the (test / SSR) case where it is absent, defaulting to dark.
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
  // The single resolved scheme every app-level surface renders in. `system` folds
  // to the live OS value here, so every screen inherits ONE answer.
  const effectiveScheme: "dark" | "light" =
    scheme === "light" ? "light" : scheme === "dark" ? "dark" : systemDark ? "dark" : "light";

  // Apply the resolved scheme to the document ROOT, so every surface inherits it.
  useEffect(() => {
    document.documentElement.setAttribute("data-scheme", effectiveScheme);
  }, [effectiveScheme]);

  const patchset = useMemo(() => (review ? activePatchset(review) : undefined), [review]);
  // A GitHub-PR review is a SNAPSHOT of a pinned range, not the working tree, so
  // the working-tree freshness watcher below must not run against it.
  const isSnapshotReview =
    patchset?.source === "github-local" || patchset?.source === "github-rest";

  useEffect(() => {
    // A gone repository root (a reopened review, #324) is watched like a snapshot: no
    // working-tree freshness poll runs against a path that isn't there (D6).
    if (!review || review.status === "invalid" || isSnapshotReview || !repositoryPresent) return;
    let checking = false;
    const timer = window.setInterval(() => {
      if (checking) return;
      checking = true;
      bridge
        .invoke("review.checkFreshness", {
          commandId: crypto.randomUUID(),
          reviewId: review.id,
          repoPath: review.repositoryRoot,
        })
        .then(({ review: refreshed }) => setReview(refreshed))
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        )
        .finally(() => {
          checking = false;
        });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [bridge, review, isSnapshotReview, repositoryPresent]);

  // Capture a review of `path` on the CURRENT daemon and navigate into it. Shared by the
  // native pick (host path) and the WSL pending-capture below.
  const captureRepository = useCallback(
    async (path: string): Promise<void> => {
      const result = await bridge.invoke("review.capture", {
        commandId: crypto.randomUUID(),
        repoPath: path,
      });
      setReview(result.review);
      setRepositoryPresent(true); // a fresh capture/openPr always has its repo present
      setDirectEntryOpen(false);
      navigate(ascendNavigationTo(0));
      navigate(pushSurface({ kind: "review", reviewId: result.review.id }));
    },
    [bridge],
  );

  // WSL connect flow, receiving end: this app was just remounted onto a distro daemon and
  // carries the distro-native repo path the switch queued. Capture it once, then tell the host
  // to clear it (so a later manual switch back to this daemon does not re-capture).
  const pendingCaptured = useRef(false);
  useEffect(() => {
    if (!pendingRepoPath || pendingCaptured.current) return;
    pendingCaptured.current = true;
    setBusy(true);
    setError(undefined);
    captureRepository(pendingRepoPath)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false));
    onPendingRepoConsumed?.();
  }, [pendingRepoPath, captureRepository, onPendingRepoConsumed]);

  async function chooseRepository(): Promise<void> {
    // Pick a directory in-app (the native OS dialog is retired) BEFORE going busy.
    const picked = await pickDirectory("Choose a repository");
    if (!picked) return;
    setBusy(true);
    setError(undefined);
    try {
      // Grant the picked path on the current daemon (repository.choose forwards {path}).
      const { path } = await bridge.invoke("repository.choose", { path: picked });
      if (!path) return;
      // WSL connect flow: a directory inside a distro switches the whole app onto that
      // distro's daemon (a remount) and the remounted app captures the repo there.
      if (connectDaemonForPath) {
        const outcome = await connectDaemonForPath(path);
        if (outcome.error) {
          setError(outcome.error);
          return;
        }
        if (outcome.switched) return;
      }
      await captureRepository(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  // Open a review from a project-detail row (issue #37). A PR row targets the specific
  // pull request over `review.openPr`; a local-work row captures the project's tree.
  async function openRow(project: Project, row: SmartRow): Promise<void> {
    if (row.kind === "pr" && row.pr) {
      await openProjectPr(project, `${row.pr.repository}#${row.pr.number}`, row.readOnly);
      return;
    }
    await openProject(project);
  }

  async function openProjectPr(
    project: Project,
    ref: string,
    retrospective: boolean,
  ): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const result = await bridge.invoke("review.openPr", {
        commandId: crypto.randomUUID(),
        ref,
        repoPath: project.openPath,
        retrospective,
      });
      setReview(result.review);
      setRepositoryPresent(true); // a fresh capture/openPr always has its repo present
      navigate(pushSurface({ kind: "review", reviewId: result.review.id }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function openProject(project: Project): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const result = await bridge.invoke("review.capture", {
        commandId: crypto.randomUUID(),
        repoPath: project.openPath,
      });
      setReview(result.review);
      setRepositoryPresent(true); // a fresh capture/openPr always has its repo present
      navigate(pushSurface({ kind: "review", reviewId: result.review.id }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  // Open a pull request into a review (the front door's second source). The user
  // types the ref and MAIN resolves the clone itself. Only when the automatic clone
  // fails does the directory dialog appear as the fallback.
  async function openPullRequest(): Promise<void> {
    const ref = prRef.trim();
    if (!ref) return;
    setBusy(true);
    setError(undefined);
    try {
      let repoPath: string | undefined;
      try {
        await openPrRef(ref, repoPath);
        return;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (!message.includes("Pick a local clone")) throw reason;
        // Clone-on-demand could not clone the repo; fall back to the in-app picker.
        const picked = await pickDirectory("Pick a local clone", "Use this clone");
        if (!picked) return;
        const { path } = await bridge.invoke("repository.choose", { path: picked });
        if (!path) return;
        repoPath = path;
      }
      await openPrRef(ref, repoPath);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function openPrRef(ref: string, repoPath: string | undefined): Promise<void> {
    const result = await bridge.invoke("review.openPr", {
      commandId: crypto.randomUUID(),
      ref,
      ...(repoPath === undefined ? {} : { repoPath }),
      // Read-only when the reviewer asked to review the PR retrospectively.
      retrospective: prRetrospective,
    });
    setReview(result.review);
    setRepositoryPresent(true); // a fresh capture/openPr always has its repo present
    setDirectEntryOpen(false);
    navigate(ascendNavigationTo(0));
    navigate(pushSurface({ kind: "review", reviewId: result.review.id }));
  }

  function goToProjects(): void {
    setDirectEntryOpen(false);
    navigate(ascendNavigationTo(0));
  }

  // Load a project's detail substrate + its row in the projects list (issue #37),
  // shared by the palette's `goToRecent` and the landing rehydrator (#324).
  async function loadProjectDetail(projectId: string): Promise<void> {
    const detail = await bridge.invoke("project.detail", { projectId });
    const { projects } = await bridge.invoke("projects.list", {});
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project ${projectId} is no longer available.`);
    setProjectDetail(project);
    setProjectDetailData(detail);
  }

  async function goToRecent(surface: RecentSurface): Promise<void> {
    if (surface.kind === "projects") {
      goToProjects();
      return;
    }
    setError(undefined);
    try {
      await loadProjectDetail(surface.projectId);
      setDirectEntryOpen(false);
      navigate(ascendNavigationTo(0));
      navigate(pushSurface(surface));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const projectSurfaceIndex = navigation.stack
    .map((surface) => surface.kind)
    .lastIndexOf("project");
  const surfaceLabels: SurfaceLabels = {
    project: (id) => (projectDetail?.id === id ? projectDetail.name : undefined),
    review: (id) => (review?.id === id ? review.repositoryRoot : undefined),
  };
  function goToProject(): void {
    if (projectSurfaceIndex < 0) return;
    setDirectEntryOpen(false);
    navigate(ascendNavigationTo(projectSurfaceIndex));
  }

  // Which top-level surface is showing — mirrors the surface at the stack's tip,
  // so the palette offers exactly the commands live for the current screen.
  const screen: Screen | null =
    review === undefined
      ? null
      : directEntryOpen
        ? "directEntry"
        : currentSurface.kind === "projects"
          ? "frontDoor"
          : currentSurface.kind === "project"
            ? "projectDetail"
            : "workspace";
  const commandContext: CommandContext | null = screen
    ? {
        screen,
        surfaceKind: currentSurface.kind,
        currentSurface,
        recents,
        surfaceLabels,
        canBack: navigation.stack.length > 1,
        canForward: navigation.future.length > 0,
        canGoToProject: projectSurfaceIndex >= 0,
        retrospective: review?.retrospective === true,
        back: goBack,
        forward: goForward,
        goToProjects,
        goToProject,
        goToRecent: (surface) => void goToRecent(surface),
        openSettings: () => setSettingsOpen(true),
        reviewDirectly: () => setDirectEntryOpen(true),
        chooseRepository: () => void chooseRepository(),
      }
    : null;
  const builtCommands = commandContext ? buildCommands(commandContext) : [];
  // The palette-toggle is a registry command whose `run` is supplied here (like every
  // other handler). It is not emitted into the palette list itself, but it joins the
  // dispatch list so its ⌘K chord (remappable) routes through the same matcher.
  const paletteCommand: Command = commandFromCatalogue(
    "palette.toggle",
    commandContext ?? undefined,
    () => setPaletteOpen((open) => !open),
  );
  const dispatchCommands = [paletteCommand, ...builtCommands];
  // Publish the live dispatch list for the stable window keydown listener (above).
  dispatchRef.current = { commands: dispatchCommands, overrides: keybindingOverrides };

  // Host-app update readiness → badge on the chrome marks. Hosts without an
  // updater omit the member and this is a no-op (spec: desktop-update-notification).
  useEffect(() => {
    return bridge.onUpdateReady?.((info) => {
      useUpdateReady.getState().markReady(info);
    });
  }, [bridge]);
  const updatePrompt = <UpdateReadyPrompt onApply={() => bridge.applyUpdate?.()} />;
  // The in-app directory picker overlay (source-aware project selection). Portalled, so it
  // sits beside `updatePrompt` in every surface branch and settles the pending pick promise.
  const pickerModal = pickRequest ? (
    <DirectoryPickerModal
      bridge={bridge}
      title={pickRequest.title}
      confirmLabel={pickRequest.confirmLabel}
      onPick={(path) => {
        pickRequest.resolve(path);
        setPickRequest(null);
      }}
      onCancel={() => {
        pickRequest.resolve(null);
        setPickRequest(null);
      }}
    />
  ) : null;

  const palette = (
    <CommandPalette
      open={paletteOpen}
      commands={builtCommands}
      overrides={keybindingOverrides}
      onClose={() => setPaletteOpen(false)}
    />
  );

  function navigationSurface(content: ReactNode): ReactNode {
    return (
      <div className="navigation-shell min-h-screen bg-canvas text-ink">
        <header className="navigation-titlebar fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-canvas px-4 [[data-platform=darwin]_&]:pl-20">
          <ChromeMenu
            size={16}
            className="navigation-titlebar-mark flex flex-none items-center opacity-80"
            version={bridge.version}
            canBackToProjects={currentSurface.kind !== "projects"}
            onOpenSettings={() => setSettingsOpen(true)}
            onBackToProjects={() => {
              setSettingsOpen(false);
              goToProjects();
            }}
          />
          {/* History is a paired control: the rail is gone, back/forward live here. */}
          <div className="navigation-history flex flex-none items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="navigation-history-button text-ink-soft"
              aria-label="Back"
              title="Back"
              disabled={navigation.stack.length <= 1}
              onClick={goBack}
            >
              <Icon icon={ArrowLeft} className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="navigation-history-button text-ink-soft"
              aria-label="Forward"
              title="Forward"
              disabled={navigation.future.length === 0}
              onClick={goForward}
            >
              <Icon icon={ArrowRight} className="size-4" />
            </Button>
          </div>
          <Breadcrumb
            crumb={deriveCrumb(navigation.stack, surfaceLabels)}
            onAscend={(index) => {
              setDirectEntryOpen(false);
              navigate(ascendNavigationTo(index));
            }}
          />
          {patchset ? (
            <div className="navigation-titlebar-context ml-auto flex items-center gap-2">
              <code
                className="navigation-patchset-chip rounded-chip border border-line bg-surface px-2.5 py-1 font-mono text-xs text-ink-soft"
                title={patchset.id}
              >
                {patchset.id.slice(0, 12)}
              </code>
            </div>
          ) : null}
          {connectionSlot}
        </header>
        <div className="navigation-surface-content min-h-screen pt-14">{content}</div>
      </div>
    );
  }

  if (review === undefined) {
    return (
      <div className="navigation-shell min-h-screen bg-canvas text-ink">
        {updatePrompt}
        {pickerModal}
        <header className="navigation-titlebar fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-canvas px-4 [[data-platform=darwin]_&]:pl-20">
          <ChromeMenu
            size={16}
            className="navigation-titlebar-mark flex flex-none items-center opacity-80"
            version={bridge.version}
            canBackToProjects={currentSurface.kind !== "projects"}
            onOpenSettings={() => setSettingsOpen(true)}
            onBackToProjects={() => {
              setSettingsOpen(false);
              goToProjects();
            }}
          />
          <Breadcrumb crumb={deriveCrumb([{ kind: "projects" }])} onAscend={() => undefined} />
          {connectionSlot}
        </header>
        <div className="navigation-surface-content min-h-screen pt-14">
          <div className="loading px-8 py-10 font-serif text-base text-ink-soft">
            Restoring local review…
          </div>
        </div>
      </div>
    );
  }

  // Settings and direct entry are orbital overlays. They take render precedence but
  // never mutate the surface stack, so closing either reveals the exact location.
  if (settingsOpen) {
    return (
      <div className="navigation-shell min-h-screen bg-canvas text-ink">
        {updatePrompt}
        {pickerModal}
        <header className="navigation-titlebar fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-canvas px-4 [[data-platform=darwin]_&]:pl-20">
          <ChromeMenu
            size={16}
            className="navigation-titlebar-mark flex flex-none items-center opacity-80"
            version={bridge.version}
            canBackToProjects={currentSurface.kind !== "projects"}
            onOpenSettings={() => setSettingsOpen(true)}
            onBackToProjects={() => {
              setSettingsOpen(false);
              goToProjects();
            }}
          />
          <span className="text-sm text-ink-soft">Settings</span>
        </header>
        {error ? (
          <div className="error-toast fixed left-1/2 top-16 z-30 -translate-x-1/2 rounded-control border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
        <div className="navigation-surface-content min-h-screen pt-14">
          <SettingsScreen
            bridge={bridge}
            scheme={effectiveScheme}
            onBack={() => setSettingsOpen(false)}
            onSchemeChange={setScheme}
            onKeybindingsChange={setKeybindingOverrides}
          />
        </div>
      </div>
    );
  }

  if (directEntryOpen) {
    return (
      <div className="navigation-shell min-h-screen bg-canvas text-ink">
        {palette}
        {updatePrompt}
        {pickerModal}
        <header className="navigation-titlebar fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-canvas px-4 [[data-platform=darwin]_&]:pl-20">
          <ChromeMenu
            size={16}
            className="navigation-titlebar-mark flex flex-none items-center opacity-80"
            version={bridge.version}
            canBackToProjects={currentSurface.kind !== "projects"}
            onOpenSettings={() => setSettingsOpen(true)}
            onBackToProjects={() => {
              setSettingsOpen(false);
              goToProjects();
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="entry-back text-ink-soft"
            onClick={() => setDirectEntryOpen(false)}
          >
            <Icon icon={ArrowLeft} className="size-3.5" />
            Back
          </Button>
        </header>
        <main className="empty-state grid min-h-screen place-content-center justify-items-center bg-canvas p-8 pt-22 text-center">
          <div
            className="mark mb-4 grid size-[54px] place-items-center rounded-window border border-accent-line bg-accent-soft text-accent -rotate-[4deg]"
            aria-hidden="true"
          >
            <RennetBrandMark size={26} />
          </div>
          <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
            RENNET
          </p>
          <h1 className="my-2.5 max-w-[620px] font-display text-display font-medium tracking-tight text-ink">
            Start a review.
          </h1>
          <p className="max-w-[560px] leading-relaxed text-ink-soft">
            Capture local git changes into one patchset.
          </p>
          <Button
            size="lg"
            className="mt-4 disabled:cursor-wait"
            disabled={busy}
            onClick={chooseRepository}
          >
            <Icon icon={Folder} className="size-4" />
            {busy ? "Working…" : "Choose a repository"}
          </Button>

          <div
            className="entry-divider mb-1 mt-6 flex w-[min(440px,82vw)] items-center gap-3 text-xs uppercase tracking-wide text-ink-faint before:h-px before:flex-1 before:bg-line before:content-[''] after:h-px after:flex-1 after:bg-line after:content-['']"
            aria-hidden="true"
          >
            <span>or a pull request</span>
          </div>

          <form
            className="pr-door mt-3.5 flex w-[min(440px,82vw)] flex-wrap gap-2"
            onSubmit={(submitEvent) => {
              submitEvent.preventDefault();
              void openPullRequest();
            }}
          >
            <Input
              type="text"
              className="pr-input min-w-0 flex-1 font-mono"
              value={prRef}
              onChange={(inputEvent) => setPrRef(inputEvent.target.value)}
              placeholder="owner/repo#42  or  a GitHub PR URL"
              aria-label="Pull request reference"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={busy}
            />
            <Button
              type="submit"
              variant="outline"
              className="secondary whitespace-nowrap"
              disabled={busy || prRef.trim().length === 0}
            >
              {busy ? "Opening…" : "Open pull request"}
            </Button>
            <label className="pr-retrospective flex basis-full cursor-pointer items-start gap-2 text-left text-xs leading-snug text-ink-faint">
              <input
                type="checkbox"
                className="mt-0.5 flex-none"
                checked={prRetrospective}
                onChange={(inputEvent) => setPrRetrospective(inputEvent.target.checked)}
                disabled={busy}
              />
              <span>Retrospective review — read an already-merged PR. Nothing is posted back.</span>
            </label>
          </form>
          <p className="pr-hint mt-2.5 text-xs text-ink-faint">
            No clone needed — Rennet fetches the repository itself.
          </p>

          {error ? <p className="error text-danger">{error}</p> : null}
        </main>
      </div>
    );
  }

  // While a landed surface's content rehydrates (#324/#297) — its held review or
  // cached project detail does not yet match the tip — show the loading treatment
  // under the tip's OWN crumb. Never fall through to render another surface's content.
  const reviewTipId =
    currentSurface.kind === "review" ||
    currentSurface.kind === "draft" ||
    currentSurface.kind === "paper" ||
    currentSurface.kind === "handoff"
      ? currentSurface.reviewId
      : undefined;
  const surfaceRehydrating =
    (currentSurface.kind === "project" && projectDetail?.id !== currentSurface.projectId) ||
    (reviewTipId !== undefined && review?.id !== reviewTipId);
  if (surfaceRehydrating) {
    return navigationSurface(
      <>
        {error ? (
          <div className="error-toast fixed left-1/2 top-3.5 z-10 -translate-x-1/2 rounded-control border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
        <div className="loading px-8 py-10 font-serif text-base text-ink-soft">Reopening…</div>
      </>,
    );
  }

  // Project detail (issue #37): clicking a project row opens its unified smart list —
  // local work + every PR in one surface. Its payload stays cached while a child
  // review is open, so Back can reveal this exact parent surface without refetching.
  if (currentSurface.kind === "project" && projectDetail?.id === currentSurface.projectId) {
    return navigationSurface(
      <>
        {error ? (
          <div className="error-toast fixed left-1/2 top-3.5 z-10 -translate-x-1/2 rounded-control border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
        {busy ? (
          <div className="busy-bar fixed left-0 top-0 z-[11] h-0.5 w-[35%] bg-accent-fill" />
        ) : null}
        <ProjectDetail
          key={projectDetail.id}
          bridge={bridge}
          project={projectDetail}
          initialDetail={projectDetailData ?? undefined}
          scheme={effectiveScheme}
          onOpenRow={(row) => void openRow(projectDetail, row)}
          onOpenContextMap={() =>
            navigate(pushSurface({ kind: "contextMap", projectId: projectDetail.id }))
          }
          onBack={() => navigate(navigateBack())}
        />
        {palette}
        {updatePrompt}
        {pickerModal}
      </>,
    );
  }

  // The Context Map surface (change add-context-map-view): a per-project view of the
  // Repo Map — structure, the knowledge layer, and a project-scoped ask rail.
  if (currentSurface.kind === "contextMap") {
    return navigationSurface(
      <>
        {error ? (
          <div className="error-toast fixed left-1/2 top-3.5 z-10 -translate-x-1/2 rounded-control border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
        <ContextMapView
          key={currentSurface.projectId}
          bridge={bridge}
          projectId={currentSurface.projectId}
          onBack={() => navigate(navigateBack())}
        />
        {palette}
        {updatePrompt}
        {pickerModal}
      </>,
    );
  }

  // The front door is the root surface. Direct entry remains available through the
  // palette, but no longer has a drawn door on this surface.
  if (currentSurface.kind === "projects" || !review) {
    return navigationSurface(
      <>
        {error ? (
          <div className="error-toast fixed left-1/2 top-3.5 z-10 -translate-x-1/2 rounded-control border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
        {busy ? (
          <div className="busy-bar fixed left-0 top-0 z-[11] h-0.5 w-[35%] bg-accent-fill" />
        ) : null}
        <FrontDoor
          bridge={bridge}
          sources={sources}
          activeSource={activeSource}
          connectSource={connectSource}
          pendingSourceBrowse={pendingSourceBrowse}
          onPendingSourceBrowseConsumed={onPendingSourceBrowseConsumed}
          pendingAddPath={pendingAddPath}
          onPendingAddConsumed={onPendingAddConsumed}
          logWslConnect={logWslConnect}
          onOpenProject={(project) => {
            setProjectDetail(project);
            setProjectDetailData(null);
            navigate(pushSurface({ kind: "project", projectId: project.id }));
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          scheme={effectiveScheme}
        />
        {palette}
        {updatePrompt}
        {pickerModal}
      </>,
    );
  }

  // A review-family surface (review/draft/paper/handoff). The canvas review surface was
  // deleted delete-first (B2, #489); the route renders the stub placeholder until Track
  // C rebuilds it on the Board. The worktree-gone status stays honest above it.
  return navigationSurface(
    <>
      {error ? (
        <div className="error-toast fixed left-1/2 top-3.5 z-10 -translate-x-1/2 rounded-control border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}
      {busy ? (
        <div className="busy-bar fixed left-0 top-0 z-[11] h-0.5 w-[35%] bg-accent-fill" />
      ) : null}
      {!repositoryPresent ? (
        <div
          className="worktree-gone-status border-b border-line bg-surface px-6 py-3 text-sm text-ink-soft"
          role="status"
        >
          The original worktree is gone — showing the review as captured.
        </div>
      ) : null}
      <ReviewWorkspace review={review} />
      {palette}
      {updatePrompt}
      {pickerModal}
    </>,
  );
}
