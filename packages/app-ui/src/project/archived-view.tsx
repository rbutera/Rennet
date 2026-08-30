import { ArchiveRestore, ArrowLeft, Check, Inbox, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Icon } from "../components/icon";
import { newChatPath, sessionPath } from "../routes/url";
import { ProjectIcon } from "../settings/assets/project-icon";
import { Segmented } from "../settings/atoms";
import { useSettingsProjection } from "../settings/data/projections";
import { TargetIcon } from "../shell/sidebar/target-icon";
import {
  type SidebarProject,
  type SidebarSession,
  useSidebarSessionProjection,
  useSidebarTree,
} from "../shell/sidebar-data";

// ─────────────────────────────────────────────────────────────────────────────
// The archived-sessions view (C10 §9, /archived — enriching C12's minimal list).
// A main-surface takeover, like Settings: back/Esc leave to the front door, the
// sidebar stays mounted underneath. This is a sibling route, NOT a settings page.
//
// Sessions live in the sidebar's session projection, served off `session.list` (no fake
// session protocol here, and none was ever added while it was empty). This view reads the
// same projected tree the sidebar does, lists its archived rows, and lets you search
// (by session title OR project name), sort (recent / project / title), open a row
// (routes to the session), or unarchive it. Unarchive calls the projection's
// `restoreSession`, returning the row to the live sidebar — release is archive-only, a
// target is reclaimable by archiving its session, never deleted here. Project glyphs
// come from the C10 settings projection (`glyphByProject`, default `layers`).
// ─────────────────────────────────────────────────────────────────────────────

type SortKey = "recent" | "project" | "title";

const SORT_OPTIONS: readonly { readonly id: SortKey; readonly label: string }[] = [
  { id: "recent", label: "Recent" },
  { id: "project", label: "Project" },
  { id: "title", label: "Title" },
];

/** Parse the fuzzy sidebar times ("now", "1h", "2d", "3w") into minutes, for a real
 *  recency order. An unrecognised token sorts to the far end rather than throwing. */
function timeToMinutes(time: string): number {
  if (time === "now") return 0;
  if (time === "yesterday") return 24 * 60;
  const match = /^(\d+)([mhdw])$/.exec(time);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const value = Number(match[1]);
  const unit = { m: 1, h: 60, d: 24 * 60, w: 7 * 24 * 60 }[match[2] as "m" | "h" | "d" | "w"];
  return value * unit;
}

export function ArchivedView() {
  const [, navigate] = useLocation();
  const { hosts } = useSidebarTree();
  const { restoreSession } = useSidebarSessionProjection();
  const { glyphByProject } = useSettingsProjection();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const back = () => navigate(newChatPath());

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // A bare Escape leaves the view; an Escape inside the search field with text in it
      // is handled there (it clears the search and stops before this listener).
      if (event.key === "Escape") navigate(newChatPath());
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  const all = hosts.flatMap((host) =>
    host.projects.flatMap((project) =>
      project.sessions
        .filter((session) => session.archived)
        .map((session) => ({ session, project })),
    ),
  );

  const q = query.trim().toLowerCase();
  const shown = all
    .filter(
      ({ session, project }) =>
        !q || session.title.toLowerCase().includes(q) || project.name.toLowerCase().includes(q),
    )
    .sort((a, b) => {
      if (sort === "project") {
        return (
          a.project.name.localeCompare(b.project.name) ||
          timeToMinutes(a.session.time) - timeToMinutes(b.session.time)
        );
      }
      if (sort === "title") return a.session.title.localeCompare(b.session.title);
      return timeToMinutes(a.session.time) - timeToMinutes(b.session.time);
    });

  return (
    <section
      data-screen="archived"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-canvas"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <button
          type="button"
          onClick={back}
          aria-label="Back"
          className="flex size-6 items-center justify-center rounded-control text-ink-faint hover:bg-raised hover:text-ink"
        >
          <Icon icon={ArrowLeft} className="size-3.5" />
        </button>
        <span className="text-sm font-medium text-ink">Archived</span>
        {all.length > 0 ? <span className="text-2xs text-ink-faint">{all.length}</span> : null}
        <kbd className="ml-auto rounded-chip border border-line px-1.5 py-0.5 text-2xs text-ink-faint">
          esc
        </kbd>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-8 py-8">
          {all.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-24 text-center">
              <Icon icon={Inbox} className="size-5 text-ink-faint" />
              <span className="text-sm text-ink-soft">Nothing archived.</span>
              <span className="text-xs text-ink-faint">
                Right-click a session in the sidebar to archive it.
              </span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className="flex h-8 flex-1 items-center gap-2 rounded-control border border-line bg-raised px-2 focus-within:border-accent-line">
                  <Icon icon={Search} className="size-3.5 shrink-0 text-ink-faint" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      // Escape clears the search BEFORE it can bubble to the window
                      // listener that would close the view (claim 681).
                      if (event.key === "Escape" && query) {
                        event.stopPropagation();
                        setQuery("");
                      }
                    }}
                    placeholder="Search archived sessions…"
                    aria-label="Search archived sessions"
                    className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
                  />
                </div>
                <Segmented
                  ariaLabel="Sort by"
                  options={SORT_OPTIONS}
                  value={sort}
                  onChange={setSort}
                />
              </div>

              {shown.length === 0 ? (
                <span className="px-2 py-6 text-center text-sm text-ink-soft">
                  No archived sessions match “{query.trim()}”.
                </span>
              ) : (
                <div className="flex flex-col divide-y divide-line rounded-surface border border-line">
                  {shown.map(({ session, project }) => (
                    <ArchivedRow
                      key={session.id}
                      session={session}
                      project={project}
                      glyph={glyphByProject[project.id]}
                      onSelect={() => navigate(sessionPath(session.slug))}
                      onUnarchive={() => restoreSession(session.id)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function ArchivedRow({
  session,
  project,
  glyph,
  onSelect,
  onUnarchive,
}: {
  readonly session: SidebarSession;
  readonly project: SidebarProject;
  readonly glyph?: Parameters<typeof ProjectIcon>[0]["icon"];
  readonly onSelect: () => void;
  readonly onUnarchive: () => void;
}) {
  const reviewed = session.targetState === "reviewed";
  return (
    <div className="group flex items-center gap-3 px-3 py-2.5 hover:bg-raised">
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
      >
        <span className="flex items-center gap-1.5">
          {/* Show the target-TYPE glyph (branch / PR), then a separate reviewed tick —
              never collapse the two, so a reviewed row still reads as its target kind. */}
          <TargetIcon
            kind={session.target}
            state={reviewed ? undefined : session.targetState}
            className="size-3"
          />
          <span className="truncate text-sm text-ink">{session.title}</span>
          {reviewed ? (
            <Icon icon={Check} className="size-3 shrink-0 text-green" aria-label="Reviewed" />
          ) : null}
        </span>
        <span className="pl-[18px] text-2xs text-ink-faint">{session.time}</span>
      </button>
      <span className="flex shrink-0 items-center gap-1.5 rounded-chip border border-line px-2 py-0.5 text-xs text-ink-soft">
        <ProjectIcon icon={glyph} className="size-3" />
        {project.name}
      </span>
      <button
        type="button"
        onClick={onUnarchive}
        className="flex shrink-0 items-center gap-1.5 rounded-control px-2 py-1 text-xs text-ink-soft opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Icon icon={ArchiveRestore} className="size-3.5" />
        Unarchive
      </button>
    </div>
  );
}
