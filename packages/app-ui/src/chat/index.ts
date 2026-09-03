// The chat slot: T3's own thread view, mounted once into C3's layout slot. Rennet's own
// dock — its transcript, composer, thought blocks and `review.ask` send — was retired with
// the orchestrator session (t3-lens-threads 4.2); what survives here is the slot itself,
// the host seam that supplies T3's components, and the header trail the top bar hands off.
export type { ChatTrail } from "./chat-data";
export { useChatTrail, useRouteReviewId } from "./chat-data";
export { T3ChatDock } from "./t3-chat-dock";
export {
  type T3ChatSlotComponents,
  T3ChatSlotProvider,
  type T3NativeChatProps,
  type T3ThreadViewProps,
  useT3ChatSlot,
} from "./t3-chat-slot";
