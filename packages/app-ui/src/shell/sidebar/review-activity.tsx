import { Check, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Icon } from "../../components/icon";
import { ReviewActivity } from "../../components/review-activity";
import { useReviewActivityState } from "../review-activity-state";

export function SidebarReviewActivity({
  sessionId,
  active,
}: {
  readonly sessionId: string;
  readonly active: boolean;
}) {
  const state = useReviewActivityState((s) => s.bySession[sessionId]);
  const acknowledge = useReviewActivityState((s) => s.acknowledge);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (active && state?.kind === "complete") acknowledge(sessionId);
    if (state?.kind !== "complete") return;
    const timer = setTimeout(() => setNow(Date.now()), 1200);
    return () => clearTimeout(timer);
  }, [state, active, acknowledge, sessionId]);
  if (!state) return null;
  if (state.kind === "running")
    return (
      <span title="Reviewing the change">
        <ReviewActivity className="size-3.5" />
      </span>
    );
  if (state.kind === "failed")
    return (
      <span title={state.reason}>
        <Icon
          icon={CircleAlert}
          aria-label={`Review failed: ${state.reason}`}
          aria-hidden={false}
          className="size-3.5 text-destructive"
        />
      </span>
    );
  if (active) return null;
  return (
    <span title="Review ready" role="status" aria-label="Review ready">
      {now - state.at < 1200 ? (
        <Icon
          icon={Check}
          className="size-3.5 text-primary motion-safe:animate-in motion-safe:zoom-in"
        />
      ) : (
        <span className="block size-1.5 rounded-full bg-primary" />
      )}
    </span>
  );
}
