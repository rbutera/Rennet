import type { Project, SidebarSession as WireSidebarSession } from "@rennet/protocol";
import { useMemo } from "react";
import { useRoute } from "wouter";
import { useCommand, useMutation } from "../data";
import { ROUTES } from "../routes/url";
import { selectProcessingProjectIds, useRennetStore } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// The sidebar's SINGLE data-resolution point (C03, proposal reconciliation 2).
//
// The sidebar takes no props; every row it renders and every mutation it fires
// resolves HERE, so the seam wiring lives in one file. Two halves, two lifetimes:
//
//  • PROJECTS — real today. `projects.list` reads the tree, `projects.remove`
//    forgets a project (both live protocol commands). Bound through the data seam
//    (`useCommand` / `useMutation`), so invalidation is uniform.
//
//  • SESSIONS + their mutations (rename / pin / archive / restore) and
//    `project.rename` — real since C18. `session.list` serves the persisted session
//    store's rows; each mutation is a served write that invalidates the list, so a
//    rename, a pin, an archive, and a restore all survive reload. The rows carry only
//    FACTS of the stored session: a target the claim proves, and no invented
//    unread/needs-you state.
// ─────────────────────────────────────────────────────────────────────────────

/** The unified review-target vocabulary (R36 icon language). Location (the host) is
 *  the sidebar grouping, never a target label. BROADER than the wire it reads: the served
 *  `SidebarSession.target` is `your-branch | your-pr` only — `sidebarSessionOf` splits on
 *  whether the claim carries a PR number and never emits `teammate-pr` — so that member,
 *  and its icon, are reachable from a fixture and not from a live row. */
export type SessionTarget = "your-branch" | "your-pr" | "teammate-pr";
export type SessionTargetState = "needs-you" | "merged" | "reviewed";

export const TARGET_LABEL: Record<SessionTarget, string> = {
  "your-branch": "Your branch",
  "your-pr": "Your PR",
  "teammate-pr": "Teammate PR",
};

export interface SidebarSession {
  readonly id: string;
  /** The `/s/:slug` the row opens (id-as-slug until #466 durable identity, per slug.ts). */
  readonly slug: string;
  readonly title: string;
  /** The muted relative-time second line. */
  readonly time: string;
  readonly target: SessionTarget;
  readonly targetState?: SessionTargetState;
  readonly pinned?: boolean;
  readonly archived?: boolean;
  /** Unread orchestrator activity — the verdigris dot (never on the active row). */
  readonly unread?: boolean;
}

export interface SidebarProject {
  readonly id: string;
  readonly name: string;
  /** The `org/repo` identity an emptied rename falls back to (R67). */
  readonly fallbackName: string;
  /** True while the project is still being processed (spinner + "indexing"). */
  readonly indexing?: boolean;
  readonly sessions: readonly SidebarSession[];
}

export interface SidebarHost {
  readonly id: string;
  readonly label: string;
  readonly kind: "local" | "remote";
  readonly projects: readonly SidebarProject[];
}

// ── The session projection (live over `session.*`, C18) ──────────────────────

export interface SidebarSessionProjection {
  /** Sessions keyed by projectId, from the persisted session store. */
  readonly sessionsByProject: Readonly<Record<string, readonly SidebarSession[]>>;
  /** Projects still processing (spinner + "indexing"); the live client reads this off
   *  the `ui` slice instead, so the served projection leaves it absent. */
  readonly indexingProjectIds?: readonly string[];
  renameSession(id: string, title: string): void;
  setSessionPinned(id: string, pinned: boolean): void;
  archiveSession(id: string): void;
  /** Un-archive: returns the session to the live sidebar (release is archive-only). */
  restoreSession(id: string): void;
  renameProject(id: string, name: string): Promise<void>;
}

/** The compact age line a session row shows (`now` / `5m` / `2h` / `1d` / `3w`) — the
 *  vocabulary the archived view's sort already parses. Derived from the stored
 *  `createdAt`, so the wire carries a timestamp and the surface owns the wording. */
