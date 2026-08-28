import type { Project, SettingsView } from "@rennet/protocol";
import { MemoryBridge, type MemoryBridgeHandlers } from "../memory-bridge";

// A fixture is a MemoryBridge PRE-LOADED with handlers — never an importable data
// module a surface could reach. The only way this data enters the app is through the
// bridge context, which is exactly what the fence test enforces (C01 §1.2/1.3).

/** A resolved-provenance stub for a builtin-only setting (no override contributed one). */
const builtinScheme = {
  layer: "builtin" as const,
  contributions: [{ layer: "builtin" as const, value: "system", effective: true }],
};

/** The minimal honest `settings.get` view a returning install returns. */
export function emptySettings(): SettingsView {
  return {
    scheme: "system",
    schemeProvenance: builtinScheme,
    appearanceMalformed: false,
    projects: [],
    welcome: { completedAt: "2026-08-28T00:00:00.000Z" },
  };
}

/**
 * The boot handler set that lands the app on the front door: bootstrap resolves with
 * no held review, settings resolve to the builtin default, and the front door's own
 * reads (`projects.list`, `harness.detect`) answer with an honest empty machine.
 */
export function frontDoorHandlers(projects: readonly Project[] = []): MemoryBridgeHandlers {
  return {
    "app.bootstrap": () => ({ review: null, repositoryPresent: false }),
    "settings.get": () => emptySettings(),
    "projects.list": () => ({ projects: [...projects] }),
    "project.detail": () => ({ viewer: { login: "rai" }, truncated: false, locals: [], prs: [] }),
    "session.list": () => ({ sessions: [] }),
    "harness.detect": () => ({ detected: [] }),
  };
}

/** A MemoryBridge pre-loaded to boot the app shell to the front door, with `projects`. */
export function frontDoorBridge(projects: readonly Project[] = []): MemoryBridge {
  return new MemoryBridge(frontDoorHandlers(projects));
}
