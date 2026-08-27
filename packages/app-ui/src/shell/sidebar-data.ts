import type { Project } from "@rennet/protocol";
import { createContext, useContext, useMemo } from "react";
import { useCommand, useMutation } from "../data";
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
//  • SESSIONS + their mutations (rename / pin / archive) and `project.rename` —
//    B9/B10's projection, which does NOT exist on main yet (protocol carries no
//    `session.*` and no `project.rename`; inventory-verified). Until it lands the
//    LIVE client shows an honest EMPTY session state (no fake rows, no invented
//    commands), and tests drive session rows + mutations through the projection
//    CONTEXT below. When B9 lands, the two `useSessionProjection`-backed reads
//    become `useCommand("session.list")` / `useMutation("session.*")` and the
//    context is deleted — THIS is the only file that changes.
// ─────────────────────────────────────────────────────────────────────────────

/** The unified review-target vocabulary (R36 icon language). Location (the host) is
 *  the sidebar grouping, never a target label. Defined here until B9's projection
 *  carries it in the wire. */
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

// ── The B9 session projection (stub context — reconciliation 2) ───────────────

export interface SidebarSessionProjection {
  /** Sessions keyed by projectId. Empty in the live client until B9's projection. */
  readonly sessionsByProject: Readonly<Record<string, readonly SidebarSession[]>>;
  /** Projects still processing (spinner + "indexing"); empty until the flow wires it. */
  readonly indexingProjectIds?: readonly string[];
  renameSession(id: string, title: string): void;
  setSessionPinned(id: string, pinned: boolean): void;
  archiveSession(id: string): void;
  /** Un-archive: returns the session to the live sidebar (release is archive-only). */
  restoreSession(id: string): void;
  renameProject(id: string, name: string): void;
}

/** The live client's projection: no sessions, no session mutations (honest empty).
 *  The mutations are genuine no-ops until B9 — there are no rows to mutate. */
const EMPTY_PROJECTION: SidebarSessionProjection = {
  sessionsByProject: {},
  renameSession: () => undefined,
  setSessionPinned: () => undefined,
  archiveSession: () => undefined,
  restoreSession: () => undefined,
  renameProject: () => undefined,
};

const SessionProjectionContext = createContext<SidebarSessionProjection>(EMPTY_PROJECTION);
/** Wraps a mount to supply session rows + mutations (tests until B9; deleted when B9 lands). */
export const SidebarSessionProjectionProvider = SessionProjectionContext.Provider;
export function useSidebarSessionProjection(): SidebarSessionProjection {
  return useContext(SessionProjectionContext);
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
      fallbackName: project.name,
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
 *  projection (empty in the live client until B9). */
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

/** The real `projects.remove` mutation — forgets a project, invalidating the tree.
 *  The working tree on disk is untouched (the command's own contract). */
export function useRemoveProject(): (projectId: string) => Promise<void> {
  const { mutate } = useMutation("projects.remove", { invalidates: ["projects.list"] });
  return async (projectId: string) => {
    await mutate({ commandId: crypto.randomUUID(), projectId });
  };
}
