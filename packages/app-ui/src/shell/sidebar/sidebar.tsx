import type { UpdateReadyInfo } from "@rennet/protocol";
import {
  Button,
  Collapse,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Kbd,
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  toast,
} from "@rennet/ui";
import {
  Archive,
  Check,
  ChevronDown,
  CircleHelp,
  FolderPlus,
  Layers,
  Loader2,
  Map as MapIcon,
  MessageSquarePlus,
  Monitor,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Settings2,
  Trash2,
} from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useCoachOptional } from "../../coach/context";
import { Icon } from "../../components/icon";
import { useUpdateReady } from "../../components/update-ready";
import { useBridge } from "../../data";
import {
  archivedPath,
  newChatPath,
  projectMapPath,
  projectSettingsPath,
  sessionPath,
  settingsPath,
} from "../../routes/url";
import { useRennetStore } from "../../store";
import { CornerSlot, useMacTrafficLights } from "../corner-slot";
import {
  type SidebarProject,
  type SidebarSession,
  useActiveRoute,
  useRemoveProject,
  useSidebarSessionProjection,
  useSidebarTree,
} from "../sidebar-data";
import { RennetLockup } from "./lockup";
import { TargetIcon } from "./target-icon";

// ─────────────────────────────────────────────────────────────────────────────
// The app sidebar (C03 §2–3, R35 rewrite — autopsy S5 dies here). ZERO props at
// EVERY boundary: `Sidebar` is a thin width-shell over four SELF-WIRING regions —
// `SidebarActions`, `SidebarTree`, `SidebarFooter`, and the collapsed `Rail` — each
// resolving its own tree (through `sidebar-data`), fold state (the `ui` slice),
// active-route highlight (`useActiveRoute`, the one shared resolution), mutations
// (the seam), and navigation (`routes/url.ts`). Nothing is drilled between them, so
// no single component carries the whole sidebar's wiring (the autopsy anti-pattern).
//
// One persistent `<aside>` animates 256px panel ↔ 48px rail; the content swaps
// inside it, and both states carry the collapse control. Sessions are B9's
// projection — until it lands the live client shows an honest empty state and the
// row/mutation proofs run over the projection context (reconciliation 2).
// ─────────────────────────────────────────────────────────────────────────────

const DOCS_URL = "https://docs.rennet.dev";
const ISSUES_URL = "https://github.com/rbutera/rennet/issues/new";

/** The Update dialog — driven by the real `UpdateReadyInfo`, listing exactly what it
 *  carries (just the version today; no invented bullets — reconciliation 7). */
