"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { usePathname, useRouter } from "next/navigation"
import { AppSidebar } from "@/components/app-sidebar"
import { AppearanceSync } from "@/components/appearance-sync"
import { CommandMenu } from "@/components/command-menu"
import { ChatColumn } from "@/components/chat-column"
import { CornerSlot } from "@/components/corner-slot"
import { ResizeHandle } from "@/components/resize-handle"
import { ScenarioSeeder } from "@/components/scenario-seeder"
import { AddProjectDialog } from "@/components/add-project-dialog"
import { AddRemoteDialog } from "@/components/add-remote-dialog"
import { DEFAULT_SCENARIO, scenarios, type Scenario } from "@/lib/scenarios"
import { resolveSlug, slugForSession } from "@/lib/resolve-slug"
import { useAppStore } from "@/lib/store"

/**
 * The persistent app frame. Sidebar and chat live here (outside the route
 * children) so their state survives navigation; the route page renders the
 * main region. The old keep-mounted hidden-div trick is gone — chat is simply
 * never unmounted, only hidden when the active route isn't a scenario board.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  // Code-comment state is store-backed now (useCodeComments reads the store),
  // so the frame no longer needs a provider wrapper.
  return <ShellInner>{children}</ShellInner>
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()

  const hosts = useAppStore((s) => s.hosts)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const chatOpen = useAppStore((s) => s.chatOpen)
  const [resizingChat, setResizingChat] = React.useState(false)
  const resizeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const chatWidth = useAppStore((s) => s.chatWidth)
  const addProjectOpen = useAppStore((s) => s.addProjectOpen)
  const addProjectHostId = useAppStore((s) => s.addProjectHostId)
  const addRemoteOpen = useAppStore((s) => s.addRemoteOpen)

  // Resolve the active route → the board scenario + highlighted session.
  const onBoard = pathname.startsWith("/s/")
  const slug = onBoard ? decodeURIComponent(pathname.split("/")[2] ?? "") : ""
  const resolution = onBoard && slug ? resolveSlug(slug, hosts) : null
  const isScenario = resolution?.kind === "scenario"

  // Chat feeds off the last scenario board so its transcript identity stays
  // stable across takeover routes — the mounted ChatColumn keeps its turns.
  const lastScenarioRef = React.useRef<Scenario>(scenarios[DEFAULT_SCENARIO])
  if (resolution?.kind === "scenario") lastScenarioRef.current = resolution.scenario
  const chatScenario = resolution?.kind === "scenario" ? resolution.scenario : lastScenarioRef.current

  const showChat = isScenario
  const activeSessionId = resolution && resolution.kind !== "unknown" ? resolution.sessionId : null

  // The trail reads the live session record (renames included), falling back
  // to the scenario fixture before the sidebar row exists.
  const trailProject = hosts
    .flatMap((h) => h.projects)
    .find((p) => p.sessions.some((s) => s.id === chatScenario.session.id))
  const trail = {
    projectName: trailProject?.name ?? "rennet",
    session: trailProject?.sessions.find((s) => s.id === chatScenario.session.id) ?? chatScenario.session,
  }

  return (
    <>
      <AppearanceSync />
      <CommandMenu />
      <ScenarioSeeder scenario={chatScenario} />
      <div className="fixed inset-0 flex overflow-hidden bg-background text-foreground">
        <AppSidebar
          open={sidebarOpen}
          onToggle={useAppStore.getState().toggleSidebar}
          hosts={hosts.map((host) => ({
            ...host,
            projects: host.projects.map((project) => ({
              ...project,
              sessions: project.sessions.map((session) => ({
                ...session,
                active: session.id === activeSessionId,
              })),
            })),
          }))}
          onAddProject={() => useAppStore.getState().openAddProject()}
          onAddRemote={() => useAppStore.getState().setAddRemoteOpen(true)}
          onOpenSettings={(page) => router.push(`/settings/${page ?? "machine"}`)}
          onOpenProjectSettings={(projectId) => router.push(`/settings/projects?project=${projectId}`)}
          onNewChat={(projectId) => router.push(`/new-chat?project=${projectId}`)}
          onOpenMap={(projectId) => router.push(`/projects/${projectId}/map`)}
          onRenameProject={(projectId, name) => useAppStore.getState().renameProject(projectId, name)}
          onRemoveProject={(projectId) => {
            // If we're standing inside the project we're removing (its map/indexing
            // route, or viewing one of its sessions), the route goes stale — bail somewhere sane.
            const project = hosts.flatMap((h) => h.projects).find((p) => p.id === projectId)
            const stranded =
              pathname.startsWith(`/projects/${projectId}/`) ||
              (activeSessionId != null && !!project?.sessions.some((s) => s.id === activeSessionId))
            useAppStore.getState().removeProject(projectId)
            if (stranded) router.push("/s/teammate")
          }}
          onTogglePinSession={(sessionId) => useAppStore.getState().togglePinSession(sessionId)}
          onToggleArchiveSession={(sessionId) => {
            useAppStore.getState().toggleArchiveSession(sessionId)
            // Archiving the session you're looking at pulls it out of the tree — move on.
            if (sessionId === activeSessionId) router.push("/s/teammate")
          }}
          onRenameSession={(sessionId, title) => useAppStore.getState().renameSession(sessionId, title)}
          onOpenArchived={() => router.push("/archived")}
          onSelectSession={(sessionId) => {
            useAppStore.getState().setChatOpen(true)
            router.push(`/s/${slugForSession(sessionId)}`)
          }}
        />

        {/* Chat stays mounted; the wrapper animates its width shut so the
            column slides instead of vanishing. Resizing bypasses the
            transition (it would lag the drag). */}
        {showChat && (
          <div
            className={cn(
              "flex overflow-hidden",
              !resizingChat && "transition-[width] duration-200 ease-out motion-reduce:transition-none",
            )}
            style={{ width: chatOpen ? chatWidth + 4 : 0 }}
            inert={!chatOpen}
          >
            <ChatColumn
              corner={
                !sidebarOpen ? (
                  <CornerSlot
                    sidebarOpen={false}
                    onToggle={useAppStore.getState().toggleSidebar}
                    className="mr-2 self-start"
                  />
                ) : null
              }
              width={chatWidth}
              transcript={chatScenario.transcript}
              projectName={trail.projectName}
              session={trail.session}
            />
            <ResizeHandle
              value={chatWidth}
              onChange={(w) => {
                setResizingChat(true)
                if (resizeTimer.current) clearTimeout(resizeTimer.current)
                resizeTimer.current = setTimeout(() => setResizingChat(false), 200)
                useAppStore.getState().setChatWidth(w)
              }}
            />
          </div>
        )}

        {children}

        {/* STATE 3: nothing is left of the main view, so the corner slot floats
            over it. (States 1 and 2 mount it inside the sidebar / chat head.) */}
        {!sidebarOpen && !(showChat && chatOpen) && (
          <CornerSlot
            sidebarOpen={false}
            onToggle={useAppStore.getState().toggleSidebar}
            floating
            className="fixed left-1 top-1 z-40"
          />
        )}

        <AddProjectDialog
          open={addProjectOpen}
          onOpenChange={(open) => useAppStore.getState().setAddProjectOpen(open)}
          hosts={hosts}
          initialHostId={addProjectHostId}
          onAdd={(hostId, name) => {
            const projectId = useAppStore.getState().addProject(hostId, name)
            router.push(`/projects/${projectId}/indexing`)
          }}
          onAddRemote={() => {
            useAppStore.getState().setAddProjectOpen(false)
            useAppStore.getState().setAddRemoteOpen(true)
          }}
        />
        <AddRemoteDialog
          open={addRemoteOpen}
          onOpenChange={(open) => useAppStore.getState().setAddRemoteOpen(open)}
          onConnected={(label) => useAppStore.getState().addRemote(label)}
          onBrowseProjects={(hostId) => useAppStore.getState().openAddProject(hostId)}
        />
      </div>
    </>
  )
}
