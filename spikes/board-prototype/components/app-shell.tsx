"use client"

import { useRef, useState } from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { ChatColumn } from "@/components/chat-column"
import { MainSurface } from "@/components/main-surface"
import { AddProjectDialog } from "@/components/add-project-dialog"
import { AddRemoteDialog } from "@/components/add-remote-dialog"
import { hosts as initialHosts, type HostItem } from "@/lib/sidebar-data"

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [chatOpen, setChatOpen] = useState(true)

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
    <div className="fixed inset-0 flex overflow-hidden bg-background text-foreground">
      <AppSidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((value) => !value)}
        hosts={hosts}
        onAddProject={() => openAddProject()}
        onAddRemote={() => setAddRemoteOpen(true)}
      />
      {chatOpen && <ChatColumn onCollapse={() => setChatOpen(false)} />}
      <MainSurface showLocationTrail={!chatOpen} onExpandChat={() => setChatOpen(true)} />

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
  )
}
