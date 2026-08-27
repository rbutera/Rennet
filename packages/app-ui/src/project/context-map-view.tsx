import { useLocation } from "wouter";
import { ContextMapView } from "../components/context-map-view";
import { useBridge } from "../data";
import { newChatPath } from "../routes/url";

// ─────────────────────────────────────────────────────────────────────────────
// The router-side Context Map view (C12 §10.7, /projects/:id/map). It REUSES the
// incumbent `ContextMapView` — structure pane, dependency-neighborhood SVG, and the
// Knowledge/Details tabs over `context-map/model.ts` and `project.contextMap` — with
// the project-scoped ask rail hidden (the session chat column plays that role) and
// leaving landing on that project's New Chat, the flow's standing exit. C12 wires the
// entries it owns (the ready block and the new-chat header); it lays no new track.
// ─────────────────────────────────────────────────────────────────────────────

export function ProjectContextMapView({ projectId }: { readonly projectId: string }) {
  const bridge = useBridge();
  const [, navigate] = useLocation();
  return (
    <ContextMapView
      bridge={bridge}
      projectId={projectId}
      showAskRail={false}
      onBack={() => navigate(newChatPath(projectId))}
    />
  );
}
