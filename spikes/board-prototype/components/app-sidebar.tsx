"use client"

import * as React from "react"
import {
  Plus,
  Search,
  Settings,
  PanelLeft,
  Layers,
  ChevronDown,
  MessageSquarePlus,
  FolderPlus,
  Monitor,
  Server,
  CircleHelp,
  RefreshCw,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"
import type { HostItem, ProjectItem } from "@/lib/sidebar-data"
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
  onOpenSettings: () => void
  onNewChat: (projectId: string) => void
  onSelectSession: (sessionId: string) => void
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
                  <Layers className="size-3.5 text-muted-foreground" aria-hidden="true" />
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

export function AppSidebar({ open, onToggle, hosts, onAddProject, onAddRemote, onOpenSettings, onNewChat, onSelectSession }: AppSidebarProps) {
  const projects = React.useMemo(() => hosts.flatMap((host) => host.projects), [hosts])
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {}
    for (const host of hosts) {
      for (const project of host.projects) {
        initial[project.id] = project.sessions.some((s) => s.active)
      }
    }
    return initial
  })

  const toggleProject = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
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
          <button
            type="button"
            aria-label="Search"
            title="Search"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Search className="size-4" aria-hidden="true" />
          </button>
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
            onOpenSettings={onOpenSettings}
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
            onClick={onOpenSettings}
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
          className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Search className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="flex-1">Search</span>
          <kbd className="rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">
            ⌘P
          </kbd>
        </button>
      </div>

      <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto px-2">
        <div className="flex h-6 items-center px-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Projects
          </span>
        </div>
        <div className="flex flex-col gap-0.5 pb-2">
          <button
            type="button"
            onClick={onAddProject}
            className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Plus className="size-3.5 shrink-0" aria-hidden="true" />
            <span>Add project</span>
          </button>

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
                  <div key={project.id} className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => toggleProject(project.id)}
                      aria-expanded={isExpanded}
                      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-left text-[13px] text-foreground/90 transition-colors hover:bg-secondary"
                    >
                      <ChevronDown
                        className={cn(
                          "size-3 shrink-0 text-muted-foreground transition-transform",
                          !isExpanded && "-rotate-90",
                        )}
                        aria-hidden="true"
                      />
                      <Layers className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="flex-1 truncate">{project.name}</span>
                      {project.indexing ? (
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Spinner className="size-3" />
                          indexing
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">{project.sessions.length}</span>
                      )}
                    </button>

                    {isExpanded && (
                      <div className="ml-3 flex flex-col gap-0.5 border-l border-border pb-1 pl-2">
                        {project.sessions.map((session) => (
                          <button
                            key={session.id}
                            type="button"
                            onClick={() => onSelectSession(session.id)}
                            className={cn(
                              "flex h-8 flex-col justify-center gap-0.5 rounded-md px-2 text-left transition-colors hover:bg-secondary",
                              session.active && "bg-secondary",
                            )}
                          >
                            <span className="flex items-center gap-1.5">
                              {session.active && (
                                <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                              )}
                              <span
                                className={cn(
                                  "truncate text-[13px] leading-tight",
                                  session.active ? "text-foreground" : "text-foreground/80",
                                )}
                              >
                                {session.title}
                              </span>
                            </span>
                            <span className="pl-3 text-[11px] text-muted-foreground">{session.time}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}

          <button
            type="button"
            onClick={onAddRemote}
            className="mt-4 flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Plus className="size-3.5 shrink-0" aria-hidden="true" />
            <span>Add remote</span>
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-0.5 border-t border-border px-2 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={onOpenSettings}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Settings className="size-3.5" aria-hidden="true" />
          </button>
          <HelpPopover
            align="start"
            onOpenSettings={onOpenSettings}
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
    </div>
  )
}
