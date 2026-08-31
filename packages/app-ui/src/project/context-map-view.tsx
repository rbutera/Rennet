import type { ProjectRepositoryAddress } from "@rennet/protocol";
import { useLocation } from "wouter";
import { ContextMapView, discussPrompt } from "../components/context-map-view";
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
  repositoryAddress,
  onBack,
  takeover = true,
}: {
  readonly projectId: string;
  readonly repositoryAddress?: ProjectRepositoryAddress;
  /** Where Back goes. Omitted ⇒ the project's New Chat, this flow's standing exit. The
   *  session top-bar's `?view=map` overrides it to the board, because there Back leaving
   *  for New Chat would drop the reviewer out of the session they were reading. */
  readonly onBack?: () => void;
  /** False for the in-session `?view=map` mount, which renders INSIDE the session's own
   *  chrome: the takeover header and its window Escape would be a second Back, a second
   *  trail, and an Escape that fires from the chat composer. */
  readonly takeover?: boolean;
}) {
  const [, navigate] = useLocation();
  return (
    <ContextMapView
      projectId={projectId}
      repositoryAddress={repositoryAddress}
      showAskRail={false}
      takeover={takeover}
      onBack={onBack ?? (() => navigate(newChatPath(projectId)))}
      // No ask rail here, so "discuss" hands the statement to the project's New Chat,
      // prefilled — a real handoff, not an inert button (finding 9).
      onDiscuss={(statement) => navigate(newChatPath(projectId, discussPrompt(statement)))}
    />
  );
}
