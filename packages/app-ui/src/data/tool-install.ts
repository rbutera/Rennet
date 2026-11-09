import {
  type CommandOutput,
  type Locus,
  newCommandId,
  type RennetBridge,
  type SourceControlToolId,
} from "@rennet/protocol";
import { useCallback, useId, useMemo, useSyncExternalStore } from "react";
import { useBridgeContext } from "./bridge";
import type { CommandCache } from "./cache";
import { type ScopedHandle, scopedHandle } from "./scoped-state";

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
// AN INSTALL BELONGS TO ITS OWNER, NOT TO THE COMPONENT SHOWING IT. The run is kept under a
// key the caller names (`owner` — a session id — plus the tool and the machine), off the
// bridge's cache rather than in `useState`, for three reasons a Homebrew run outlives:
//
//   • A remount. The session route swaps the preparing workspace for the review workspace
//     mid-question; the Install for me under the large-file dialog remounts, and must find
//     its running install, output and Cancel where it left them.
//   • A different owner. The workspace is not keyed by session, so one component can show
//     session A and then session B. A's install finishing must retry A, so the completion
//     is the continuation bound when the install STARTED — never the latest prop — and B
//     reads B's own (idle) install.
//   • A dropped connection. The socket going rejects the dispatch, but the installer is
//     still running on the daemon. The subscription stays (the supervisor re-attaches it on
//     reconnect), the run stays `running` with its Cancel, and once the connection is back
//     the hook reconciles: a re-probe that finds the tool settles as installed; otherwise
//     the same commandId re-joins the daemon's run and its verdict settles the button.
//
// It lives in the data seam because it dispatches. Surfaces render its state through
// `components/install-for-me.tsx` and never touch the bridge.
// ─────────────────────────────────────────────────────────────────────────────

type InstallResult = CommandOutput<"tools.install">["result"];
export type InstalledResult = Extract<InstallResult, { status: "installed" }>;

/** What an Install for me button is showing. `result` arms carry the command's own answer. */
export type ToolInstallState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "running";
      readonly output: string;
      readonly cancelling: boolean;
      /** The command the daemon is running, once it has said (it does before any output). */
      readonly command?: string;
      /** The connection dropped mid-run; the install is still going on the daemon. */
      readonly reconnecting?: boolean;
    }
  | { readonly phase: "done"; readonly result: InstallResult }
  /** The dispatch itself failed (an older daemon, a refused input): nothing is known to have run. */
  | { readonly phase: "unavailable"; readonly message: string };

/** The live drawer keeps the newest output only. A Homebrew run can print a lot, and the
 *  command's result carries the whole (daemon-capped) output once it settles. */
const LIVE_OUTPUT_CAP = 64_000;

/** How long to wait before asking again while the connection is down. */
const RECONNECT_RETRY_MS = 1_000;

/** Reads a re-probe changes: the per-host source-control rows and the settings view. */
const STALED_BY_INSTALL = ["forge.hosts", "settings.get"] as const;

const IDLE: ToolInstallState = { phase: "idle" };

export interface ToolInstall {
  readonly state: ToolInstallState;
  /** Start an install. A second press while one runs does nothing. */
  readonly start: () => void;
  /** Stop the running install. Its result still arrives, marked cancelled. */
  readonly cancel: () => void;
}

/** The bookkeeping of one owner's run. Not rendered, so kept apart from the state slot. */
interface RunRecord {
  commandId: string | null;
  /** What to do when THIS run installs the tool. Bound at start; cleared once it has run. */
  continuation: ((result: InstalledResult) => void) | undefined;
  unsubscribe: (() => void) | undefined;
}

const runs = new WeakMap<CommandCache, Map<string, RunRecord>>();

function runRecord(cache: CommandCache, key: string): RunRecord {
  let byKey = runs.get(cache);
  if (byKey === undefined) {
    byKey = new Map();
    runs.set(cache, byKey);
  }
  let record = byKey.get(key);
  if (record === undefined) {
    record = { commandId: null, continuation: undefined, unsubscribe: undefined };
    byKey.set(key, record);
  }
  return record;
}

function locusKey(locus: Locus): string {
  return locus.kind === "wsl" ? `wsl:${locus.distro}` : "host";
}

/** `name === "ConnectionError"`, structurally: app-ui may not import `@rennet/client`. */
function isConnectionLoss(reason: unknown): boolean {
  return (
    reason !== null &&
    typeof reason === "object" &&
    (reason as { name?: unknown }).name === "ConnectionError"
  );
}

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.length > 0 ? reason.message : fallback;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Run {
  readonly bridge: RennetBridge;
  readonly cache: CommandCache;
  readonly slot: ScopedHandle<ToolInstallState>;
  readonly record: RunRecord;
  readonly tool: SourceControlToolId;
  readonly locus: Locus;
  readonly commandId: string;
}

function stillCurrent(run: Run): boolean {
  return run.record.commandId === run.commandId;
}

function settle(run: Run, result: InstallResult): void {
  if (!stillCurrent(run)) return;
  run.record.unsubscribe?.();
  run.record.unsubscribe = undefined;
  run.record.commandId = null;
  const continuation = run.record.continuation;
  run.record.continuation = undefined;
  run.slot.set({ phase: "done", result });
  if (result.status === "installed") continuation?.(result);
}

function giveUp(run: Run, message: string): void {
  if (!stillCurrent(run)) return;
  run.record.unsubscribe?.();
  run.record.unsubscribe = undefined;
  run.record.commandId = null;
  run.record.continuation = undefined;
  run.slot.set({ phase: "unavailable", message });
}

