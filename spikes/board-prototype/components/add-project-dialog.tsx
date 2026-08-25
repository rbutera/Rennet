"use client"

import * as React from "react"
import { Check, ChevronDown, Monitor, Plus, Server } from "lucide-react"
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
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
  const [sourceOpen, setSourceOpen] = React.useState(false)

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
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg md:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>Pick a source and a folder of repositories.</DialogDescription>
        </DialogHeader>

        <Popover open={sourceOpen} onOpenChange={setSourceOpen}>
          <PopoverTrigger
            aria-label={`Source: ${host?.label ?? "none"}`}
            render={<Button variant="outline" className="w-full justify-between" />}
          >
            <span className="flex min-w-0 items-center gap-2">
              {host?.kind === "local" ? <Monitor aria-hidden="true" /> : <Server aria-hidden="true" />}
              <span className="truncate">{host?.label}</span>
            </span>
            <ChevronDown className="text-muted-foreground" aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-(--anchor-width) min-w-56 gap-0 p-1">
            {hosts.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => {
                  if (h.id !== hostId) {
                    setHostId(h.id)
                    setSelectedPath(null)
                  }
                  setSourceOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-secondary sm:py-1.5"
              >
                {h.kind === "local" ? (
                  <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                <span className="flex-1 truncate">{h.label}</span>
                {h.id === host?.id ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
              </button>
            ))}
            <Separator className="my-1" />
            <button
              type="button"
              onClick={() => {
                setSourceOpen(false)
                onAddRemote()
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-secondary sm:py-1.5"
            >
              <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              Add remote
            </button>
          </PopoverContent>
        </Popover>

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
