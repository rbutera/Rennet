"use client"

import { useRef, useState } from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { ChatColumn } from "@/components/chat-column"
import { MainSurface } from "@/components/main-surface"
import { CodeCommentsProvider } from "@/components/code-comments"
import { ScenarioSeeder } from "@/components/scenario-seeder"
import { RoundRunView } from "@/components/run-view"
import { SuccessorSummary } from "@/components/successor-summary"
import { ContextMapFullView } from "@/components/context-map"
import { NewChatView, targetOf } from "@/components/new-chat-view"
import { DEFAULT_CHAT_WIDTH, ResizeHandle } from "@/components/resize-handle"
import type { TargetState } from "@/components/target-badge"
import type { TargetKind } from "@/lib/target-language"
import { ProjectIndexingView } from "@/components/project-indexing-view"
import { SessionView } from "@/components/session-view"
import { SettingsView } from "@/components/settings-view"
import type { SmartListItem } from "@/lib/smart-list-data"
import { AddProjectDialog } from "@/components/add-project-dialog"
import { AddRemoteDialog } from "@/components/add-remote-dialog"
import { ArchivedView } from "@/components/archived-view"
import type { SettingsPage } from "@/lib/settings-data"
import { hosts as initialHosts, type HostItem } from "@/lib/sidebar-data"
import { DEFAULT_SCENARIO, scenarioForSession, scenarios, type Scenario } from "@/lib/scenarios"

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [activeScenarioId, setActiveScenarioId] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const requested = new URLSearchParams(window.location.search).get("scenario")
      if (requested && scenarios[requested]) return requested
    }
    return DEFAULT_SCENARIO
  })
  const activeScenario: Scenario = scenarios[activeScenarioId] ?? scenarios[DEFAULT_SCENARIO]
  // Dispatch Round takes over the surface with the live round, which lands in
  // the `returned` state and greets the reviewer with the successor summary.
  const [roundRunning, setRoundRunning] = useState(false)
  const [greetingOpen, setGreetingOpen] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("scenario") === "returned"
    }
    return false
  })
  const [chatOpen, setChatOpen] = useState(true)
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH)
  const [settings, setSettings] = useState<{ page: SettingsPage; projectId?: string } | null>(null)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [newChatProjectId, setNewChatProjectId] = useState<string | null>(null)
  const [indexingProject, setIndexingProject] = useState<{ id: string; name: string } | null>(null)
  const [contextMapProject, setContextMapProject] = useState<{ id: string; name: string } | null>(null)
  const [session, setSession] = useState<{
    projectName: string
    targetLabel: string
    targetKind: "pr" | "branch"
    badge: { kind: TargetKind; state?: TargetState }
    initialMessage?: string
  } | null>(null)

  function startSession(projectName: string, item: SmartListItem | null, message: string) {
    setNewChatProjectId(null)
    setSession({
      projectName,
      targetLabel: item ? (item.kind === "pr" ? `#${item.number} · ${item.branch}` : item.branch) : "main",
      targetKind: item?.kind === "pr" ? "pr" : "branch",
      badge: item ? targetOf(item) : { kind: "your-branch" },
      initialMessage: message || undefined,
    })
  }

  const [hosts, setHosts] = useState<HostItem[]>(initialHosts)
  const [addProjectOpen, setAddProjectOpen] = useState(false)
  const [addProjectHostId, setAddProjectHostId] = useState<string | undefined>(undefined)
  const [addRemoteOpen, setAddRemoteOpen] = useState(false)
  const counter = useRef(0)

  function openAddProject(hostId?: string) {
    setAddProjectHostId(hostId)
    setAddProjectOpen(true)
  }

  function handleAddProject(hostId: string, name: string, _path: string) {
    const projectId = `added-${++counter.current}`
    setHosts((prev) =>
      prev.map((h) =>
        h.id === hostId
          ? { ...h, projects: [...h.projects, { id: projectId, name, repo: name, sessions: [], indexing: true }] }
          : h,
      ),
    )
    // Adding a project opens the live indexing view (the map filling in).
    setIndexingProject({ id: projectId, name })
    // Processing settles after a few seconds; the sidebar row carries the state.
    setTimeout(() => {
      setHosts((prev) =>
        prev.map((h) =>
          h.id === hostId
            ? {
                ...h,
                projects: h.projects.map((p) => (p.id === projectId ? { ...p, indexing: false } : p)),
              }
            : h,
        ),
      )
    }, 10500)
  }

  function renameSession(sessionId: string, title: string) {
    setHosts((prev) =>
      prev.map((h) => ({
        ...h,
        projects: h.projects.map((p) => ({
          ...p,
          sessions: p.sessions.map((s) => (s.id === sessionId ? { ...s, title } : s)),
        })),
      })),
    )
  }

  function toggleSessionFlag(sessionId: string, flag: "pinned" | "archived") {
    setHosts((prev) =>
      prev.map((h) => ({
        ...h,
        projects: h.projects.map((p) => ({
          ...p,
          sessions: p.sessions.map((s) => (s.id === sessionId ? { ...s, [flag]: !s[flag] } : s)),
        })),
      })),
    )
  }

  function handleRemoteConnected(label: string): string {
    const hostId = `remote-${++counter.current}`
    setHosts((prev) => [...prev, { id: hostId, label, kind: "remote", projects: [] }])
    return hostId
  }

  // The trail reads the live session record (renames included), falling back
  // to the scenario fixture before the sidebar row exists.
  const trailProject = hosts
    .flatMap((h) => h.projects)
    .find((p) => p.sessions.some((s) => s.id === activeScenario.session.id))
  const trail = {
    projectName: trailProject?.name ?? "rennet",
    session:
      trailProject?.sessions.find((s) => s.id === activeScenario.session.id) ??
      activeScenario.session,
  }

  return (
    <CodeCommentsProvider>
    <ScenarioSeeder scenario={activeScenario} />
    <div className="fixed inset-0 flex overflow-hidden bg-background text-foreground">
      <AppSidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((value) => !value)}
        hosts={hosts.map((host) => ({
          ...host,
          projects: host.projects.map((project) => ({
            ...project,
            sessions: project.sessions.map((session) => ({
              ...session,
              active: session.id === activeScenario.session.id,
            })),
          })),
        }))}
        onAddProject={() => openAddProject()}
        onAddRemote={() => setAddRemoteOpen(true)}
        onOpenSettings={(page) => setSettings({ page: page ?? "machine" })}
        onNewChat={(projectId) => setNewChatProjectId(projectId)}
        onOpenProjectSettings={(projectId) => setSettings({ page: "projects", projectId })}
        onOpenMap={(projectId) => {
          const project = hosts.flatMap((h) => h.projects).find((p) => p.id === projectId)
          if (project) setContextMapProject({ id: project.id, name: project.name })
        }}
        onRenameProject={(projectId, name) =>
          setHosts((prev) =>
            prev.map((h) => ({
              ...h,
              projects: h.projects.map((p) => (p.id === projectId ? { ...p, name } : p)),
            })),
          )
        }
        onRemoveProject={(projectId) => {
          setHosts((prev) =>
            prev.map((h) => ({ ...h, projects: h.projects.filter((p) => p.id !== projectId) })),
          )
          // Views pointed at the removed project fall back to the board.
          if (newChatProjectId === projectId) setNewChatProjectId(null)
          if (contextMapProject?.id === projectId) setContextMapProject(null)
          if (indexingProject?.id === projectId) setIndexingProject(null)
        }}
        onTogglePinSession={(sessionId) => toggleSessionFlag(sessionId, "pinned")}
        onToggleArchiveSession={(sessionId) => toggleSessionFlag(sessionId, "archived")}
        onRenameSession={renameSession}
        onOpenArchived={() => setArchivedOpen(true)}
        onSelectSession={(sessionId) => {
          // A session row maps 1:1 to a scenario (SCENARIOS.md); clicking it
          // IS the scenario switch. Rows without a scenario return to the
          // active one unchanged.
          const scenario = scenarioForSession(sessionId)
          if (scenario) setActiveScenarioId(scenario.id)
          setGreetingOpen(false)
          setSettings(null)
          setArchivedOpen(false)
          setNewChatProjectId(null)
          setIndexingProject(null)
          setContextMapProject(null)
          setSession(null)
          setChatOpen(true)
        }}
      />
      {/* Settings and New chat take over the whole view, chat included (ruling
          2026-08-24). Chat + board stay mounted underneath so state survives. */}
      {settings && (
        <SettingsView
          key={`${settings.page}:${settings.projectId ?? ""}`}
          hosts={hosts}
          initialPage={settings.page}
          activeProjectId={settings.projectId ?? "p1"}
          onClose={() => setSettings(null)}
          onRenameProject={(projectId, name) =>
            setHosts((prev) =>
              prev.map((h) => ({
                ...h,
                projects: h.projects.map((p) => (p.id === projectId ? { ...p, name } : p)),
              })),
            )
          }
          onSetProjectIcon={(projectId, icon) =>
            setHosts((prev) =>
              prev.map((h) => ({
                ...h,
                projects: h.projects.map((p) => (p.id === projectId ? { ...p, icon } : p)),
              })),
            )
          }
        />
      )}
      {!settings && archivedOpen && (
        <ArchivedView
          hosts={hosts}
          onBack={() => setArchivedOpen(false)}
          onSelectSession={(sessionId) => {
            setArchivedOpen(false)
            const scenario = scenarioForSession(sessionId)
            if (scenario) setActiveScenarioId(scenario.id)
          }}
          onUnarchive={(sessionId) => toggleSessionFlag(sessionId, "archived")}
        />
      )}
      {!settings && !archivedOpen && contextMapProject && (
        <ContextMapFullView
          projectName={contextMapProject.name}
          onBack={() => {
            // The map always returns to the New chat of its project.
            setNewChatProjectId(contextMapProject.id)
            setContextMapProject(null)
          }}
        />
      )}
      {!settings && !archivedOpen && !contextMapProject && newChatProjectId && (
        <NewChatView
          hosts={hosts}
          projectId={newChatProjectId}
          onProjectChange={(projectId) => setNewChatProjectId(projectId)}
          onClose={() => setNewChatProjectId(null)}
          onStart={(item, message) => {
            const project = hosts.flatMap((h) => h.projects).find((p) => p.id === newChatProjectId)
            startSession(project?.name ?? "rennet", item, message)
          }}
          onOpenMap={() => {
            const project = hosts.flatMap((h) => h.projects).find((p) => p.id === newChatProjectId)
            setContextMapProject({ id: newChatProjectId, name: project?.name ?? "rennet" })
          }}
        />
      )}
      {!settings && !archivedOpen && !contextMapProject && !newChatProjectId && indexingProject && (
        <ProjectIndexingView
          projectName={indexingProject.name}
          onBack={() => setIndexingProject(null)}
          onNewChat={() => {
            setNewChatProjectId(indexingProject.id)
            setIndexingProject(null)
          }}
          onViewMap={() => {
            setContextMapProject(indexingProject)
            setIndexingProject(null)
          }}
        />
      )}
      {!settings && !archivedOpen && !contextMapProject && !newChatProjectId && !indexingProject && session && (
        <SessionView
          projectName={session.projectName}
          targetLabel={session.targetLabel}
          targetKind={session.targetKind}
          badge={session.badge}
          initialMessage={session.initialMessage}
          onBack={() => setSession(null)}
          chatWidth={chatWidth}
          onChatWidthChange={setChatWidth}
        />
      )}
      <div className={settings || archivedOpen || contextMapProject || newChatProjectId || indexingProject || session ? "hidden" : "contents"}>
        {chatOpen && (
          <>
            <ChatColumn
              onCollapse={() => setChatOpen(false)}
              width={chatWidth}
              transcript={activeScenario.transcript}
              projectName={trail.projectName}
              session={trail.session}
            />
            <ResizeHandle value={chatWidth} onChange={setChatWidth} />
          </>
        )}
        {roundRunning ? (
          <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <header className="h-10 shrink-0 border-b border-border" />
            <RoundRunView
              onComplete={() => {
                setRoundRunning(false)
                setActiveScenarioId("returned")
                setGreetingOpen(true)
              }}
            />
          </div>
        ) : activeScenarioId === "returned" && greetingOpen ? (
          <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <header className="h-10 shrink-0 border-b border-border" />
            <SuccessorSummary onDismiss={() => setGreetingOpen(false)} />
          </div>
        ) : (
          <MainSurface
            showLocationTrail={!chatOpen}
            onExpandChat={() => setChatOpen(true)}
            scenario={activeScenario}
            trail={trail}
            onDispatchRound={() => setRoundRunning(true)}
          />
        )}
      </div>

      <AddProjectDialog
        open={addProjectOpen}
        onOpenChange={setAddProjectOpen}
        hosts={hosts}
        initialHostId={addProjectHostId}
        onAdd={handleAddProject}
        onAddRemote={() => {
          setAddProjectOpen(false)
          setAddRemoteOpen(true)
        }}
      />
      <AddRemoteDialog
        open={addRemoteOpen}
        onOpenChange={setAddRemoteOpen}
        onConnected={handleRemoteConnected}
        onBrowseProjects={(hostId) => openAddProject(hostId)}
      />
    </div>
    </CodeCommentsProvider>
  )
}
