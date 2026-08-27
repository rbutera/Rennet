import { ArchiveRestore, Inbox, MoveLeft } from "lucide-react";
import { useEffect } from "react";
import { useLocation } from "wouter";
import { Icon } from "../components/icon";
import { newChatPath } from "../routes/url";
import { TargetIcon } from "../shell/sidebar/target-icon";
import {
  type SidebarProject,
  type SidebarSession,
  useSidebarSessionProjection,
  useSidebarTree,
} from "../shell/sidebar-data";

// ─────────────────────────────────────────────────────────────────────────────
// The archived-sessions view (C12 §10, /archived). A main-surface takeover, like
// Settings: back/Esc leave to the front door, the sidebar stays mounted underneath.
//
// Sessions are B9-shaped — they live in the sidebar's session projection, EMPTY in
// the live client until B9 lands (no fake session protocol here). This view reads the
// same projected tree the sidebar does and lists its archived rows; Restore calls the
// projection's `restoreSession`, returning the row to the live sidebar. Release is
// archive-only — a target is reclaimable by archiving its session, never deleted here.
// ─────────────────────────────────────────────────────────────────────────────

export function ArchivedView() {
  const [, navigate] = useLocation();
  const { hosts } = useSidebarTree();
  const { restoreSession } = useSidebarSessionProjection();
  const back = () => navigate(newChatPath());

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") back();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const rows = hosts.flatMap((host) =>
    host.projects.flatMap((project) =>
      project.sessions
        .filter((session) => session.archived)
        .map((session) => ({ session, project })),
    ),
  );

  return (
    <section
      data-screen="archived"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-canvas"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <button
          type="button"
          onClick={back}
          aria-label="Back"
          className="flex size-7 items-center justify-center rounded-control text-ink-faint hover:bg-raised hover:text-ink"
        >
          <Icon icon={MoveLeft} className="size-4" />
        </button>
        <span className="text-sm font-medium text-ink">Archived</span>
        {rows.length > 0 ? <span className="text-2xs text-ink-faint">{rows.length}</span> : null}
        <kbd className="ml-auto rounded-chip border border-line px-1.5 py-0.5 text-2xs text-ink-faint">
          esc
        </kbd>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-8 py-8">
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-24 text-center">
              <Icon icon={Inbox} className="size-5 text-ink-faint" />
              <span className="text-sm text-ink-soft">Nothing archived.</span>
              <span className="text-xs text-ink-faint">
                Right-click a session in the sidebar to archive it.
              </span>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-line rounded-surface border border-line">
              {rows.map(({ session, project }) => (
                <ArchivedRow
                  key={session.id}
                  session={session}
                  project={project}
                  onRestore={() => restoreSession(session.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ArchivedRow({
  session,
  project,
  onRestore,
}: {
  readonly session: SidebarSession;
  readonly project: SidebarProject;
  readonly onRestore: () => void;
}) {
  return (
    <div className="group flex items-center gap-3 px-3 py-2.5 hover:bg-raised">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <TargetIcon kind={session.target} state={session.targetState} className="size-3" />
          <span className="truncate text-sm text-ink">{session.title}</span>
        </span>
        <span className="pl-[18px] text-2xs text-ink-faint">{session.time}</span>
      </div>
      <span className="shrink-0 rounded-chip border border-line px-2 py-0.5 text-xs text-ink-soft">
        {project.name}
      </span>
      <button
        type="button"
        onClick={onRestore}
        className="flex shrink-0 items-center gap-1.5 rounded-control px-2 py-1 text-xs text-ink-soft opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Icon icon={ArchiveRestore} className="size-3.5" />
        Restore
      </button>
    </div>
  );
}