export function compactAge(createdAt: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - createdAt) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/** One served row → the sidebar's row. `slug` is the session id (id-as-slug until #466
 *  durable identity, per slug.ts); `time` is derived here, never sent over the wire. */
function toSidebarSession(row: WireSidebarSession): SidebarSession {
  return {
    id: row.id,
    slug: row.id,
    title: row.title,
    time: compactAge(row.createdAt),
    target: row.target,
    ...(row.targetState ? { targetState: row.targetState } : {}),
    ...(row.unread ? { unread: true } : {}),
    ...(row.pinned ? { pinned: true } : {}),
    ...(row.archived ? { archived: true } : {}),
  };
}

/**
 * The sidebar's sessions and their writes, live over `session.*` (C18). Every mutation
 * invalidates `session.list`, so the row re-reads what was actually STORED rather than an
 * optimistic guess — a refused write leaves the row where it was. `renameProject` is the
 * same shape over `project.rename`, invalidating `projects.list`.
 */
export function useSidebarSessionProjection(): SidebarSessionProjection {
  const { data } = useCommand("session.list", {});
  const { mutate: rename } = useMutation("session.rename", { invalidates: ["session.list"] });
  const { mutate: setPinned } = useMutation("session.setPinned", {
    invalidates: ["session.list"],
  });
  const { mutate: setArchived } = useMutation("session.archive", {
    invalidates: ["session.list"],
  });
  const { mutate: renameProjectCommand } = useMutation("project.rename", {
    invalidates: ["projects.list"],
  });
  return useMemo(() => {
    const sessionsByProject: Record<string, SidebarSession[]> = {};
    for (const row of data?.sessions ?? []) {
      const rows = sessionsByProject[row.projectId] ?? [];
      rows.push(toSidebarSession(row));
      sessionsByProject[row.projectId] = rows;
    }
    // A rejected write leaves the sidebar as it was — the invalidated read is the honest
    // answer, and nothing here paints a success the store did not record.
    const swallow = () => undefined;
    return {
      sessionsByProject,
      renameSession: (id, title) => void rename({ sessionId: id, title }).catch(swallow),
      setSessionPinned: (id, pinned) => void setPinned({ sessionId: id, pinned }).catch(swallow),
      archiveSession: (id) => void setArchived({ sessionId: id, archived: true }).catch(swallow),
      restoreSession: (id) => void setArchived({ sessionId: id, archived: false }).catch(swallow),
      renameProject: (id, name) =>
        renameProjectCommand({ projectId: id, name }).then(() => undefined),
    };
  }, [data, rename, setPinned, setArchived, renameProjectCommand]);
}

// ── Projects tree (real: projects.list) ──────────────────────────────────────

/** The host a project's source groups under. Local is the machine; every non-local
 *  source (`remote:<id>`, `wsl:<distro>`) is a remote host labelled by its tail —
 *  no IP, no "daemon" (R3/R13). */
function hostForSource(source: string): { id: string; label: string; kind: "local" | "remote" } {
  if (source === "local") return { id: "local", label: "This machine", kind: "local" };
  const label = source.includes(":") ? source.slice(source.indexOf(":") + 1) : source;
  return { id: source, label: label || source, kind: "remote" };
}

/** The `org/repo` identity a rename falls back to (R67): the last two path segments of
 *  the project's location (parent/repo), the closest org/repo the wire carries — the
 *  Project shape has no explicit remote. Falls back to the whole path if it has fewer. */
