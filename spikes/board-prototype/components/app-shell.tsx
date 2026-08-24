"use client"

import { useRef, useState } from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { ChatColumn } from "@/components/chat-column"
import { MainSurface } from "@/components/main-surface"
import { CodeCommentsProvider } from "@/components/code-comments"
import { NewChatView } from "@/components/new-chat-view"
import { SessionView } from "@/components/session-view"
import { SettingsView } from "@/components/settings-view"
import type { SmartListItem } from "@/lib/smart-list-data"
import { AddProjectDialog } from "@/components/add-project-dialog"
import { AddRemoteDialog } from "@/components/add-remote-dialog"
import { hosts as initialHosts, type HostItem } from "@/lib/sidebar-data"

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [chatOpen, setChatOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newChatProjectId, setNewChatProjectId] = useState<string | null>(null)
  const [session, setSession] = useState<{
    projectName: string
    targetLabel: string
    targetKind: "pr" | "branch"
    initialMessage?: string
  } | null>(null)

  function startSession(projectName: string, item: SmartListItem | null, message: string) {
    setNewChatProjectId(null)
    setSession({
      projectName,
      targetLabel: item ? (item.kind === "pr" ? `#${item.number} · ${item.branch}` : item.branch) : "main",
      targetKind: item?.kind === "pr" ? "pr" : "branch",
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
          ? { ...h, projects: [...h.projects, { id: projectId, name, sessions: [], indexing: true }] }
          : h,
      ),
    )
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
    }, 5500)
  }

  function handleRemoteConnected(label: string): string {
    const hostId = `remote-${++counter.current}`
    setHosts((prev) => [...prev, { id: hostId, label, kind: "remote", projects: [] }])
    return hostId
  }

  return (
    <CodeCommentsProvider>
    <div className="fixed inset-0 flex overflow-hidden bg-background text-foreground">
      <AppSidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((value) => !value)}
        hosts={hosts}
        onAddProject={() => openAddProject()}
        onAddRemote={() => setAddRemoteOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onNewChat={(projectId) => setNewChatProjectId(projectId)}
        onSelectSession={() => {
          // Only the demo session exists; any session row returns to the demo chat.
          setSettingsOpen(false)
          setNewChatProjectId(null)
          setSession(null)
          setChatOpen(true)
        }}
      />
      {/* Settings and New chat take over the whole view, chat included (ruling
          2026-08-24). Chat + board stay mounted underneath so state survives. */}
      {settingsOpen && (
        <SettingsView hosts={hosts} activeProjectId="p1" onClose={() => setSettingsOpen(false)} />
      )}
      {!settingsOpen && newChatProjectId && (
        <NewChatView
          hosts={hosts}
          projectId={newChatProjectId}
          onProjectChange={(projectId) => setNewChatProjectId(projectId)}
          onClose={() => setNewChatProjectId(null)}
          onStart={(item, message) => {
            const project = hosts.flatMap((h) => h.projects).find((p) => p.id === newChatProjectId)
            startSession(project?.name ?? "rennet", item, message)
          }}
        />
      )}
      {!settingsOpen && !newChatProjectId && session && (
        <SessionView
          projectName={session.projectName}
          targetLabel={session.targetLabel}
          targetKind={session.targetKind}
          initialMessage={session.initialMessage}
          onBack={() => setSession(null)}
        />
      )}
      <div className={settingsOpen || newChatProjectId || session ? "hidden" : "contents"}>
        {chatOpen && <ChatColumn onCollapse={() => setChatOpen(false)} />}
        <MainSurface showLocationTrail={!chatOpen} onExpandChat={() => setChatOpen(true)} />
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