/** Ask the daemon for this run's verdict, riding out a dropped connection. */
function dispatch(run: Run): void {
  void run.bridge
    .invoke("tools.install", { tool: run.tool, locus: run.locus, commandId: run.commandId })
    .then(
      ({ result }) => {
        // A re-probe ran either way, so every row reading the tool's state is stale.
        for (const name of STALED_BY_INSTALL) run.cache.invalidate(name);
        settle(run, result);
      },
      (reason: unknown) => {
        if (isConnectionLoss(reason)) {
          void reconcile(run);
          return;
        }
        giveUp(run, messageOf(reason, "Rennet couldn't start the install."));
      },
    );
}

/**
 * The connection dropped mid-install. The installer is still running on the daemon, so the
 * run stays `running` (output, Cancel and all) and the subscription stays registered — the
 * connection supervisor re-attaches it to the fresh socket. Once a command gets through
 * again: a re-probe that finds the tool means the result was missed and the install worked,
 * so it settles as installed; otherwise the SAME commandId re-joins the daemon's run (the
 * daemon keys runs by tool and machine, so it answers with that run's verdict) and the
 * verdict settles it.
 */
async function reconcile(run: Run): Promise<void> {
  run.slot.set((previous) =>
    previous.phase === "running" ? { ...previous, reconnecting: true } : previous,
  );
  while (stillCurrent(run)) {
    try {
      const { hosts } = await run.bridge.invoke("forge.hosts", {});
      if (!stillCurrent(run)) return;
      const host = hosts.find((entry) => entry.source === sourceOfLocus(run.locus));
      const probe =
        host?.asked === true ? host.sourceControl?.find((tool) => tool.id === run.tool) : undefined;
      run.slot.set((previous) =>
        previous.phase === "running" ? { ...previous, reconnecting: false } : previous,
      );
      if (probe?.status === "available") {
        for (const name of STALED_BY_INSTALL) run.cache.invalidate(name);
        const current = run.slot.get();
        settle(run, {
          status: "installed",
          command: current.phase === "running" ? (current.command ?? "") : "",
          output: current.phase === "running" ? current.output : "",
          probe,
        });
        return;
      }
      dispatch(run);
      return;
    } catch (reason) {
      if (!isConnectionLoss(reason)) {
        giveUp(run, messageOf(reason, "Rennet lost track of the install. Try again."));
        return;
      }
      await wait(RECONNECT_RETRY_MS);
    }
  }
}

/** The `forge.hosts` source key a locus answers under. */
export function sourceOfLocus(locus: Locus): string {
  return locus.kind === "host" ? "local" : `wsl:${locus.distro}`;
}

export function useToolInstall(options: {
  readonly tool: SourceControlToolId;
  /** Where to install. Undefined while it is not known: `start` then does nothing. */
  readonly locus: Locus | undefined;
  /**
   * Whose install this is — a session id, say. Two components with one owner share one run
   * (a remount finds it running); different owners never do. Absent, the run belongs to
   * this component instance alone.
   */
  readonly owner?: string;
  /**
   * Called once with the result when the re-probe says the tool is now available. The
   * callback in effect when the install STARTED is the one that runs, even if this
   * component has since rendered another or unmounted.
   */
  readonly onInstalled?: (result: InstalledResult) => void;
}): ToolInstall {
  const { bridge, cache } = useBridgeContext();
  const instance = useId();
  const { tool, locus, onInstalled } = options;
  const owner = options.owner ?? `instance:${instance}`;
  const key = `tool-install:${owner}:${tool}:${locus === undefined ? "?" : locusKey(locus)}`;
  const slot = useMemo(() => scopedHandle<ToolInstallState>(cache, key, IDLE), [cache, key]);
  const state = useSyncExternalStore(slot.subscribe, slot.get, slot.get);

  const start = useCallback(() => {
    if (locus === undefined) return;
    const record = runRecord(cache, key);
    if (record.commandId !== null) return;
    const commandId = newCommandId();
    record.commandId = commandId;
    record.continuation = onInstalled;
    const run: Run = { bridge, cache, slot, record, tool, locus, commandId };
    slot.set({ phase: "running", output: "", cancelling: false });
    record.unsubscribe = bridge.onToolInstallProgress?.(commandId, (event) => {
      if (!stillCurrent(run)) return;
      slot.set((previous) =>
        previous.phase === "running"
          ? {
              ...previous,
              output: `${previous.output}${event.chunk}`.slice(-LIVE_OUTPUT_CAP),
              ...(event.command === undefined ? {} : { command: event.command }),
            }
          : previous,
      );
    });
    dispatch(run);
  }, [bridge, cache, key, locus, onInstalled, slot, tool]);

  const cancel = useCallback(() => {
    const commandId = runRecord(cache, key).commandId;
    if (commandId === null) return;
    slot.set((previous) =>
      previous.phase === "running" ? { ...previous, cancelling: true } : previous,
    );
    void bridge.invoke("tools.cancelInstall", { commandId }).catch(() => undefined);
  }, [bridge, cache, key, slot]);

  return { state, start, cancel };
}

/**
 * Forget the completion an owner's running install would run, without stopping the install.
 * For a surface that has moved on — the reviewer answered the question the install was for
 * another way — so the install finishing does not answer it a second time.
 */
export function useDropInstallContinuation(): (
  owner: string,
  tool: SourceControlToolId,
  locus: Locus | undefined,
) => void {
  const { cache } = useBridgeContext();
  return useCallback(
    (owner, tool, locus) => {
      runRecord(
        cache,
        `tool-install:${owner}:${tool}:${locus === undefined ? "?" : locusKey(locus)}`,
      ).continuation = undefined;
    },
    [cache],
  );
}
