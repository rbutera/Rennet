import { Button } from "@rennet/ui";
import { useState } from "react";
import { useCommand, useMutation } from "../../data";
import { CardSection } from "./detection-row";

// ─────────────────────────────────────────────────────────────────────────────
// Device pairing (#380), salvaged from the deleted `components/settings-screen.tsx`
// PairingPanel onto This Machine's Environments card. Pairing bootstraps a connection
// to THIS daemon, so it belongs on the local card (this machine's daemon), not on a
// remote card. Mint a short-lived single-use code a remote device exchanges once for a
// long-lived token — then it just works, no per-action ceremony (Rule Zero).
//
// Every call rides the data seam (`useCommand`/`useMutation` over `pairing.*`), never
// `bridge.invoke` (the C10 rule). Revoking invalidates `pairing.listDevices` so the
// list is the single source that re-reads. `pairing.*` is a LIVE served backend
// (protocol + `server/dispatch/pairing.ts`), so this is a real wire — a card with no
// devices reads the honest "No devices paired yet." line, not a fabricated row.
// ─────────────────────────────────────────────────────────────────────────────

export function PairingSection() {
  const {
    data,
    pending: loadingDevices,
    error: devicesError,
  } = useCommand("pairing.listDevices", {});
  const { mutate: mint, pending: minting } = useMutation("pairing.mint");
  const { mutate: revoke, pending: revoking } = useMutation("pairing.revokeDevice", {
    invalidates: ["pairing.listDevices"],
  });
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string>();

  const devices = data?.devices ?? [];

  async function createCode() {
    setError(undefined);
    try {
      setCode(await mint({}));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function revokeDevice(deviceId: string) {
    setError(undefined);
    try {
      await revoke({ deviceId });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <CardSection title="Device Pairing">
      {error ? <span className="pt-1 text-2xs text-destructive">{error}</span> : null}
      <div className="flex min-h-11 items-center gap-3 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium text-ink">Pair a device</span>
          <span className="text-2xs text-ink-soft">
            a one-time code a remote device exchanges for access
          </span>
        </div>
        <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
          <Button variant="outline" size="xs" onClick={() => void createCode()} disabled={minting}>
            Create pairing code
          </Button>
          {code ? (
            <div className="flex flex-col items-end gap-0.5" aria-live="polite">
              <code className="rounded border border-line bg-raised px-2 py-1 font-mono text-sm tracking-[0.15em] text-ink">
                {code.code}
              </code>
              <span className="text-2xs text-ink-faint">
                enter it on the device within 5 minutes; it works once
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col border-t border-line py-2">
        <span className="text-xs font-medium text-ink">Paired devices</span>
        {/* A live-read failure is its own state — never masked as the honest empty. */}
        {loadingDevices ? (
          <span className="pt-1 text-2xs text-ink-soft">Loading devices…</span>
        ) : devicesError ? (
          <span className="pt-1 text-2xs text-destructive">
            Couldn’t read paired devices:{" "}
            {devicesError instanceof Error ? devicesError.message : String(devicesError)}
          </span>
        ) : devices.length === 0 ? (
          <span className="pt-1 text-2xs text-ink-soft">No devices paired yet.</span>
        ) : (
          <ul className="m-0 mt-1 flex list-none flex-col gap-1.5 p-0">
            {devices.map((device) => (
              <li key={device.deviceId} className="flex items-center gap-3">
                <span className="text-xs font-medium text-ink">{device.name}</span>
                <span className="text-2xs text-ink-faint">last seen {device.lastSeenAt}</span>
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto"
                  aria-label={`Revoke ${device.name}`}
                  onClick={() => void revokeDevice(device.deviceId)}
                  disabled={revoking}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="pt-1 text-2xs text-ink-faint">
        A paired device reaches this daemon directly (Tailscale-first) — there is no Rennet server
        in the middle. A remote device never sees a host path; it works with repo references only.
      </p>
    </CardSection>
  );
}
