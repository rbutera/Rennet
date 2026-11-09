import {
  type CommandOutput,
  type Locus,
  newCommandId,
  type SourceControlToolId,
} from "@rennet/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBridgeContext } from "./bridge";

// ─────────────────────────────────────────────────────────────────────────────
// useToolInstall — the data half of Install for me (source-control-tooling spec).
//
// One install is one `tools.install` dispatch under a FRESH commandId. The live output
// arrives on `onToolInstallProgress` under that id, so the subscription opens BEFORE the
// dispatch: a fast installer's first chunk would otherwise land before anyone listened.
// The command's own result is the verdict; the streamed chunks are only what the drawer
// shows while it runs, and the result's `output` replaces them when it lands.
//
// Pressing the button IS the request (Rule Zero): nothing here asks again.
//
// It lives in the data seam because it dispatches. Surfaces render its state through
// `components/install-for-me.tsx` and never touch the bridge.
// ─────────────────────────────────────────────────────────────────────────────

type InstallResult = CommandOutput<"tools.install">["result"];

/** What an Install for me button is showing. `result` arms carry the command's own answer. */
export type ToolInstallState =
  | { readonly phase: "idle" }
  | { readonly phase: "running"; readonly output: string; readonly cancelling: boolean }
  | { readonly phase: "done"; readonly result: InstallResult }
  /** The dispatch itself failed (a disconnect, an older daemon): nothing is known to have run. */
  | { readonly phase: "unavailable"; readonly message: string };

/** The live drawer keeps the newest output only. A Homebrew run can print a lot, and the
 *  command's result carries the whole (daemon-capped) output once it settles. */
const LIVE_OUTPUT_CAP = 64_000;

/** Reads a re-probe changes: the per-host source-control rows and the settings view. */
const STALED_BY_INSTALL = ["forge.hosts", "settings.get"] as const;

export interface ToolInstall {
  readonly state: ToolInstallState;
  /** Start an install. A second press while one runs does nothing. */
  readonly start: () => void;
  /** Stop the running install. Its result still arrives, marked cancelled. */
  readonly cancel: () => void;
}

export function useToolInstall(options: {
  readonly tool: SourceControlToolId;
  readonly locus: Locus;
  /** Called once with the result when the re-probe says the tool is now available. */
  readonly onInstalled?: (result: Extract<InstallResult, { status: "installed" }>) => void;
}): ToolInstall {
  const { bridge, cache } = useBridgeContext();
  const [state, setState] = useState<ToolInstallState>({ phase: "idle" });
  const running = useRef<string | null>(null);
  const mounted = useRef(true);
  const onInstalled = useRef(options.onInstalled);
  onInstalled.current = options.onInstalled;
  const { tool, locus } = options;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(() => {
    if (running.current !== null) return;
    const commandId = newCommandId();
    running.current = commandId;
    setState({ phase: "running", output: "", cancelling: false });
    const unsubscribe = bridge.onToolInstallProgress?.(commandId, (event) => {
      if (!mounted.current || running.current !== commandId) return;
      setState((previous) =>
        previous.phase === "running"
          ? { ...previous, output: `${previous.output}${event.chunk}`.slice(-LIVE_OUTPUT_CAP) }
          : previous,
      );
    });
    void bridge
      .invoke("tools.install", { tool, locus, commandId })
      .then(
        ({ result }) => {
          // A re-probe ran either way, so every row reading the tool's state is stale.
          for (const name of STALED_BY_INSTALL) cache.invalidate(name);
          if (!mounted.current) return;
          setState({ phase: "done", result });
          if (result.status === "installed") onInstalled.current?.(result);
        },
        (reason: unknown) => {
          if (!mounted.current) return;
          setState({
            phase: "unavailable",
            message:
              reason instanceof Error && reason.message.length > 0
                ? reason.message
                : "Rennet couldn't start the install.",
          });
        },
      )
      .finally(() => {
        unsubscribe?.();
        if (running.current === commandId) running.current = null;
      });
  }, [bridge, cache, locus, tool]);

  const cancel = useCallback(() => {
    const commandId = running.current;
    if (commandId === null) return;
    setState((previous) =>
      previous.phase === "running" ? { ...previous, cancelling: true } : previous,
    );
    void bridge.invoke("tools.cancelInstall", { commandId }).catch(() => undefined);
  }, [bridge]);

  return { state, start, cancel };
}
