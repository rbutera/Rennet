import { useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { resolveProject } from "../../routes/project-resolution";
import { settingsPath } from "../../routes/url";
import { useActiveRoute, useSidebarTree } from "../../shell/sidebar-data";
import { GuidanceSection } from "./guidance";
import { IdentitySection } from "./identity";
import { TrackerSection } from "./issue-tracker";
import { ProjectPicker } from "./project-picker";
import { RepositorySection } from "./repository";
import { WorktreeSection } from "./worktrees";

// ─────────────────────────────────────────────────────────────────────────────
// The Projects settings page (C10 §8). DUAL-SOURCE: real projects from the live
// `projects.list` tree (identity + environment grouping, via `useSidebarTree`)
// composed with the per-project SETTINGS overlays from the projection (glyph, name,
// worktree, tracker, guidance) and the live repo row (`settings.get`) the Repository
// section reads. One inline picker scopes the page.
//
// THE STRUCTURAL RULE (autopsy S2): the scoped project is read from the `?project`
// query param — NEVER a shadowed `useState`. The picker emits a project id and the
// page NAVIGATES `?project`, so the URL is the single source of the active scope. The
// default follows the active project (the session in view), else the first project.
// ─────────────────────────────────────────────────────────────────────────────

export function ProjectsPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const { hosts, loading } = useSidebarTree();
  const { activeProjectId } = useActiveRoute();

  const requested = new URLSearchParams(search).get("project");
  const scopes = hosts.flatMap((host) => host.projects.map((project) => ({ project, host })));
  // ?project wins; else the active project (the session in view); else the first project.
  const resolved = resolveProject(
    scopes.map(({ project }) => project),
    requested,
    activeProjectId,
  );

  useEffect(() => {
    if (resolved && requested !== resolved.id) {
      navigate(settingsPath("projects", resolved.id), { replace: true });
    }
  }, [navigate, requested, resolved]);

  const scoped = scopes.find(({ project }) => project.id === resolved?.id);

  if (!scoped) {
    return (
      <section data-settings-page="projects" className="grid gap-2">
        <h2 className="text-sm font-medium text-ink">Projects</h2>
        <p className="max-w-[440px] text-xs text-ink-soft">
          {loading ? "Loading projects…" : "No projects yet — add one to begin."}
        </p>
      </section>
    );
  }

  const { project, host } = scoped;

  return (
    <div data-settings-page="projects" className="flex flex-col gap-8">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-ink">Project</span>
        <ProjectPicker
          hosts={hosts}
          value={project.id}
          onChange={(id) => navigate(settingsPath("projects", id), { replace: true })}
        />
      </div>

      <IdentitySection project={project} />
      <WorktreeSection project={project} />
      <RepositorySection project={project} host={host} />
      <TrackerSection project={project} host={host} />
      <GuidanceSection project={project} />
    </div>
  );
}
