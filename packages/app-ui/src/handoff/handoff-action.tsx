import { Button, Spinner } from "@rennet/ui";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Icon } from "../components/icon";

// ─────────────────────────────────────────────────────────────────────────────
// The hand-off's one exit CTA, shared by both modes (C08 cluster 4, Objective clause 3, R31):
// a full-size action that shows the submission IN FLIGHT (full contrast — a live state, not a
// dimmed control) before the lane swaps to its receipt. Presentational: the real egress is the
// `onSubmit` the lane hands in (the registered `publish.*` commands, wired in cluster 6). When
// no egress is wired yet the CTA renders `disabled` — honest, never a button that lies.
//
// The happy path does NOT reset `submitting` on success: `onSubmit` resolving is the lane's cue
// to swap to its receipt, unmounting this button — so only a REJECTION resets it (retry stays
// possible) AND surfaces the reason beside the re-armed control. A failed post that renders
// nothing is a silent lie (the reviewer can't tell it didn't post); the reason is the honest
// failure state. Nothing here posts; nothing leaves without the sign-click `onSubmit` carries.
// ─────────────────────────────────────────────────────────────────────────────

export interface HandoffActionProps {
  readonly label: string;
  readonly pendingLabel: string;
  readonly icon: LucideIcon;
  /** The egress. Absent ⇒ the CTA is present but disabled (no egress wired). */
  readonly onSubmit?: () => Promise<void>;
}

/** The message a rejected `onSubmit` carries, defended for the non-Error throw. */
function rejectionReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "The submission failed. Nothing left the machine — try again.";
}

export function HandoffAction({ label, pendingLabel, icon: glyph, onSubmit }: HandoffActionProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        size="lg"
        disabled={!onSubmit || submitting}
        onClick={async () => {
          if (!onSubmit) return;
          setSubmitting(true);
          setError(null);
          try {
            await onSubmit();
          } catch (caught) {
            // A failed post reopens the control (a success unmounts it) AND names the reason,
            // so the reviewer sees the failure honestly instead of a silently re-armed button.
            setSubmitting(false);
            setError(rejectionReason(caught));
          }
        }}
        // In flight keeps full contrast — a live state, not an inert control (R31).
        className="h-12 w-fit gap-2.5 px-7 text-15 font-semibold disabled:opacity-100"
      >
        {submitting ? (
          <Spinner className="size-4.5" aria-hidden="true" />
        ) : (
          <Icon icon={glyph} className="size-4.5" />
        )}
        {submitting ? pendingLabel : label}
      </Button>
      {error !== null && (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
          <Icon icon={AlertTriangle} className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
