import { Button } from "@rennet/ui";
import { Loader2, type LucideIcon } from "lucide-react";
import { useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// The hand-off's one exit CTA, shared by both modes (C08 cluster 4, Objective clause 3, R31):
// a full-size action that shows the submission IN FLIGHT (full contrast — a live state, not a
// dimmed control) before the lane swaps to its receipt. Presentational: the real egress is the
// `onSubmit` the lane hands in (the registered `publish.*` commands, wired in cluster 6). When
// no egress is wired yet the CTA renders `disabled` — honest, never a button that lies.
//
// The happy path does NOT reset `submitting` on success: `onSubmit` resolving is the lane's cue
// to swap to its receipt, unmounting this button — so only a REJECTION resets it (retry stays
// possible). Nothing here posts; nothing leaves without the sign-click `onSubmit` carries.
// ─────────────────────────────────────────────────────────────────────────────

export interface HandoffActionProps {
  readonly label: string;
  readonly pendingLabel: string;
  readonly icon: LucideIcon;
  /** The egress. Absent ⇒ the CTA is present but disabled (no egress wired). */
  readonly onSubmit?: () => Promise<void>;
}

export function HandoffAction({ label, pendingLabel, icon: Icon, onSubmit }: HandoffActionProps) {
  const [submitting, setSubmitting] = useState(false);
  return (
    <Button
      size="lg"
      disabled={!onSubmit || submitting}
      onClick={async () => {
        if (!onSubmit) return;
        setSubmitting(true);
        try {
          await onSubmit();
        } catch {
          setSubmitting(false); // a failed post reopens the control; a success unmounts it
        }
      }}
      // In flight keeps full contrast — a live state, not an inert control (R31).
      className="h-12 w-fit gap-2.5 px-7 text-base font-semibold disabled:opacity-100"
    >
      {submitting ? (
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      ) : (
        <Icon className="size-5" aria-hidden="true" />
      )}
      {submitting ? pendingLabel : label}
    </Button>
  );
}
