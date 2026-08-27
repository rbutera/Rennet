import { AddProjectDialog } from "../project/add-project-dialog";

// ─────────────────────────────────────────────────────────────────────────────
// The app-wide dialog host (C12). App chrome mounts this once, inside the layout
// (so it lives under the Router + BridgeProvider its dialogs need). Each dialog
// binds its own `open` to `ui.openDialogs` and renders through a portal, so this
// host adds no chrome of its own — it is just the mount point the sidebar's
// `ui.openDialog(...)` dispatches resolve against. Cluster 2 adds Add Environment.
// ─────────────────────────────────────────────────────────────────────────────
export function AppDialogs() {
  return <AddProjectDialog />;
}
