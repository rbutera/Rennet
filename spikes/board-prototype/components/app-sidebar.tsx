"use client"

import * as React from "react"
import {
  Archive,
  Check,
  Plus,
  Search,
  Settings,
  Settings2,
  PanelLeft,
  ChevronDown,
  MessageSquarePlus,
  FolderPlus,
  Monitor,
  Server,
  CircleHelp,
  Map as MapIcon,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Trash2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Collapse } from "@/components/collapse"
import { useAppStore } from "@/lib/store"
import { Spinner } from "@/components/ui/spinner"
import { TargetIcon } from "@/components/target-badge"
import { ProjectIcon } from "@/components/project-icon"
import type { HostItem, ProjectItem, SessionItem } from "@/lib/sidebar-data"
import type { SettingsPage } from "@/lib/settings-data"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

const HELP_ITEMS = ["Documentation", "Keyboard shortcuts", "Report an issue"]

function UpdateDialog({ trigger }: { trigger: React.ReactElement }) {
  return (
    <Dialog>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update available</DialogTitle>
          <DialogDescription>
            A new version of Rennet is ready to install. Restart the app to apply it.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc pl-4 text-[13px] leading-relaxed text-muted-foreground">
          <li>Faster tool-call streaming</li>
          <li>Composer reference badges</li>
          <li>Various stability fixes</li>
        </ul>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Later</DialogClose>
          <DialogClose render={<Button />}>Update now</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function HelpPopover({
  trigger,
  align = "start",
  onOpenSettings,
}: {
  trigger: React.ReactElement
  align?: "start" | "end"
  onOpenSettings: () => void
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align={align} className="w-52 p-1">
        <PopoverHeader className="px-2 pt-1.5">
          <PopoverTitle className="text-[13px]">Help</PopoverTitle>
        </PopoverHeader>
        <div className="flex flex-col">
          {HELP_ITEMS.map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                // Keyboard shortcuts live in the settings keybindings section (#476).
                if (label === "Keyboard shortcuts") {
                  setOpen(false)
                  onOpenSettings()
                }
              }}
              className="flex h-8 items-center rounded-md px-2 text-left text-[13px] text-foreground/90 transition-colors hover:bg-secondary"
            >
              {label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface AppSidebarProps {
  open: boolean
  onToggle: () => void
  hosts: HostItem[]
  onAddProject: () => void
  onAddRemote: () => void
  onOpenSettings: (page?: SettingsPage) => void
  onOpenProjectSettings: (projectId: string) => void
  onOpenMap: (projectId: string) => void
  onRenameProject: (projectId: string, name: string) => void
  onRemoveProject: (projectId: string) => void
  onNewChat: (projectId: string) => void
  onSelectSession: (sessionId: string) => void
  onTogglePinSession: (sessionId: string) => void
  onToggleArchiveSession: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string) => void
  onOpenArchived: () => void
}

/** One session line — used by the project list and Pinned. */
function SessionRow({
  session,
  sublabel,
  onSelect,
  onTogglePin,
  onToggleArchive,
  onRename,
}: {
  session: SessionItem
  sublabel: string
  onSelect: () => void
  onTogglePin: (sessionId: string) => void
  onToggleArchive: (sessionId: string) => void
  onRename: (sessionId: string, title: string) => void
}) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState("")

  function commit() {
    // An emptied title keeps the old one.
    onRename(session.id, draft.trim() || session.title)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex min-h-8 items-center gap-1.5 rounded-md bg-secondary px-2 py-1">
        <TargetIcon
          kind={session.target}
          state={session.targetState === "reviewed" ? undefined : session.targetState}
          className="size-3 shrink-0"
        />
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit()
            if (event.key === "Escape") {
              event.stopPropagation()
              setEditing(false)
            }
          }}
          aria-label="Session name"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none"
        />
      </div>
    )
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="flex flex-col" />}>
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            "flex min-h-8 w-full flex-col justify-center gap-0.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-secondary",
            session.active && "bg-secondary",
          )}
        >
          <span className="flex items-center gap-1.5">
            <TargetIcon
              kind={session.target}
              state={session.targetState === "reviewed" ? undefined : session.targetState}
              className="size-3"
            />
            <span
              className={cn(
                "truncate text-[13px] leading-tight",
                session.active ? "text-foreground" : "text-foreground/80",
              )}
            >
              {session.title}
            </span>
            {session.targetState === "reviewed" && (
              <Check className="size-3 shrink-0 text-green-500" aria-label="Reviewed" />
            )}
            {session.pinned && (
              <Pin className="size-2.5 shrink-0 text-muted-foreground/60" aria-label="Pinned" />
            )}
            {session.active && (
              <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
            )}
          </span>
          <span className="pl-[18px] text-[11px] text-muted-foreground">{sublabel}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onTogglePin(session.id)}>
          {session.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
          {session.pinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            setDraft(session.title)
            setEditing(true)
          }}
        >
          <Pencil aria-hidden="true" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onToggleArchive(session.id)}>
          <Archive aria-hidden="true" />
          Archive
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function NewChatPicker({
  trigger,
  projects,
  onNewProject,
  onPick,
}: {
  trigger: React.ReactNode
  projects: ProjectItem[]
  onNewProject: () => void
  onPick: (projectId: string) => void
}) {
  const [openPicker, setOpenPicker] = React.useState(false)

  return (
    <Popover open={openPicker} onOpenChange={setOpenPicker}>
      <PopoverTrigger render={trigger as React.ReactElement} />
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search projects" />
          <CommandList>
            <CommandEmpty>No projects found.</CommandEmpty>
            <CommandGroup heading="Projects">
              {projects.map((project) => (
                <CommandItem
                  key={project.id}
                  onSelect={() => {
                    setOpenPicker(false)
                    onPick(project.id)
                  }}
                >
                  <ProjectIcon icon={project.icon} className="size-3.5 text-muted-foreground" />
                  <span>{project.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  setOpenPicker(false)
                  onNewProject()
                }}
              >
                <FolderPlus className="size-3.5 text-muted-foreground" aria-hidden="true" />
                <span>New project</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function AppSidebar({
  open,
  onToggle,
  hosts,
  onAddProject,
  onAddRemote,
  onOpenSettings,
  onOpenProjectSettings,
  onOpenMap,
  onRenameProject,
  onRemoveProject,
  onNewChat,
  onSelectSession,
  onTogglePinSession,
  onToggleArchiveSession,
  onRenameSession,
  onOpenArchived,
}: AppSidebarProps) {
  const projects = React.useMemo(() => hosts.flatMap((host) => host.projects), [hosts])
  const pinnedSessions = projects.flatMap((project) =>
    project.sessions.filter((s) => s.pinned && !s.archived).map((session) => ({ session, project })),
  )
  const archivedCount = projects.reduce(
    (count, project) => count + project.sessions.filter((s) => s.archived).length,
    0,
  )
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {}
    for (const host of hosts) {
      for (const project of host.projects) {
        initial[project.id] = project.sessions.some((s) => s.active)
      }
    }
    return initial
  })
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [renameDraft, setRenameDraft] = React.useState("")
  const [removeTarget, setRemoveTarget] = React.useState<ProjectItem | null>(null)

  const toggleProject = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  // Keep the project holding the active session open so navigation (a minted
  // new-chat row, a picked session) always lands on a visible, highlighted row.
  React.useEffect(() => {
    const activeProject = projects.find((p) => p.sessions.some((s) => s.active))
    if (activeProject) {
      setExpanded((prev) => (prev[activeProject.id] ? prev : { ...prev, [activeProject.id]: true }))
    }
  }, [projects])

  function beginRename(project: ProjectItem) {
    setRenameDraft(project.name)
    setRenamingId(project.id)
  }

  function commitRename(project: ProjectItem) {
    // An emptied name falls back to the org/repo default.
    onRenameProject(project.id, renameDraft.trim() || project.repo)
    setRenamingId(null)
  }

  if (!open) {
    return (
      <div className="flex h-full w-12 shrink-0 flex-col items-center border-r border-border py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-label="Expand sidebar"
          className="mb-2 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <PanelLeft className="size-3.5" aria-hidden="true" />
        </button>
        <nav className="flex flex-col items-center gap-1" aria-label="App">
          <button
            type="button"
            aria-label="Search"
            title="Search"
            onClick={() => useAppStore.getState().setCommandOpen(true)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Search className="size-4" aria-hidden="true" />
          </button>
          <NewChatPicker
            projects={projects}
            onNewProject={onAddProject}
            onPick={onNewChat}
            trigger={
              <button
                type="button"
                aria-label="New chat"
                title="New chat"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <MessageSquarePlus className="size-4" aria-hidden="true" />
              </button>
            }
          />
        </nav>
        <div className="mt-auto flex flex-col items-center gap-1">
          <UpdateDialog
            trigger={
              <button
                type="button"
                aria-label="Update available"
                title="Update available"
                className="flex size-7 items-center justify-center rounded-md bg-update text-update-foreground transition-colors hover:bg-update/90"
              >
                <RefreshCw className="size-4" aria-hidden="true" />
              </button>
            }
          />
          <HelpPopover
            align="start"
            onOpenSettings={() => onOpenSettings("shortcuts")}
            trigger={
              <button
                type="button"
                aria-label="Help"
                title="Help"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <CircleHelp className="size-4" aria-hidden="true" />
              </button>
            }
          />
          <button
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={() => onOpenSettings()}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Settings className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-64 shrink-0 flex-col border-r border-border">
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <span className="text-[13px] font-medium tracking-tight text-foreground">Rennet</span>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse sidebar"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <PanelLeft className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      <div className="flex flex-col gap-0.5 px-2">
        <button
          type="button"
          onClick={() => useAppStore.getState().setCommandOpen(true)}
          className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Search className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="flex-1">Search</span>
          <kbd className="rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">
            ⌘P
          </kbd>
        </button>
        <NewChatPicker
          projects={projects}
          onNewProject={onAddProject}
          onPick={onNewChat}
          trigger={
            <button
              type="button"
              className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] text-foreground/90 transition-colors hover:bg-secondary"
            >
              <MessageSquarePlus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>New chat</span>
            </button>
          }
        />
        <button
          type="button"
          onClick={onAddProject}
          className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <FolderPlus className="size-3.5 shrink-0" aria-hidden="true" />
          <span>Add project</span>
        </button>
        <button
          type="button"
          onClick={onAddRemote}
          className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Plus className="size-3.5 shrink-0" aria-hidden="true" />
          <span>Add remote</span>
        </button>
      </div>

      <div className="mt-5 flex min-h-0 flex-1 flex-col overflow-y-auto px-2">
        <div className="flex flex-col gap-0.5 pb-2">
          {pinnedSessions.length > 0 && (
            <div className="flex flex-col">
              <div className="flex h-6 items-center gap-1.5 px-2">
                <Pin className="size-3 shrink-0 text-primary/70" aria-hidden="true" />
                <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  Pinned
                </span>
              </div>
              {pinnedSessions.map(({ session, project }) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  sublabel={`${project.name} · ${session.time}`}
                  onSelect={() => onSelectSession(session.id)}
                  onTogglePin={onTogglePinSession}
                  onToggleArchive={onToggleArchiveSession}
                  onRename={onRenameSession}
                />
              ))}
            </div>
          )}

          {hosts.map((host) => (
            <div key={host.id} className="flex flex-col pt-5 first:pt-0">
              <div className="flex h-6 items-center gap-1.5 px-2">
                {host.kind === "local" ? (
                  <Monitor className="size-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                ) : (
                  <Server className="size-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                )}
                <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  {host.label}
                </span>
              </div>

              {host.projects.map((project) => {
                const isExpanded = expanded[project.id]
                return (
                  <ContextMenu key={project.id}>
                  <ContextMenuTrigger render={<div className="flex flex-col" />}>
                    {renamingId === project.id ? (
                      <div className="flex h-7 items-center gap-1.5 rounded-md bg-secondary px-2">
                        <ChevronDown
                          className={cn(
                            "size-3 shrink-0 text-muted-foreground transition-transform",
                            !isExpanded && "-rotate-90",
                          )}
                          aria-hidden="true"
                        />
                        <ProjectIcon icon={project.icon} className="size-3.5 shrink-0 text-muted-foreground" />
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onFocus={(event) => event.target.select()}
                          onBlur={() => commitRename(project)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") commitRename(project)
                            if (event.key === "Escape") {
                              event.stopPropagation()
                              setRenamingId(null)
                            }
                          }}
                          aria-label="Project name"
                          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
                          placeholder={project.repo}
                        />
                      </div>
                    ) : (
                    <button
                      type="button"
                      onClick={() => toggleProject(project.id)}
                      aria-expanded={isExpanded}
                      className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] text-foreground/90 transition-colors hover:bg-secondary"
                    >
                      <ChevronDown
                        className={cn(
                          "size-3 shrink-0 text-muted-foreground transition-transform",
                          !isExpanded && "-rotate-90",
                        )}
                        aria-hidden="true"
                      />
                      <ProjectIcon icon={project.icon} className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate">{project.name}</span>
                      {project.indexing ? (
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Spinner className="size-3" />
                          indexing
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">
                          {project.sessions.filter((s) => !s.archived).length}
                        </span>
                      )}
                    </button>
                    )}

                    <Collapse open={isExpanded}>
                      <div
                        className="ml-3 flex flex-col gap-0.5 border-l border-border pb-1 pl-2"
                        onContextMenu={(event) => event.stopPropagation()}
                      >
                        {project.sessions
                          .filter((session) => !session.archived)
                          .map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              sublabel={session.time}
                              onSelect={() => onSelectSession(session.id)}
                              onTogglePin={onTogglePinSession}
                              onToggleArchive={onToggleArchiveSession}
                              onRename={onRenameSession}
                            />
                          ))}
                        <button
                          type="button"
                          onClick={() => onNewChat(project.id)}
                          className="group/newchat flex h-7 items-center gap-1.5 rounded-md px-2 text-left text-[12px] text-muted-foreground/60 transition-colors hover:bg-primary/10 hover:text-primary"
                        >
                          <Plus
                            className="size-3 shrink-0 transition-transform duration-200 group-hover/newchat:rotate-90"
                            aria-hidden="true"
                          />
                          <span>New chat</span>
                        </button>
                      </div>
                    </Collapse>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => onOpenMap(project.id)}>
                      <MapIcon aria-hidden="true" />
                      View context map
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => beginRename(project)}>
                      <Pencil aria-hidden="true" />
                      Rename
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => onOpenProjectSettings(project.id)}>
                      <Settings2 aria-hidden="true" />
                      Project settings
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem variant="destructive" onClick={() => setRemoveTarget(project)}>
                      <Trash2 aria-hidden="true" />
                      Remove project…
                    </ContextMenuItem>
                  </ContextMenuContent>
                  </ContextMenu>
                )
              })}
            </div>
          ))}

        </div>
      </div>

      <div className="flex flex-col gap-0.5 border-t border-border px-2 py-2">
        {archivedCount > 0 && (
          <button
            type="button"
            onClick={onOpenArchived}
            className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Archive className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="flex-1">Archived</span>
            <span className="text-[11px] text-muted-foreground">{archivedCount}</span>
          </button>
        )}
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={() => onOpenSettings()}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Settings className="size-3.5" aria-hidden="true" />
          </button>
          <HelpPopover
            align="start"
            onOpenSettings={() => onOpenSettings("shortcuts")}
            trigger={
              <button
                type="button"
                aria-label="Help"
                title="Help"
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <CircleHelp className="size-3.5" aria-hidden="true" />
              </button>
            }
          />
          <UpdateDialog
            trigger={
              <button
                type="button"
                className="ml-auto flex h-8 items-center gap-1.5 rounded-md bg-update px-2.5 text-[13px] font-medium text-update-foreground transition-colors hover:bg-update/90"
              >
                <RefreshCw className="size-3.5 shrink-0" aria-hidden="true" />
                <span>Update</span>
              </button>
            }
          />
        </div>
      </div>

      <Dialog open={removeTarget !== null} onOpenChange={(isOpen) => !isOpen && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removeTarget?.name}?</DialogTitle>
            <DialogDescription>
              {removeTarget && removeTarget.sessions.length > 0
                ? `This removes the project and its ${removeTarget.sessions.length} session${removeTarget.sessions.length === 1 ? "" : "s"}, archived included, from Rennet.`
                : "This removes the project from Rennet."}{" "}
              The repository on disk is not touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removeTarget) onRemoveProject(removeTarget.id)
                setRemoveTarget(null)
              }}
            >
              Remove project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