function orgRepo(path: string): string {
  const parts = path.split(/[/\\]+/).filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

function buildHosts(
  projects: readonly Project[],
  projection: SidebarSessionProjection,
  processingProjectIds: readonly string[],
): SidebarHost[] {
  // The live client's indexing spinner rides the `ui` slice's processing set (C12's
  // flow); the projection's `indexingProjectIds` remains for B9's session projection.
  const indexing = new Set([...(projection.indexingProjectIds ?? []), ...processingProjectIds]);
  const byHost = new Map<
    string,
    { label: string; kind: "local" | "remote"; rows: SidebarProject[] }
  >();
  const order: string[] = [];
  for (const project of projects) {
    const host = hostForSource(project.source ?? "local");
    let bucket = byHost.get(host.id);
    if (!bucket) {
      bucket = { label: host.label, kind: host.kind, rows: [] };
      byHost.set(host.id, bucket);
      order.push(host.id);
    }
    bucket.rows.push({
      id: project.id,
      name: project.name,
      fallbackName: orgRepo(project.openPath || project.path),
      indexing: indexing.has(project.id),
      sessions: projection.sessionsByProject[project.id] ?? [],
    });
  }
  return order.map((id) => {
    const bucket = byHost.get(id);
    if (!bucket) throw new Error(`sidebar host bucket missing for ${id}`);
    return { id, label: bucket.label, kind: bucket.kind, projects: bucket.rows };
  });
}

export interface SidebarTree {
  readonly hosts: readonly SidebarHost[];
  readonly loading: boolean;
}

/** The whole sidebar tree: real projects grouped by host, sessions from the
 *  projection (served off `session.list` in the live client). */
export function useSidebarTree(): SidebarTree {
  const { data, pending } = useCommand("projects.list", {});
  const projection = useSidebarSessionProjection();
  const processing = useRennetStore(selectProcessingProjectIds);
  const hosts = useMemo(
    () => buildHosts(data?.projects ?? [], projection, processing),
    [data, projection, processing],
  );
  return { hosts, loading: pending };
}

// ── Active-route resolution (shared) ──────────────────────────────────────────

/** What the current location says is active — the single derivation the sidebar's
 *  actions, tree, and footer all read from, instead of each re-parsing the route. */
export interface ActiveRoute {
  /** The slug of the open session route (`/s/:slug`, or its `/run`), else null. */
  readonly activeSlug: string | null;
  /** The project that owns the active session, else null. */
  readonly activeProjectId: string | null;
  /** True when the location is "inside" a project (its session, map, or indexing). */
  standingIn(projectId: string): boolean;
}

/** Resolve the active session/project from the route + the live tree. One place owns
 *  the wouter parsing and the slug→project lookup, so nothing drills it around. */
export function useActiveRoute(): ActiveRoute {
  const [, sessionParams] = useRoute(ROUTES.session);
  const [, runParams] = useRoute(ROUTES.sessionRun);
  const [onMap, mapParams] = useRoute(ROUTES.projectMap);
  const [onIndexing, indexingParams] = useRoute(ROUTES.projectIndexing);
  const { hosts } = useSidebarTree();
  const activeSlug = sessionParams?.slug
    ? decodeURIComponent(sessionParams.slug)
    : runParams?.slug
      ? decodeURIComponent(runParams.slug)
      : null;
  const projects = hosts.flatMap((host) => host.projects);
  const activeProjectId = activeSlug
    ? (projects.find((p) => p.sessions.some((s) => s.slug === activeSlug))?.id ?? null)
    : null;
  const standingIn = (projectId: string): boolean => {
    if (onMap && mapParams?.id === projectId) return true;
    if (onIndexing && indexingParams?.id === projectId) return true;
    return activeProjectId === projectId;
  };
  return { activeSlug, activeProjectId, standingIn };
}

/** The real `projects.remove` mutation — forgets a project, invalidating the tree.
 *  The working tree on disk is untouched (the command's own contract). */
export function useRemoveProject(): (projectId: string) => Promise<void> {
  // `settings.get` carries the removed project's settings row too, so it is staled with
  // the tree — a forgotten project must not leave a row behind on the settings surface.
  const { mutate } = useMutation("projects.remove", {
    invalidates: ["projects.list", "settings.get"],
  });
  return async (projectId: string) => {
    await mutate({ commandId: crypto.randomUUID(), projectId });
  };
}
