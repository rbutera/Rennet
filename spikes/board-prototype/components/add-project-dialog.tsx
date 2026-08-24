"use client"

import * as React from "react"
import { Monitor, Server, Plus } from "lucide-react"
import type { HostItem } from "@/lib/sidebar-data"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { DirectoryBrowser } from "@/components/directory-browser"
import { makeListDir } from "@/lib/fake-fs"

export function AddProjectDialog({
  open,
  onOpenChange,
  hosts,
  initialHostId,
  onAdd,
  onAddRemote,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  hosts: HostItem[]
  initialHostId?: string
  onAdd: (hostId: string, name: string, path: string) => void
  onAddRemote: () => void
}) {
  const [hostId, setHostId] = React.useState(initialHostId ?? hosts[0]?.id)
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) {
      setHostId(initialHostId ?? hosts[0]?.id)
      setSelectedPath(null)
    }
  }, [open, initialHostId, hosts])

  const host = hosts.find((h) => h.id === hostId) ?? hosts[0]
  const listDir = React.useMemo(() => makeListDir(host?.kind ?? "local"), [host?.kind])

  function handleAdd() {
    if (!host || !selectedPath) return
    const name = selectedPath.split("/").pop() ?? selectedPath
    onAdd(host.id, name, selectedPath)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>Pick a source and a folder of repositories.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            value={hostId ? [hostId] : []}
            onValueChange={(value: string[]) => {
              if (value[0]) {
                setHostId(value[0])
                setSelectedPath(null)
              }
            }}
          >
            {hosts.map((h) => (
              <ToggleGroupItem key={h.id} value={h.id} aria-label={h.label}>
                {h.kind === "local" ? <Monitor aria-hidden="true" /> : <Server aria-hidden="true" />}
                {h.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button variant="ghost" size="sm" onClick={onAddRemote}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add remote
          </Button>
        </div>

        <DirectoryBrowser
          listDir={listDir}
          reloadKey={host?.id}
          onPathChange={setSelectedPath}
          onPathInvalid={() => setSelectedPath(null)}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={!selectedPath}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
