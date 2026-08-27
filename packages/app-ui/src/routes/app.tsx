import type { RennetBridge } from "@rennet/protocol";
import { Redirect, Route, Router, Switch, useLocation } from "wouter";
import { ReviewWorkspace } from "../app/review-workspace-route";
import { BridgeProvider, useCommand } from "../data";
import { ArchivedView } from "../project/archived-view";
import { ProjectContextMapView } from "../project/context-map-view";
import { IndexingView } from "../project/indexing/indexing-view";
import type { RennetHistory } from "./history";
import { AppLayout } from "./layout";
import { useSlugResolution } from "./slug";
import { projectDetailPath, ROUTES, settingsPath } from "./url";

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

/** The front-door entry (interim, reconciliation 2) — reads the real projects list. */
function NewChatScreen() {
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
                onClick={() => navigate(projectDetailPath(p.id))}
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

/** The settings route (#480 `/settings/:page`) — interim, reads the real settings view. */
function SettingsScreen({ page }: { readonly page: string }) {
  const { data } = useCommand("settings.get", {});
  return (
    <section data-screen="settings" className="mx-auto max-w-[720px] p-10">
      <h1 className="font-display text-xl font-medium text-ink">Settings — {page}</h1>
      <p className="mt-2 text-ink-soft">{data ? `Scheme: ${data.scheme}` : "Loading settings…"}</p>
    </section>
  );
}

export interface RennetRouterAppProps {
  readonly bridge: RennetBridge;
  /** Injected history (hash / browser / memory). Omitted ⇒ the wouter browser default. */
  readonly history?: RennetHistory;
}

export function RennetRouterApp({ bridge, history }: RennetRouterAppProps) {
  return (
    <BridgeProvider bridge={bridge}>
      <Router hook={history?.hook} searchHook={history?.searchHook}>
        <AppLayout>
          <Switch>
            <Route path={ROUTES.home}>
              <Redirect to={ROUTES.newChat} />
            </Route>
            <Route path={ROUTES.newChat} component={NewChatScreen} />
            <Route path={ROUTES.sessionRun}>
              {(p) => <Interim screen="session-run" title={`Run — ${p.slug}`} />}
            </Route>
            <Route path={ROUTES.session}>{(p) => <SessionScreen slug={p.slug ?? ""} />}</Route>
            <Route path={ROUTES.archived}>
              <ArchivedView />
            </Route>
            <Route path={ROUTES.projectIndexing}>
              {(p) => <IndexingView projectId={p.id ?? ""} />}
            </Route>
            <Route path={ROUTES.projectMap}>
              {(p) => <ProjectContextMapView projectId={p.id ?? ""} />}
            </Route>
            <Route path={ROUTES.settings}>{(p) => <SettingsScreen page={p.page ?? ""} />}</Route>
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
      </Router>
    </BridgeProvider>
  );
}
