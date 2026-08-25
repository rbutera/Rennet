"use client"

import * as React from "react"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

type Stage = "idle" | "connecting" | "connected"

export function AddRemoteDialog({
  open,
  onOpenChange,
  onConnected,
  onBrowseProjects,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once when the connection lands; returns the new host id. */
  onConnected: (label: string) => string
  onBrowseProjects: (hostId: string) => void
}) {
  const [stage, setStage] = React.useState<Stage>("idle")
  const [address, setAddress] = React.useState("")
  const [code, setCode] = React.useState("")
  const name = address.trim().split(".")[0] || address.trim()
  const hostIdRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (open) {
      setStage("idle")
      setAddress("")
      setCode("")
      hostIdRef.current = null
    }
  }, [open])

  function handleConnect() {
    if (!address.trim() || !code.trim()) return
    setStage("connecting")
    setTimeout(() => {
      hostIdRef.current = onConnected(name)
      setStage("connected")
    }, 2000)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add remote</DialogTitle>
          <DialogDescription>
            Pair a machine so its projects show up here.
          </DialogDescription>
        </DialogHeader>

        {stage !== "connected" ? (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="remote-address">Address</FieldLabel>
              <Input
                id="remote-address"
                placeholder="build-server.tailnet.ts.net"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                disabled={stage === "connecting"}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="remote-code">Pairing code</FieldLabel>
              <Input
                id="remote-code"
                placeholder="one-time code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={stage === "connecting"}
              />
              <FieldDescription>
                Run <code className="rounded bg-secondary px-1">rennet pair</code> on the machine to get a code —
                or paste the link it prints to fill both fields.
              </FieldDescription>
            </Field>
          </FieldGroup>
        ) : (
          <div className="flex items-center gap-2 text-[13px] text-foreground/90">
            <Check className="size-4 shrink-0 text-green" aria-hidden="true" />
            <span>
              Connected to <span className="font-medium">{name}</span>.
            </span>
          </div>
        )}

        <DialogFooter>
          {stage === "connected" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Done
              </Button>
              <Button
                onClick={() => {
                  onOpenChange(false)
                  if (hostIdRef.current) onBrowseProjects(hostIdRef.current)
                }}
              >
                Browse its projects
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={stage === "connecting"}>
                Cancel
              </Button>
              <Button onClick={handleConnect} disabled={stage === "connecting" || !address.trim() || !code.trim()}>
                {stage === "connecting" && <Spinner data-icon="inline-start" />}
                {stage === "connecting" ? "Connecting" : "Connect"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
