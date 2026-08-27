import { PanelRight } from "lucide-react";
import { Trail } from "../shell/trail";
import { useRennetStore } from "../store";
import type { ChatTrail } from "./chat-data";

// ─────────────────────────────────────────────────────────────────────────────
// ChatHeader (C07, ported from the spike). The ONE dock header: the session trail
// (reusing C3's presentational `shell/trail.tsx`) + a collapse control that writes the
// C3 `ui`-slice `setChatOpen(false)` — the same flag the layout slot already reads to
// animate its width to 0 and go `inert`. No bespoke bar. Honest-minimal until B9: when
// the projection carries no target, `Trail` shows the title alone (reconciliation 2).
// ─────────────────────────────────────────────────────────────────────────────

export function ChatHeader({ trail }: { readonly trail: ChatTrail }) {
  const setChatOpen = useRennetStore((s) => s.uiActions.setChatOpen);
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3">
      <Trail
        title={trail.title}
        projectName={trail.projectName}
        target={trail.target}
        targetState={trail.targetState}
      />
      <button
        type="button"
        onClick={() => setChatOpen(false)}
        aria-label="Collapse chat"
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        <PanelRight className="size-3.5" aria-hidden="true" />
      </button>
    </header>
  );
}
