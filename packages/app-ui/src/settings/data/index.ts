// The settings data seam (C10 §2) — the single resolution point every settings page
// reads and writes through. Two routes behind one barrel: the direct `settings.*`
// command hooks (`live.ts`), and the PROJECTION (`projections.tsx`) that resolves
// through a context — bound to real commands by `live-projection.tsx` in the app, and
// to a stateful fixture in tests. `settings-data.ts` (the spike fixture) has
// no successor here (reconciliation 8) — data lives behind a MemoryBridge or the
// projection provider, never an importable fixture module.

export {
  useGuidance,
  usePinRepoValue,
  useResetRepoValue,
  useSetAppearance,
  useSetKeybinding,
  useSetRepoVisibility,
  useSettingsView,
} from "./live";
export { LiveSettingsProjectionProvider } from "./live-projection";
export {
  type DaemonInfo,
  type DetectedTool,
  EMPTY_SETTINGS_PROJECTION,
  type GuidanceRule,
  type GuidanceSeverity,
  type IssueTrackerSettings,
  type ReviewRole,
  type RoleAssignment,
  type RoleEffort,
  type SettingsHost,
  type SettingsProjection,
  SettingsProjectionProvider,
  type ToolStatus,
  type TrackerKind,
  useSettingsProjection,
  type WorktreeSettings,
} from "./projections";
export type { Layered } from "./provenance";
