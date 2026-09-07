import { cn } from "@rennet/ui";
import type { ReactNode } from "react";
import { useMacTrafficLights } from "../shell/corner-slot";
import { Trail } from "../shell/trail";
import type { ChatTrail } from "./chat-data";

// ─────────────────────────────────────────────────────────────────────────────
// ChatHeader (C07, ported from the spike). The ONE dock header: the session trail
// (reusing C3's presentational `shell/trail.tsx`). Honest-minimal: when the supplied
// projection carries no target, `Trail` shows the title alone (reconciliation 2).
//
// C20 state 2: with the sidebar collapsed the chat is the leftmost pane, so it owns
// the corner slot — rendered as this row's FIRST child, `self-start` so the macOS
// light inset holds its true y in a 56px row instead of being centred in it. No
// extra strip and no second header; the row's own leading padding gives way. The
// chat's collapse control has LEFT this header entirely: there is now one chat
// open/close toggle, on the main view's top-left (`shell/top-bar.tsx`).
// ─────────────────────────────────────────────────────────────────────────────

export function ChatHeader({
  trail,
  corner,
}: {
  readonly trail: ChatTrail;
  /** State 2's corner slot — present exactly when the chat pane owns it. */
  readonly corner?: ReactNode;
}) {
  const mac = useMacTrafficLights();
  return (
    <header
      className={cn(
        "flex h-14 shrink-0 items-center gap-2 border-b border-border pr-3",
        corner ? "pl-0" : "pl-3",
        // The dock header drags the window on darwin: it holds only the corner slot
        // (which carries its own drag region and its one control opts out) and the
        // presentational trail text, so the whole strip is a safe titlebar handle.
        mac && "app-region-drag",
      )}
    >
      {corner}
      <Trail
        title={trail.title}
        projectName={trail.projectName}
        target={trail.target}
        targetState={trail.targetState}
        workspace={trail.workspace}
      />
    </header>
  );
}
