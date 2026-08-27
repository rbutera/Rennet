import type { RennetBridge } from "@rennet/protocol";
import { useEffect, useState } from "react";
import { Redirect, Route, Router, Switch, useLocation, useSearch } from "wouter";
import { ReviewWorkspace } from "../app/review-workspace-route";
import { BridgeProvider, useCommand } from "../data";
import { ArchivedView } from "../project/archived-view";
import { ProjectContextMapView } from "../project/context-map-view";
import { IndexingView } from "../project/indexing/indexing-view";
import { NewChatView } from "../project/new-chat-view";
import { RunRoute } from "../rounds/run-route";
import {
  LiveSettingsProjectionProvider,
  PriorSurfaceTracker,
  SettingsScreen,
  ThemePrefProvider,
} from "../settings";
import type { RennetHistory } from "./history";
import { AppLayout } from "./layout";
import { useSlugResolution } from "./slug";
import { newChatPath, ROUTES, settingsPath } from "./url";

// ─────────────────────────────────────────────────────────────────────────────
// RennetRouterApp (C01 §4) — the router foundation the later Track-C surfaces mount
// into. It wires the injected history + bridge and the #480 route table onto the
// persistent layout (sidebar + chat-dock slot outside the outlet). The screens here are
// INTERIM: they read real commands through the data seam and render minimal-but-honest
// content, and C3–C13 replace each with its full surface. The two incumbent screens with
// no #480 row (front-door list, project detail) mount at interim routes (reconciliation 2).
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

/** The `/new-chat` route. With a `?project=` it is the C12 New Chat view (target
 *  picker + composer for that project); without one, the interim front-door list. */
function NewChatScreen() {
  const search = useSearch();
  const project = new URLSearchParams(search).get("project");
  if (project) return <NewChatView projectId={project} />;
  return <NewChatFrontDoor />;
}

/** The front-door entry (interim, reconciliation 2) — reads the real projects list. */
function NewChatFrontDoor() {
  const { data, pending } = useCommand("projects.list", {});
  const [, navigate] = useLocation();
  return (
    <section
      data-screen="new-chat"
      className="mx-auto grid min-h-screen max-w-[720px] content-start gap-4 p-10"
    >
      <h1 className="font-display text-display font-medium text-ink">Start a review.</h1>
      {pending ? (
        <p className="text-ink-soft">Loading projects…</p>
      ) : data && data.projects.length > 0 ? (
        <ul className="grid gap-1">
          {data.projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="text-ink underline-offset-2 hover:underline"
                onClick={() => navigate(newChatPath(p.id))}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-soft">No projects yet — add one to begin.</p>
      )}
      <button
        type="button"
        className="justify-self-start text-ink-soft underline-offset-2 hover:underline"
        onClick={() => navigate(settingsPath("appearance"))}
      >
        Settings
      </button>
    </section>
  );
}

/** A session route (#480 `/s/:slug`) — resolves the slug through the seam (B9 swap in
 *  `useSlugResolution`) and renders the review workspace, or an honest not-found. */
function SessionScreen({ slug }: { readonly slug: string }) {
  const resolution = useSlugResolution(slug);
  if (resolution.status === "pending") {
    return <p className="p-10 font-serif text-ink-soft">Opening…</p>;
  }
  if (resolution.status === "not-found") return <NotFound label={`session “${slug}”`} />;
  if (resolution.status === "error") return <LoadError slug={slug} error={resolution.error} />;
  return <ReviewWorkspace review={resolution.review} />;
}

/**
 * App-wide appearance (wireframe #15): the reviewer's saved scheme is applied to the
 * document ROOT, so EVERY surface inherits it — not only the screens that thread a
 * `scheme` prop. `system` resolves live through the OS `prefers-color-scheme`, so an
 * OS appearance change re-themes without a reload. Mounts under `BridgeProvider`
 * (reads `settings.get` through the seam) and renders nothing — a pure synchronizer.
 * This restores what the deleted legacy shell owned, lost in the router cutover.
 */
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
      <ThemePrefProvider>
        <Router hook={history?.hook} searchHook={history?.searchHook}>
          <PriorSurfaceTracker>
            {/* The live settings projection is mounted ABOVE the route switch, so a
                reader's per-session agent enablement (the `disabled` set) survives
                leaving and reopening Settings — it resets only on a full app remount
                (a reload), which is the spec (C10 §10.2). Settings is a route-local
                takeover; wrapping it there would drop the state on every exit. */}
            <LiveSettingsProjectionProvider>
              <AppLayout>
                <Switch>
                  <Route path={ROUTES.home}>
                    <Redirect to={ROUTES.newChat} />
                  </Route>
                  <Route path={ROUTES.newChat} component={NewChatScreen} />
                  <Route path={ROUTES.sessionRun}>{(p) => <RunRoute slug={p.slug ?? ""} />}</Route>
                  <Route path={ROUTES.session}>
                    {(p) => <SessionScreen slug={p.slug ?? ""} />}
                  </Route>
                  <Route path={ROUTES.archived}>
                    <ArchivedView />
                  </Route>
                  <Route path={ROUTES.projectIndexing}>
                    {(p) => <IndexingView projectId={p.id ?? ""} />}
                  </Route>
                  <Route path={ROUTES.projectMap}>
                    {(p) => <ProjectContextMapView projectId={p.id ?? ""} />}
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
            </LiveSettingsProjectionProvider>
          </PriorSurfaceTracker>
        </Router>
      </ThemePrefProvider>
    </BridgeProvider>
  );
}
