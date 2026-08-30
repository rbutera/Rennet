import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  Spinner,
} from "@rennet/ui";
import { Check } from "lucide-react";
import { useRef, useState } from "react";
import { Icon } from "../components/icon";
import { messageFrom } from "../lib/message-from";
import { useConnectionCapabilities } from "../shell/connection-capabilities";
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
// The REAL cross-daemon connect — a temp bridge dialled AT the entered address,
// `pairing.exchange` invoked ON it, the token saved as a selectable source — lives in
// `components/connection-host.tsx` and reaches this dialog as `pairAtAddress` through the
// connection-capabilities context (blocker 1). Dialling the currently-attached daemon and
// discarding the token, as this dialog once did, paired nothing. Outside the shell the
// fallback rejects with honest copy (pairing needs the desktop app).
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
  const openAddProjectForSource = useRennetStore((s) => s.uiActions.openAddProjectForSource);
  const { pairAtAddress } = useConnectionCapabilities();
  const [stage, setStage] = useState<Stage>("idle");
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const deviceIdRef = useRef<string | null>(null);

  const name = nameFromAddress(address);
  const connecting = stage === "connecting";

  async function connect(): Promise<void> {
    if (!address.trim() || !code.trim() || connecting) return;
    setStage("connecting");
    setError(undefined);
    try {
      // Dial the ENTERED address, exchange the code on that new connection, and persist the
      // paired daemon as a selectable source (blocker 1) — not a no-op on the current bridge.
      const { deviceId } = await pairAtAddress(address, code);
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
        // The two rows are kit `Field`s, not a local flex stack: the label/control/helper
        // rhythm and the helper's type belong to the kit, so this dialog and every other
        // form row in the app agree without each one re-deciding its gaps.
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="remote-address">Address</FieldLabel>
            <Input
              id="remote-address"
              placeholder="build-server.tailnet.ts.net"
              value={address}
              disabled={connecting}
              onChange={(e) => setAddress(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="remote-code">Pairing code</FieldLabel>
            <Input
              id="remote-code"
              placeholder="one-time code"
              value={code}
              disabled={connecting}
              onChange={(e) => setCode(e.target.value)}
            />
            <FieldDescription>
              Run <code className="rounded bg-raised px-1">rennet pair</code> on the machine for a
              one-time code. Open the link it prints to fill both fields.
            </FieldDescription>
          </Field>
        </FieldGroup>
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
          <>
            <Button variant="outline" onClick={onClose}>
              Done
            </Button>
            <Button
              onClick={() => {
                onClose();
                // One `ui` hop: reopen Add Project preselected to the machine just paired,
                // so the directory browser lands on its filesystem (§10.3).
                if (deviceIdRef.current) {
                  openAddProjectForSource(`remote:${deviceIdRef.current}`);
                }
              }}
            >
              Browse Its Projects
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={connecting}>
              Cancel
            </Button>
            <Button
              onClick={() => void connect()}
              disabled={connecting || !address.trim() || !code.trim()}
            >
              {/* The button already says "Connecting…" — the glyph is decoration beside it. */}
              {connecting ? <Spinner className="mr-2 size-4" aria-hidden="true" /> : null}
              {connecting ? "Connecting…" : "Connect"}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
