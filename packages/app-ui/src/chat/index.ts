// The chat dock (C07, #489): the persistent conversation dock — header, transcript
// (turns, thought blocks, action steps, streaming prose, honest compaction, anchored
// threads), and composer — mounted ONCE into C3's layout slot. Presentation ported from
// the board-prototype spike; state rewritten onto the C01 data seam (`review.ask` /
// `review.reattach` / `onAskStream`), the real `review` store slice, and a B9-stubbed
// session-transcript projection. See `chat-data.ts` for the single resolution point.

// The seam + the B9 projection stub: an external wirer (cluster 7 / the desktop app)
// supplies the live session's transcript, trail, context figure, and reviewId here.
export type {
  ActionStepData,
  ActivityStep,
  ChatDockModel,
  ChatTrail,
  CodeBlockData,
  CompactBoundaryRow,
  ContentBlock,
  ContextRebuiltRow,
  ContextWindow,
  DetachedThreadRef,
  DetachedThreadsRow,
  ProseBlock,
  SessionTranscriptProjection,
  Speaker,
  ThoughtBlockData,
  TranscriptRow,
  TurnRow,
  TurnStatus,
} from "./chat-data";
export {
  EMPTY_TRANSCRIPT,
  SessionTranscriptProvider,
  transcriptRowsOf,
  useSessionTranscript,
} from "./chat-data";
export { ChatDock } from "./chat-dock";
export { EngineChatDock, T3ChatDock, useRouteChatEngine } from "./engine-chat-dock";
export { T3ChatSlotProvider, type T3NativeChatProps, useT3NativeChat } from "./t3-chat-slot";
