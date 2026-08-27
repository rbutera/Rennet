// The settings data seam (C10 §2) — the single resolution point every settings page
// reads and writes through. Two lifetimes behind one barrel: the LIVE `settings.*`
// commands (`live.ts`), and the B10-absent PROJECTIONS (`projections.tsx`) that resolve
// through a context until the engine lands. `settings-data.ts` (the spike fixture) has
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
export { type Layered, toProvenance } from "./provenance";
