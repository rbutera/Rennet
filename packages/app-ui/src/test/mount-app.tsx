import { ConnectionHost, type ConnectionTarget } from "../components/connection-host";
import { memoryHistory } from "../routes/history";
import { mount } from "./dom";
import { MemoryBridge, type MemoryBridgeHandlers } from "./memory-bridge";

// ─────────────────────────────────────────────────────────────────────────────
// mountApp — the production-shaped app mount for C12 dialog tests. The shell mounts
// the router through `ConnectionHost`, which owns a DISTINCT bridge per daemon: switching
// daemons genuinely changes which filesystem/commands the surfaces see. A single-bridge
// mock hid the blocker-2 bug (the browser kept one bridge across a source switch); this
// harness gives each target its own MemoryBridge so a switch is real.
// ─────────────────────────────────────────────────────────────────────────────

export const LOCAL_TARGET: ConnectionTarget = {
  id: "local",
  label: "This machine",
  host: "127.0.0.1",
};

/** Baseline handlers so the sidebar/front-door don't reject loudly; a target's own
 *  handlers override these. */
const BASELINE: MemoryBridgeHandlers = {
  "projects.list": () => ({ projects: [] }),
};

/**
 * Mount the full app (ConnectionHost → router) with a distinct bridge per daemon target.
 * `handlersFor(target)` returns the command handlers for THAT daemon's bridge, so a WSL /
 * remote source browses its own filesystem. Bridges are cached per target id, so a test can
 * re-derive the same instance and assert what it did (or did not) receive.
 */
export function mountApp(
  handlersFor: (target: ConnectionTarget) => MemoryBridgeHandlers,
  options: { readonly initialPath?: string } = {},
) {
  const bridges = new Map<string, MemoryBridge>();
  const history = memoryHistory(options.initialPath ?? "/new-chat");
  const bridgeFor = (target: ConnectionTarget): MemoryBridge => {
    let bridge = bridges.get(target.id);
    if (!bridge) {
      bridge = new MemoryBridge({ ...BASELINE, ...handlersFor(target) });
      bridges.set(target.id, bridge);
    }
    return bridge;
  };
  const view = mount(
    <ConnectionHost createBridge={bridgeFor} defaultTarget={LOCAL_TARGET} history={history} />,
  );
  return { ...view, history, bridges, bridgeFor };
}
