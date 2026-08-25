"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { useAppStore } from "@/lib/store"
import { slugForSession } from "@/lib/resolve-slug"

// ─────────────────────────────────────────────────────────────────────────────
// The ⌘P command menu — ported from packages/app-ui/src/components/command-palette.tsx
// (same cmdk-backed structure: CommandDialog owns portal/focus/Escape, cmdk owns
// fuzzy filtering + ↑/↓/Enter). Data + navigation are rewired to the spike: live
// sidebar sessions/projects, settings pages, and actions route through the
// next/navigation router. Open state lives in the store (sidebar ⌘P button + the
// global ⌘P keybinding both flip it); this component stays controlled.
// ─────────────────────────────────────────────────────────────────────────────

interface Cmd {
  id: string
  group: string
  title: string
  keywords: string[]
  run: () => void
}

export function CommandMenu() {
  const router = useRouter()
  const open = useAppStore((s) => s.commandOpen)
  const hosts = useAppStore((s) => s.hosts)
  const setOpen = useAppStore((s) => s.setCommandOpen)

  // Global ⌘P / Ctrl+P toggles the menu (matches the sidebar affordance's chord).
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "p" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        useAppStore.getState().setCommandOpen(!useAppStore.getState().commandOpen)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const commands = React.useMemo<Cmd[]>(() => {
    const list: Cmd[] = []
    for (const host of hosts) {
      for (const project of host.projects) {
        for (const session of project.sessions) {
          if (session.archived) continue
          list.push({
            id: `session:${session.id}`,
            group: "Session",
            title: session.title,
            keywords: [session.title, project.name, host.label],
            run: () => {
              useAppStore.getState().setChatOpen(true)
              router.push(`/s/${slugForSession(session.id)}`)
            },
          })
        }
      }
    }
    for (const host of hosts) {
      for (const project of host.projects) {
        list.push({
          id: `project-map:${project.id}`,
          group: "Project",
          title: `${project.name} — context map`,
          keywords: [project.name, project.repo, "map"],
          run: () => router.push(`/projects/${project.id}/map`),
        })
        list.push({
          id: `project-newchat:${project.id}`,
          group: "Project",
          title: `New chat in ${project.name}`,
          keywords: [project.name, project.repo, "new chat"],
          run: () => router.push(`/new-chat?project=${project.id}`),
        })
      }
    }
    for (const [id, title] of [
      ["machine", "This machine"],
      ["appearance", "Appearance"],
      ["shortcuts", "Keyboard shortcuts"],
      ["projects", "Projects"],
    ] as const) {
      list.push({
        id: `settings:${id}`,
        group: "Settings",
        title,
        keywords: [title, "settings"],
        run: () => router.push(`/settings/${id}`),
      })
    }
    list.push({
      id: "action:add-project",
      group: "Actions",
      title: "Add project",
      keywords: ["add", "project"],
      run: () => useAppStore.getState().openAddProject(),
    })
    list.push({
      id: "action:add-remote",
      group: "Actions",
      title: "Add remote",
      keywords: ["add", "remote", "host"],
      run: () => useAppStore.getState().setAddRemoteOpen(true),
    })
    return list
  }, [hosts, router])

  const groups = React.useMemo(() => {
    const order: string[] = []
    const byGroup = new Map<string, Cmd[]>()
    for (const command of commands) {
      const bucket = byGroup.get(command.group)
      if (bucket) bucket.push(command)
      else {
        byGroup.set(command.group, [command])
        order.push(command.group)
      }
    }
    return order.map((group) => [group, byGroup.get(group) ?? []] as const)
  }, [commands])

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command menu"
      description="Type a command to run it."
    >
      <CommandInput placeholder="Type a command…" aria-label="Search commands" />
      <CommandList>
        <CommandEmpty>No commands match your search.</CommandEmpty>
        {groups.map(([group, items]) => (
          <CommandGroup key={group}>
            {items.map((command) => (
              <CommandItem
                key={command.id}
                value={command.id}
                keywords={command.keywords}
                onSelect={() => {
                  command.run()
                  setOpen(false)
                }}
              >
                <span className="min-w-[72px] text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {command.group}
                </span>
                <span className="flex-1">{command.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
