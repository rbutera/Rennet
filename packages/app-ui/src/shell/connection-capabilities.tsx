import type { ProjectKind, ProjectSource } from "@rennet/protocol";
import { createContext, useContext } from "react";
import type { SourceOption } from "../components/source-switcher";

// ─────────────────────────────────────────────────────────────────────────────
// Connection capabilities (C12 blockers 1–2). The cross-daemon machinery the shell's
// `ConnectionHost` owns — the source list, which daemon is attached, attaching another
// (a remount), and pairing a NEW machine at an address — threaded INTO the router so the
// Add Project / Add Environment dialogs can reach it. Those dialogs live under the router
// (in `AppDialogs`); `ConnectionHost` sits ABOVE it, so the seam alone cannot see this —
// hence the context. Without a shell (bare mounts, the interim) the fallback offers Local
// only and pairing is unavailable: honest, never a claim the code can't honour.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConnectionCapabilities {
  /** Every browsable source: Local (always first), each WSL distro, each paired remote. */
  readonly sources: readonly SourceOption[];
  /** The `ProjectSource` of the daemon currently attached — the browser's current host. */
  readonly activeSource: ProjectSource;
  /** Attach the daemon a source lives on. `switched:true` ⇒ the app is remounting onto it. */
  readonly connectSource: (
    source: ProjectSource,
    kind: ProjectKind,
    browsePath?: string,
  ) => Promise<{ switched: boolean; error?: string }>;
  /**
   * Dial the address, exchange the one-time code on that NEW connection (the one command a
   * token-less projected connection may invoke), and persist the paired daemon as a
   * selectable source. Returns the new device id + the name derived from the address.
   */
  readonly pairAtAddress: (
    address: string,
    code: string,
  ) => Promise<{ deviceId: string; name: string }>;
}

const FALLBACK: ConnectionCapabilities = {
  sources: [{ id: "local", label: "This machine" }],
  activeSource: "local",
  connectSource: async () => ({ switched: false }),
  pairAtAddress: async () => {
    throw new Error("Pairing needs the desktop app — it isn't available here.");
  },
};

const ConnectionCapabilitiesContext = createContext<ConnectionCapabilities>(FALLBACK);

export const ConnectionCapabilitiesProvider = ConnectionCapabilitiesContext.Provider;

/** Read the shell's connection capabilities (Local-only fallback outside the shell). */
export function useConnectionCapabilities(): ConnectionCapabilities {
  return useContext(ConnectionCapabilitiesContext);
}
