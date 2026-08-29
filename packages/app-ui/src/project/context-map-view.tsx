import { useLocation } from "wouter";
import { ContextMapView, discussPrompt } from "../components/context-map-view";
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

export function ProjectContextMapView({
  projectId,
  onBack,
}: {
  readonly projectId: string;
  /** Where Back goes. Omitted ⇒ the project's New Chat, this flow's standing exit. The
   *  session top-bar's `?view=map` overrides it to the board, because there Back leaving
   *  for New Chat would drop the reviewer out of the session they were reading. */
  readonly onBack?: () => void;
}) {
  const bridge = useBridge();
  const [, navigate] = useLocation();
  return (
    <ContextMapView
      bridge={bridge}
      projectId={projectId}
      showAskRail={false}
      onBack={onBack ?? (() => navigate(newChatPath(projectId)))}
      // No ask rail here, so "discuss" hands the statement to the project's New Chat,
      // prefilled — a real handoff, not an inert button (finding 9).
      onDiscuss={(statement) => navigate(newChatPath(projectId, discussPrompt(statement)))}
    />
  );
}
