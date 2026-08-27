import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@rennet/ui";
import { Check, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { Icon } from "../components/icon";
import { useMutation } from "../data";
import { messageFrom } from "../lib/message-from";
import { selectDialogOpen, useRennetStore } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Add Environment pairing dialog (C12 §10.3). Opened via
// `ui.openDialog("add-environment")` (the Add Project source picker's Add
// Environment row, or the sidebar). Address + one-time code (never a bare code);
// the code helper names `rennet pair` and states the printed link fills both
// fields. Connect is inert until both carry a value; the fields lock + a spinner
// shows while connecting; the environment name is the address's first label. The
// body remounts on open, so the dialog reopens clean each time.
//
// ponytail: the REAL cross-daemon connect (a temp bridge dialled at the address,
// `pairing.exchange` invoked ON it, the token saved to localStorage) already lives
// in `components/connection-host.tsx` `submitAdd` — shell machinery the router seam
// cannot reach, deferred as cluster 1 recorded. This surface binds the exchange
// through the seam (real command, MemoryBridge-backed in tests); when the shell
// injects a ConnectionFactory into the router, the same call routes to the remote.
// ─────────────────────────────────────────────────────────────────────────────

type Stage = "idle" | "connecting" | "connected";

/** The environment name is the address's first label (`build-server.tailnet.ts.net` → `build-server`). */
function nameFromAddress(address: string): string {
  const trimmed = address.trim();
  return trimmed.split(".")[0] || trimmed;
}

export function AddRemoteDialog() {
  const open = useRennetStore(selectDialogOpen("add-environment"));
  const closeDialog = useRennetStore((s) => s.uiActions.closeDialog);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeDialog("add-environment");
      }}
    >
      <DialogContent className="sm:max-w-sm">
        {/* Gated on `open` so the body REMOUNTS each time — a clean state every reopen. */}
        {open ? <AddRemoteBody onClose={() => closeDialog("add-environment")} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddRemoteBody({ onClose }: { onClose(): void }) {
  const [stage, setStage] = useState<Stage>("idle");
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const deviceIdRef = useRef<string | null>(null);

  const exchange = useMutation("pairing.exchange", { invalidates: ["pairing.listDevices"] });
  const name = nameFromAddress(address);
  const connecting = stage === "connecting";

  async function connect(): Promise<void> {
    if (!address.trim() || !code.trim() || connecting) return;
    setStage("connecting");
    setError(undefined);
    try {
      const { deviceId } = await exchange.mutate({ code: code.trim(), deviceName: name });
      deviceIdRef.current = deviceId;
      setStage("connected");
    } catch (reason) {
      setError(messageFrom(reason));
      setStage("idle");
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add Environment</DialogTitle>
        <DialogDescription>Pair a machine so its projects show up here.</DialogDescription>
      </DialogHeader>

      {stage === "connected" ? (
        <p className="flex items-center gap-2 text-sm text-ink">
          <Icon icon={Check} className="size-4 flex-none text-accent" />
          <span>
            Connected to <span className="font-medium">{name}</span>.
          </span>
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="remote-address">Address</Label>
            <Input
              id="remote-address"
              placeholder="build-server.tailnet.ts.net"
              value={address}
              disabled={connecting}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="remote-code">Pairing code</Label>
            <Input
              id="remote-code"
              placeholder="one-time code"
              value={code}
              disabled={connecting}
              onChange={(e) => setCode(e.target.value)}
            />
            <p className="text-xs text-ink-faint">
              Run <code className="rounded bg-raised px-1">rennet pair</code> on the machine for a
              code — or paste the link it prints to fill both fields.
            </p>
          </div>
        </div>
      )}

      {error ? (
        <p
          className="add-remote-error rounded-chip border border-danger bg-danger-soft px-3.5 py-2 text-sm text-ink"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <DialogFooter>
        {stage === "connected" ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={connecting}>
              Cancel
            </Button>
            <Button
              onClick={() => void connect()}
              disabled={connecting || !address.trim() || !code.trim()}
            >
              {connecting ? <Icon icon={Loader2} className="mr-2 size-4 animate-spin" /> : null}
              {connecting ? "Connecting…" : "Connect"}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
