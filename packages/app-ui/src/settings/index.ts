// The Settings surface public barrel (C10 §11.1). The screen + the prior-surface
// tracker are what `routes/app.tsx` mounts; the shared atoms + the data seam are
// re-exported for the per-page modules and their tests.
export { PillChoice, Row, Section, Segmented } from "./atoms";
export { BackingFile } from "./backing-file";
export {
  EMPTY_SETTINGS_PROJECTION,
  type Layered,
  type SettingsHost,
  type SettingsProjection,
  SettingsProjectionProvider,
  toProvenance,
  useSettingsProjection,
  useSettingsView,
} from "./data";
export {
  DEFAULT_SETTINGS_PAGE,
  parseSettingsPage,
  SETTINGS_PAGES,
  type SettingsPageId,
  type SettingsPageMeta,
} from "./pages";
export { PriorSurfaceProvider, PriorSurfaceTracker, usePriorSurface } from "./prior-surface";
export { LAYER_LABEL, ProvenanceChip } from "./provenance-chip";
export { SettingsScreen } from "./settings-screen";
export { type ThemePref, ThemePrefProvider, useThemePref } from "./theme-pref";
