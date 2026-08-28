import type {
  CommandInput,
  CommandName,
  CommandOutput,
  ProjectDetailProgressEvent,
  ProjectProcessEvent,
  RennetBridge,
  ReviewAskStreamEvent,
  RoundEvent,
} from "@rennet/protocol";
import { useEffect, useRef } from "react";
import { useBridgeContext } from "./bridge";
import { commandKey } from "./cache";

// ─────────────────────────────────────────────────────────────────────────────
// useCommandStream (C01 §2.4) — subscribe a keyed push channel and FOLD each event
// into the matching `useCommand` cache entry, so a component reads one cache entry and
// never a second event state. The three keyed channels map to a command read:
//   • progress               (onProgress, keyed by commandId)        → project.process
//   • projectDetailProgress  (onProjectDetailProgress, by commandId) → project.detail
//   • askStream              (onAskStream, keyed by reviewId)        → review.ask
//   • roundProgress          (onRoundProgress, keyed by reviewId)    → session.roundEvents
// The daemon-wide channels (onAttention/onUpdateReady) fold into the store, not a read,
// so they are consumed directly, not through this hook.
// ─────────────────────────────────────────────────────────────────────────────

interface ChannelEvent {
  progress: ProjectProcessEvent;
  projectDetailProgress: ProjectDetailProgressEvent;
  askStream: ReviewAskStreamEvent;
  roundProgress: RoundEvent;
}
type StreamChannelName = keyof ChannelEvent;

function subscribeChannel<C extends StreamChannelName>(
  bridge: RennetBridge,
  channel: C,
  subscriptionKey: string,
  listener: (event: ChannelEvent[C]) => void,
): (() => void) | undefined {
  switch (channel) {
    case "progress":
      return bridge.onProgress?.(subscriptionKey, listener as (e: ProjectProcessEvent) => void);
    case "projectDetailProgress":
      return bridge.onProjectDetailProgress?.(
        subscriptionKey,
        listener as (e: ProjectDetailProgressEvent) => void,
      );
    case "askStream":
      return bridge.onAskStream?.(subscriptionKey, listener as (e: ReviewAskStreamEvent) => void);
    case "roundProgress":
      return bridge.onRoundProgress?.(subscriptionKey, listener as (e: RoundEvent) => void);
    default:
      return undefined;
  }
}

export interface UseCommandStreamParams<K extends CommandName, C extends StreamChannelName> {
  /** Which keyed push channel to subscribe. */
  readonly channel: C;
  /** The subscription key (commandId or reviewId). `undefined` disables the subscription. */
  readonly subscriptionKey: string | undefined;
  /** The `useCommand` read this stream folds into. */
  readonly command: { readonly name: K; readonly input: CommandInput<K> };
  /** Fold one event into the read's cached data. */
  readonly fold: (prev: CommandOutput<K> | undefined, event: ChannelEvent[C]) => CommandOutput<K>;
}

export function useCommandStream<K extends CommandName, C extends StreamChannelName>(
  params: UseCommandStreamParams<K, C>,
): void {
  const { bridge, cache } = useBridgeContext();
  const key = commandKey(params.command.name, params.command.input);
  const foldRef = useRef(params.fold);
  foldRef.current = params.fold;
  const { channel, subscriptionKey } = params;

  useEffect(() => {
    if (subscriptionKey === undefined) return;
    const unsubscribe = subscribeChannel(bridge, channel, subscriptionKey, (event) => {
      cache.setData(key, (prev) => foldRef.current(prev as CommandOutput<K> | undefined, event));
    });
    return unsubscribe;
  }, [bridge, cache, key, channel, subscriptionKey]);
}
