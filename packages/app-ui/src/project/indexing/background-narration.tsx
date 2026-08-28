import { proactiveRehydrationCommandId } from "@rennet/protocol";
import { useEffect } from "react";
import { useBridge, useCommand } from "../../data";
import { useRennetStore } from "../../store";

/**
 * The app-level subscriber for background narration — the proactive rehydration
 * pass and the knowledge swarm that rides it (#592).
 *
 * It is mounted ABOVE the route switch on purpose. The indexing screen used to
 * own this subscription itself, which made a background failure visible only to
 * a reader who happened to be looking at that screen when it happened: the
 * swarm runs for minutes after `project.process` resolves, and the moment the
 * reader navigated away the listener died with the component. A failure you can
 * only see if you were watching is barely more visible than one never narrated,
 * which is the whole point of the change this belongs to. Subscribing here and
 * retaining into the store means the line is still there when the screen opens.
 *
 * The channel is keyed PER PROJECT (`proactiveRehydrationCommandId`). It used to
 * be one process-global id, so every project's background pass was broadcast
 * onto every project's build timeline.
 */
export function BackgroundNarration() {
  const bridge = useBridge();
  const { data } = useCommand("projects.list", {});
  const projects = data?.projects;

  useEffect(() => {
    if (!projects || !bridge.onProgress) return;
    const append = useRennetStore.getState().uiActions.appendBackgroundEvent;
    const unsubscribes = projects.map((project) =>
      bridge.onProgress?.(proactiveRehydrationCommandId(project.id), (event) =>
        append(project.id, event),
      ),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe?.();
    };
  }, [bridge, projects]);

  return null;
}