function UpdateDialog({
  info,
  open,
  onOpenChange,
  onApply,
}: {
  readonly info: UpdateReadyInfo;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onApply: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Available</DialogTitle>
          <DialogDescription>
            {info.version
              ? `Rennet ${info.version} is downloaded and ready. Restart to apply it.`
              : "A new version of Rennet is downloaded and ready. Restart to apply it."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Later</DialogClose>
          <Button onClick={onApply}>Update Now</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The Update control — self-wiring: it subscribes to the host's update-ready channel
 *  (so the badge appears the moment one lands), owns its own dialog open-state, and
 *  renders NOTHING until an update is ready. `variant` picks the rail icon vs the
 *  labelled panel button. Both rail and panel drop in `<UpdateControl>`; neither
 *  threads update state around. */
function UpdateControl({ variant }: { readonly variant: "rail" | "panel" }) {
  const bridge = useBridge();
  const updateReady = useUpdateReady((s) => s.ready);
  const markReady = useUpdateReady((s) => s.markReady);
  const [open, setOpen] = useState(false);
  useEffect(() => bridge.onUpdateReady?.((info) => markReady(info)), [bridge, markReady]);
  if (!updateReady) return null;
  const trigger =
    variant === "rail" ? (
      <button
        type="button"
        aria-label="Update Available"
        title="Update Available"
        onClick={() => setOpen(true)}
        className="flex size-7 items-center justify-center rounded-chip bg-update text-update-ink transition-colors hover:brightness-110"
      >
        <Icon icon={RefreshCw} className="size-4" />
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 items-center gap-1.5 rounded-chip bg-update px-2.5 text-sm font-medium text-update-ink transition-colors hover:brightness-110"
      >
        <Icon icon={RefreshCw} className="size-3.5 shrink-0" />
        <span>Update</span>
      </button>
    );
  return (
    <>
      {trigger}
      <UpdateDialog
        info={updateReady}
        open={open}
        onOpenChange={setOpen}
        onApply={() => {
          bridge.applyUpdate?.();
          setOpen(false);
        }}
      />
    </>
  );
}

/** The Help popover — Documentation, Keyboard Shortcuts (→ keybindings settings),
 *  Replay Tour (C13 wires the re-arm), Report an Issue. No "Contact support". */
function HelpPopover({
  trigger,
  align = "start",
}: {
  readonly trigger: ReactElement;
  readonly align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  // The coach store re-arms the tour on Replay. Optional: null in the brief window before
  // the provider's store exists (it awaits `settings.get`), so the row disables until then
  // rather than throwing — no gate, just an honestly-inert control until it can act.
  const coach = useCoachOptional();
  const rowClass =
    "flex h-8 items-center rounded-chip px-2 text-left text-sm text-ink-soft transition-colors hover:bg-raised hover:text-ink";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align={align} className="w-52 gap-0.5 p-1">
        <PopoverHeader className="px-2 pt-1">
          <PopoverTitle className="text-xs text-ink-soft">Help</PopoverTitle>
        </PopoverHeader>
        <a href={DOCS_URL} target="_blank" rel="noreferrer" className={rowClass}>
          Documentation
        </a>
        <button
          type="button"
          className={rowClass}
          onClick={() => {
            setOpen(false);
            navigate(settingsPath("keybindings"));
          }}
        >
          Keyboard Shortcuts
        </button>
        {/* Replay Tour re-arms the coach marks: clears seen + skip-all and re-elects the
            first mark on a live surface (C13). Inert only until the store exists. */}
        <button
          type="button"
          className={rowClass}
          disabled={!coach}
          onClick={() => {
            setOpen(false);
            coach?.store.getState().replay();
          }}
        >
          Replay Tour
        </button>
        <a href={ISSUES_URL} target="_blank" rel="noreferrer" className={rowClass}>
          Report an Issue
        </a>
      </PopoverContent>
    </Popover>
  );
}

/** The searchable New-Chat project picker (kit Command in a Popover), with a
 *  "New Project" escape. Picking navigates to the project's new-chat route. */
function NewChatPicker({
  trigger,
  projects,
  onPick,
  onNewProject,
}: {
  readonly trigger: ReactNode;
  readonly projects: readonly SidebarProject[];
  readonly onPick: (projectId: string) => void;
  readonly onNewProject: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger as ReactElement} />
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search projects" />
          <CommandList>
            <CommandEmpty>No projects found.</CommandEmpty>
            <CommandGroup heading="Projects">
              {projects.map((project) => (
                <CommandItem
                  key={project.id}
                  value={project.name}
                  onSelect={() => {
                    setOpen(false);
                    onPick(project.id);
                  }}
                >
                  <Icon icon={Layers} className="size-3.5 text-ink-soft" />
                  <span>{project.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="New Project"
                onSelect={() => {
                  setOpen(false);
                  onNewProject();
                }}
              >
                <Icon icon={FolderPlus} className="size-3.5 text-ink-soft" />
                <span>New Project</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** One session line — used by the project list AND the Pinned section. Highlight is
 *  DERIVED (`active`), never stored; inline rename keeps the target icon showing. */
function SessionRow({
  session,
  sublabel,
  active,
  onOpen,
  onArchive,
}: {
  readonly session: SidebarSession;
  readonly sublabel: string;
  readonly active: boolean;
  readonly onOpen: () => void;
  readonly onArchive: () => void;
}) {
  const projection = useSidebarSessionProjection();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Take focus + select the instant the field opens (the a11y-safe form of autoFocus).
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    el?.focus();
    el?.select();
  }, [editing]);

  function commit() {
    // An emptied title keeps the old one (R67).
    projection.renameSession(session.id, draft.trim() || session.title);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex min-h-8 items-center gap-1.5 rounded-chip bg-raised px-2 py-1">
        {/* Reviewed keeps the plain target icon (the tick is a separate glyph, R36). */}
        <TargetIcon
          kind={session.target}
          state={session.targetState === "reviewed" ? undefined : session.targetState}
          className="size-3"
        />
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              event.stopPropagation();
              setEditing(false);
            }
          }}
          aria-label="Session name"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
        />
      </div>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="flex flex-col" />}>
        <button
          type="button"
          onClick={onOpen}
          aria-current={active}
          className={cn(
            "flex min-h-8 w-full flex-col justify-center gap-0.5 rounded-chip px-2 py-1 text-left transition-colors hover:bg-raised",
            active && "bg-raised",
          )}
        >
          <span className="flex items-center gap-1.5">
            {/* The leading icon is always the target KIND (accent when needs-you);
                reviewed is a separate green tick beside the title, not a recolor (R36). */}
            <TargetIcon
              kind={session.target}
              state={session.targetState === "reviewed" ? undefined : session.targetState}
              className="size-3"
            />
            <span
              className={cn(
                "truncate text-sm leading-tight",
                active ? "text-ink" : "text-ink-soft",
              )}
            >
              {session.title}
            </span>
            {session.targetState === "reviewed" ? (
              <Icon
                icon={Check}
                aria-label="Reviewed"
                aria-hidden={false}
                className="size-3 shrink-0 text-green"
              />
            ) : null}
            {session.pinned ? (
              <Icon
                icon={Pin}
                aria-label="Pinned"
                aria-hidden={false}
                className="size-3 shrink-0 text-ink-faint"
              />
            ) : null}
            {/* Unread orchestrator activity — verdigris, the machine's register. The
                ACTIVE row never shows it: being there means it has been read. */}
            {session.unread && !active ? (
              <span
                role="img"
                className="size-1.5 shrink-0 rounded-full bg-model"
                aria-label="Unread updates"
              />
            ) : null}
          </span>
          <span className="pl-[18px] text-2xs text-ink-faint">{sublabel}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => projection.setSessionPinned(session.id, !session.pinned)}>
          <Icon icon={session.pinned ? PinOff : Pin} />
          {session.pinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            setDraft(session.title);
            setEditing(true);
          }}
        >
          <Icon icon={Pencil} />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={onArchive}>
          <Icon icon={Archive} />
          Archive
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The collapsed rail — Search over New Chat at the top; Update, Help, Settings
 *  bottom-anchored in that order (R15/R16). Self-wiring: no drilled props. */
function Rail() {
  const mac = useMacTrafficLights();
  const setSidebarOpen = useRennetStore((s) => s.uiActions.setSidebarOpen);
  const setCommandMenuOpen = useRennetStore((s) => s.uiActions.setCommandMenuOpen);
  const openDialog = useRennetStore((s) => s.uiActions.openDialog);
  const [, navigate] = useLocation();
  const { hosts } = useSidebarTree();
  const projects = hosts.flatMap((host) => host.projects);
  const iconBtn =
    "flex size-7 items-center justify-center rounded-chip text-ink-soft transition-colors hover:bg-raised hover:text-ink";
  return (
    // The 48px rail is NARROWER than the traffic-light zone, so on macOS the only
    // clearance available is vertical: push the stack below the lights (32px, vs
    // the 8px `py-2` every other host keeps).
    <div className={cn("flex h-full w-12 flex-col items-center py-2", mac && "pt-8")}>
      <button
        type="button"
        onClick={() => setSidebarOpen(true)}
        aria-label="Expand sidebar"
        className={cn(iconBtn, "mb-2")}
      >
        <Icon icon={PanelLeft} className="size-3.5" />
      </button>
      <nav className="flex flex-col items-center gap-1" aria-label="App">
        <button
          type="button"
          aria-label="Search"
          title="Search"
          onClick={() => setCommandMenuOpen(true)}
          className={iconBtn}
        >
          <Icon icon={Search} className="size-4" />
        </button>
        <NewChatPicker
          projects={projects}
          onPick={(id) => navigate(newChatPath(id))}
          onNewProject={() => openDialog("add-project")}
          trigger={
            <button type="button" aria-label="New Chat" title="New Chat" className={iconBtn}>
              <Icon icon={MessageSquarePlus} className="size-4" />
            </button>
          }
        />
      </nav>
      <div className="mt-auto flex flex-col items-center gap-1">
        <UpdateControl variant="rail" />
        <HelpPopover
          trigger={
            <button type="button" aria-label="Help" title="Help" className={iconBtn}>
              <Icon icon={CircleHelp} className="size-4" />
            </button>
          }
        />
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={() => navigate(settingsPath("appearance"))}
          className={iconBtn}
        >
          <Icon icon={Settings} className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** The expanded action block: Search → New Chat → Add Project → Add Environment. */
function SidebarActions() {
  const setCommandMenuOpen = useRennetStore((s) => s.uiActions.setCommandMenuOpen);
  const openDialog = useRennetStore((s) => s.uiActions.openDialog);
  const [, navigate] = useLocation();
  const { hosts } = useSidebarTree();
  const projects = hosts.flatMap((host) => host.projects);
  const rowClass =
    "flex h-8 items-center gap-2 rounded-chip px-2 text-left text-sm text-ink-soft transition-colors hover:bg-raised hover:text-ink";
  return (
    <div className="flex flex-col gap-0.5 px-2">
      <button type="button" onClick={() => setCommandMenuOpen(true)} className={rowClass}>
        <Icon icon={Search} className="size-3.5 shrink-0" />
        <span className="flex-1">Search</span>
        <Kbd>⌘P</Kbd>
      </button>
      <NewChatPicker
        projects={projects}
        onPick={(id) => navigate(newChatPath(id))}
        onNewProject={() => openDialog("add-project")}
        trigger={
          <button type="button" className={rowClass}>
            <Icon icon={MessageSquarePlus} className="size-3.5 shrink-0" />
            <span>New Chat</span>
          </button>
        }
      />
      <button type="button" onClick={() => openDialog("add-project")} className={rowClass}>
        <Icon icon={FolderPlus} className="size-3.5 shrink-0" />
        <span>Add Project</span>
      </button>
      <button type="button" onClick={() => openDialog("add-environment")} className={rowClass}>
        <Icon icon={Plus} className="size-3.5 shrink-0" />
        <span>Add Environment</span>
      </button>
    </div>
  );
}

/** The tree — Pinned (only when non-empty), then host groups with their projects and
 *  sessions. Self-wiring: tree, folds, projection mutations, active-route highlight. */
function SidebarTree() {
  const folds = useRennetStore((s) => s.ui.sidebarFolds);
  const toggleFold = useRennetStore((s) => s.uiActions.toggleFold);
  const setChatOpen = useRennetStore((s) => s.uiActions.setChatOpen);
  const [, navigate] = useLocation();
  const { hosts } = useSidebarTree();
  const projection = useSidebarSessionProjection();
  const removeProject = useRemoveProject();
  const { activeSlug, activeProjectId, standingIn } = useActiveRoute();

  const projects = hosts.flatMap((host) => host.projects);
  const pinned = projects.flatMap((project) =>
    project.sessions
      .filter((s) => s.pinned && !s.archived)
      .map((session) => ({ session, project })),
  );

  function openSession(session: SidebarSession) {
    setChatOpen(true);
    navigate(sessionPath(session.slug));
  }

  function archiveSession(session: SidebarSession) {
    projection.archiveSession(session.id);
    // Archiving the session you are viewing pulls it out of the tree — move on.
    if (session.slug === activeSlug) navigate(newChatPath());
  }

  // Remove a project directly from the menu (Rule Zero: no confirmation ceremony). The
  // command can REJECT (daemon down, IPC fault) — await it, and navigate away ONLY on
  // success. A false "it's gone" while the daemon still holds it is a lie; on failure
  // the row stays and the reviewer is told, honestly, that nothing was removed.
  async function removeProjectNow(project: SidebarProject) {
    const standing = standingIn(project.id);
    try {
      await removeProject(project.id);
    } catch (error) {
      toast.add({
        title: `Couldn’t remove ${project.name}`,
        description: error instanceof Error ? error.message : String(error),
        type: "error",
      });
      return;
    }
    if (standing) navigate(newChatPath());
  }

  return (
    <div className="mt-5 flex min-h-0 flex-1 flex-col overflow-y-auto px-2">
      <div className="flex flex-col gap-0.5 pb-2">
        {pinned.length > 0 ? (
          <div className="flex flex-col">
            <div className="flex h-6 items-center gap-1.5 px-2">
              <Icon icon={Pin} className="size-3 shrink-0 text-accent" />
              <span className="truncate text-2xs font-medium uppercase tracking-wide text-ink-faint">
                Pinned
              </span>
            </div>
            {pinned.map(({ session, project }) => (
              <SessionRow
                key={session.id}
                session={session}
                sublabel={`${project.name} · ${session.time}`}
                active={session.slug === activeSlug}
                onOpen={() => openSession(session)}
                onArchive={() => archiveSession(session)}
              />
            ))}
          </div>
        ) : null}

        {hosts.map((host) => (
          <div key={host.id} className="flex flex-col pt-5 first:pt-0">
            <div className="flex h-6 items-center gap-1.5 px-2">
              <Icon
                icon={host.kind === "local" ? Monitor : Server}
                className="size-3 shrink-0 text-ink-faint"
              />
              <span className="truncate text-2xs font-medium uppercase tracking-wide text-ink-faint">
                {host.label}
              </span>
            </div>

            {host.projects.map((project) => {
              const expanded = folds[project.id] !== true || project.id === activeProjectId;
              const activeCount = project.sessions.filter((s) => !s.archived).length;
              return (
                <ContextMenu key={project.id}>
                  <ContextMenuTrigger render={<div className="flex flex-col" />}>
                    <button
                      type="button"
                      onClick={() => toggleFold(project.id)}
                      aria-expanded={expanded}
                      className="flex h-7 w-full items-center gap-1.5 rounded-chip px-2 text-left text-sm text-ink-soft transition-colors hover:bg-raised"
                    >
                      <Icon
                        icon={ChevronDown}
                        className={cn(
                          "size-3 shrink-0 text-ink-faint transition-transform",
                          !expanded && "-rotate-90",
                        )}
                      />
                      <Icon icon={Layers} className="size-3.5 shrink-0 text-ink-faint" />
                      <span className="flex-1 truncate">{project.name}</span>
                      {project.indexing ? (
                        <span className="flex items-center gap-1 text-2xs text-ink-faint">
                          <Icon icon={Loader2} className="size-3 animate-spin" />
                          indexing
                        </span>
                      ) : (
                        <span className="text-2xs text-ink-faint">{activeCount}</span>
                      )}
                    </button>

                    <Collapse open={expanded}>
                      {/* biome-ignore lint/a11y/noStaticElementInteractions: stops the row context menu leaking to session rows. */}
                      <div
                        className="ml-3 flex flex-col gap-0.5 border-l border-line pb-1 pl-2"
                        onContextMenu={(event) => event.stopPropagation()}
                      >
                        {project.sessions
                          .filter((session) => !session.archived)
                          .map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              sublabel={session.time}
                              active={session.slug === activeSlug}
                              onOpen={() => openSession(session)}
                              onArchive={() => archiveSession(session)}
                            />
                          ))}
                        <button
                          type="button"
                          onClick={() => navigate(newChatPath(project.id))}
                          className="group/newchat flex h-7 items-center gap-1.5 rounded-chip px-2 text-left text-xs text-ink-faint transition-colors hover:bg-accent-soft hover:text-accent"
                        >
                          <Icon
                            icon={Plus}
                            className="size-3 shrink-0 transition-transform duration-200 group-hover/newchat:rotate-90"
                          />
                          <span>New Chat</span>
                        </button>
                      </div>
                    </Collapse>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => navigate(projectMapPath(project.id))}>
                      <Icon icon={MapIcon} />
                      View Context Map
                    </ContextMenuItem>
                    {/* Project rename is omitted until B9 supplies the real rename
                        seam — an inert editor that snaps the name back is worse than
                        no action (a live no-op lies about what happened). */}
                    <ContextMenuItem onClick={() => navigate(projectSettingsPath(project.id))}>
                      <Icon icon={Settings2} />
                      Project Settings
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      onClick={() => void removeProjectNow(project)}
                    >
                      <Icon icon={Trash2} />
                      Remove project
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The footer — Archived (when > 0), then Update · Help · Settings (C03 order, the
 *  rail's top-to-bottom order read left-to-right). Self-wiring. */
function SidebarFooter() {
  const [, navigate] = useLocation();
  const { hosts } = useSidebarTree();
  const archivedCount = hosts
    .flatMap((host) => host.projects)
    .reduce((count, project) => count + project.sessions.filter((s) => s.archived).length, 0);
  return (
    <div className="flex flex-col gap-0.5 border-t border-line px-2 py-2">
      {archivedCount > 0 ? (
        <button
          type="button"
          onClick={() => navigate(archivedPath())}
          className="flex h-8 items-center gap-2 rounded-chip px-2 text-left text-sm text-ink-soft transition-colors hover:bg-raised hover:text-ink"
        >
          <Icon icon={Archive} className="size-3.5 shrink-0" />
          <span className="flex-1">Archived</span>
          <span className="text-2xs text-ink-faint">{archivedCount}</span>
        </button>
      ) : null}
      <div className="flex items-center gap-1">
        <UpdateControl variant="panel" />
        <HelpPopover
          trigger={
            <button
              type="button"
              aria-label="Help"
              title="Help"
              className="flex size-8 shrink-0 items-center justify-center rounded-chip text-ink-soft transition-colors hover:bg-raised hover:text-ink"
            >
              <Icon icon={CircleHelp} className="size-3.5" />
            </button>
          }
        />
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={() => navigate(settingsPath("appearance"))}
          className="flex size-8 shrink-0 items-center justify-center rounded-chip text-ink-soft transition-colors hover:bg-raised hover:text-ink"
        >
          <Icon icon={Settings} className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export function Sidebar() {
  const mac = useMacTrafficLights();
  const open = useRennetStore((s) => s.ui.sidebarOpen);
  const asideRef = useRef<HTMLElement>(null);
  const firstRun = useRef(true);
  // Collapsing/expanding swaps the panel subtree for the rail (or back), UNMOUNTING
  // whichever toggle held focus — the browser then drops focus to <body>. When that
  // happens, hand focus to the counterpart toggle so keyboard operation survives the
  // swap. Guarded to the focus-was-dropped case, so a toggle fired while focus lived
  // elsewhere never has focus yanked into the sidebar; skipped on first mount.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const aside = asideRef.current;
    if (!aside) return;
    const active = aside.ownerDocument.activeElement;
    if (active && active !== aside.ownerDocument.body) return;
    const label = open ? "Collapse sidebar" : "Expand sidebar";
    aside.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.focus();
  }, [open]);
  return (
    <aside
      ref={asideRef}
      data-region="sidebar"
      data-open={open}
      className={cn(
        "rennet-sidebar h-full shrink-0 overflow-hidden border-r border-line bg-surface transition-[width] duration-200 ease-out motion-reduce:transition-none",
        open ? "w-64" : "w-12",
      )}
    >
      {open ? (
        <div className="flex h-full min-h-0 w-64 flex-col">
          {/* Header — state 1's corner slot: lights → wordmark → toggle (C20).
              The 76px light reserve, the `navigation-titlebar` drag rule and the
              collapse toggle all live in `CornerSlot` now; the lockup is the real
              scheme-swapped vector artwork (never a font), dropped 16px → 14px on
              darwin so it still clears the toggle inside the 256px panel (#557). */}
          <CornerSlot
            owner="sidebar"
            wordmark={<RennetLockup size={mac ? 14 : 16} className="w-auto" />}
          />
          <SidebarActions />
          <SidebarTree />
          <SidebarFooter />
        </div>
      ) : (
        <Rail />
      )}
    </aside>
  );
}
