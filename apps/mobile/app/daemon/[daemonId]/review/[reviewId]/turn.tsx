// Review · live turn & ask (issue #382 M2, wireframe 22). The reattach-paint + live-stream turn
// screen: entering paints persisted thread state (`review.reattach`), then the supervisor's
// rebind-safe `onAskStream` appends live events into the virtualized typed timeline. A visible
// Stop interrupts the running turn (`review.interrupt`); the interrupted outcome renders
// truthfully. The ask card composes chips + free text into ONE `review.ask` reply; Send
// interrupts the running turn, hold sends without interrupting. Drafts persist per review.
//
// Reattach is the NORMAL case, not recovery: the supervisor re-issues it and re-binds the stream
// on every reconnect, so a mid-turn network change keeps the timeline flowing and never renders
// the turn as hung. The timeline fold is the pure, tested reducer in lib/turn-timeline.

import type { AttentionAction } from "@rennet/protocol";
import { useLocalSearchParams } from "expo-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { AnswerChip, Card, Screen, StopButton } from "../../../../../src/components/ui";
import { composeAskReply } from "../../../../../src/lib/ask-reply";
import { newCommandId } from "../../../../../src/lib/ids";
import {
  emptyTimeline,
  foldStreamEvent,
  isTurnRunning,
  reattach,
  type TimelineEntry,
  type TimelineState,
} from "../../../../../src/lib/turn-timeline";
import { useRuntime } from "../../../../../src/runtime/context";
import { useConnection, useReviewFocus } from "../../../../../src/runtime/use-connection";
import { createAskDraftStore } from "../../../../../src/stores/native";
import { space, type } from "../../../../../src/theme/tokens";
import { useTheme } from "../../../../../src/theme/use-theme";

export default function Turn(): ReactNode {
  const t = useTheme();
  const runtime = useRuntime();
  const { daemonId, reviewId } = useLocalSearchParams<{ daemonId: string; reviewId: string }>();
  // The turn screen is the ask-pending landing (#382 M2 finding 10): clear exactly that.
  useReviewFocus(daemonId, reviewId, "ask-pending");
  const connection = useConnection(daemonId);
  const supervisor = connection?.supervisor;

  const [timeline, setTimeline] = useState<TimelineState>(emptyTimeline);
  const [atTail, setAtTail] = useState(true);
  const listRef = useRef<FlatList<TimelineEntry>>(null);

  // Reattach paint + live stream (decision 1). The supervisor's onAskStream is rebind-safe, so a
  // reconnect keeps this subscription live; the supervisor also re-issues review.reattach on
  // reconnect, whose result folds in here idempotently (the reducer never double-renders).
  useEffect(() => {
    if (!supervisor) return;
    let cancelled = false;
    supervisor
      .invoke("review.reattach", { commandId: newCommandId(), reviewId })
      .then((result) => {
        if (!cancelled) setTimeline((s) => reattach(s, result));
      })
      .catch(() => undefined);
    const unsubscribe = supervisor.onAskStream(reviewId, (event) => {
      setTimeline((s) => foldStreamEvent(s, event));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [supervisor, reviewId]);

  // Follow the live tail while the user has not scrolled up.
  useEffect(() => {
    if (atTail && timeline.entries.length > 0) listRef.current?.scrollToEnd({ animated: true });
  }, [timeline, atTail]);

  const running = isTurnRunning(timeline);
  const chips = runtime.registry.askActionsFor(reviewId);
  // A pre-M2 daemon never advertises `act`, so it cannot honour `review.interrupt`. Stop stays
  // VISIBLE but disabled (truthful) rather than silently no-opping the tap (#382 M2, Finding A).
  const canInterrupt = supervisor?.actAdvertised() ?? false;

  const stop = useCallback(() => {
    void supervisor
      ?.invoke("review.interrupt", { commandId: newCommandId(), reviewId })
      .catch(() => undefined);
  }, [supervisor, reviewId]);

  return (
    <Screen>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: t.accent, fontSize: type.control }}>
          {running ? "turn running · reattached" : "reattached"}
        </Text>
        {running ? (
          <StopButton
            label={canInterrupt ? "◼ Stop" : "◼ Stop · update daemon"}
            onPress={stop}
            disabled={!canInterrupt}
          />
        ) : null}
      </View>

      <FlatList
        ref={listRef}
        style={{ marginTop: space.sm }}
        data={timeline.entries}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <TimelineRow entry={item} />}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={9}
        removeClippedSubviews
        onScrollBeginDrag={() => setAtTail(false)}
        onMomentumScrollEnd={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const distanceFromEnd = contentSize.height - (contentOffset.y + layoutMeasurement.height);
          setAtTail(distanceFromEnd < 40);
        }}
        ListEmptyComponent={
          <Text style={{ color: t.muted, marginTop: space.lg }}>
            {supervisor
              ? "Reattaching the turn…"
              : "Daemon unreachable — showing the last replica."}
          </Text>
        }
      />

      {!atTail && timeline.entries.length > 0 ? (
        <Pressable
          onPress={() => {
            setAtTail(true);
            listRef.current?.scrollToEnd({ animated: true });
          }}
          style={{ alignSelf: "center", paddingVertical: space.xs }}
        >
          <Text style={{ color: t.accent, fontSize: type.control }}>↓ return to tail</Text>
        </Pressable>
      ) : null}

      <AskComposer daemonId={daemonId} reviewId={reviewId} chips={chips} running={running} />
    </Screen>
  );
}

/** One timeline row: the reviewer's message or a harness turn, with a truthful status line. */
function TimelineRow({ entry }: { entry: TimelineEntry }): ReactNode {
  const t = useTheme();
  const you = entry.author === "you";
  const statusLabel =
    entry.status === "streaming"
      ? "streaming"
      : entry.status === "interrupted"
        ? "interrupted"
        : (entry.model ?? entry.channel ?? "harness");
  return (
    <Card>
      <Text
        style={{
          color: entry.status === "interrupted" ? t.danger : t.faint,
          fontSize: type.pill,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        {you ? "you" : statusLabel}
      </Text>
      <Text style={{ color: t.text, fontSize: type.body, lineHeight: 22 }}>
        {entry.body || (entry.status === "streaming" ? "…" : "")}
      </Text>
    </Card>
  );
}

/**
 * The ask composer: answer chips (when the daemon attached them) + a free-text direction, composed
 * into ONE review.ask reply. Send interrupts the running turn then sends; hold (long-press) sends
 * without interrupting. The direction persists per review across navigation.
 */
function AskComposer({
  daemonId,
  reviewId,
  chips,
  running,
}: {
  daemonId: string;
  reviewId: string;
  chips: readonly AttentionAction[];
  running: boolean;
}): ReactNode {
  const t = useTheme();
  const connection = useConnection(daemonId);
  const draftStore = useMemo(() => createAskDraftStore(), []);
  const [chip, setChip] = useState<string | null>(null);
  const [direction, setDirection] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // Load the persisted draft on mount; persist on change (an empty draft clears the ghost).
  useEffect(() => {
    let cancelled = false;
    void draftStore.load(reviewId).then((d) => {
      if (!cancelled) setDirection(d);
    });
    return () => {
      cancelled = true;
    };
  }, [draftStore, reviewId]);
  useEffect(() => {
    void draftStore.save(reviewId, direction).catch(() => undefined);
  }, [draftStore, reviewId, direction]);

  const reply = composeAskReply({ chipLabel: chip ?? undefined, direction });
  const canSend = reply.length > 0 && !sending && !!connection;

  const send = useCallback(
    async (interrupt: boolean) => {
      if (!connection || reply.length === 0) return;
      setSending(true);
      setFailed(null);
      try {
        // Send interrupts the running turn first (decision 2); hold skips the interrupt.
        if (interrupt && running) {
          await connection.supervisor.invoke("review.interrupt", {
            commandId: newCommandId(),
            reviewId,
          });
        }
        const turnId = newCommandId();
        await connection.supervisor.invoke("review.ask", {
          commandId: newCommandId(),
          reviewId,
          question: reply,
          mode: "orchestrator",
          threadId: reviewId,
          turnId,
          anchor: { kind: "fragment", label: "steer", key: reviewId },
          turnBody: reply,
        });
        // Sent — clear the composed answer and its persisted draft.
        setChip(null);
        setDirection("");
      } catch (error) {
        // A genuine send failure renders truthfully — never a silently dropped answer.
        setFailed(error instanceof Error ? error.message : "The answer did not send.");
      } finally {
        setSending(false);
      }
    },
    [connection, reply, running, reviewId],
  );

  return (
    <View style={{ paddingTop: space.sm, paddingBottom: space.md }}>
      {chips.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: space.sm }}>
          {chips.map((c) => (
            <AnswerChip
              key={c.id}
              label={c.label}
              selected={chip === c.label}
              onPress={() => setChip((prev) => (prev === c.label ? null : c.label))}
            />
          ))}
        </View>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <TextInput
          value={direction}
          onChangeText={setDirection}
          placeholder={chips.length > 0 ? "Answer with direction… (optional)" : "Steer the turn…"}
          placeholderTextColor={t.faint}
          style={{
            flex: 1,
            color: t.text,
            fontSize: type.body,
            borderWidth: 1,
            borderColor: t.line2,
            borderRadius: 10,
            paddingHorizontal: 14,
            paddingVertical: 12,
            backgroundColor: t.card,
          }}
        />
        <Pressable
          onPress={() => void send(true)}
          onLongPress={() => void send(false)}
          disabled={!canSend}
          style={{
            backgroundColor: canSend ? t.ink : t.line2,
            width: 46,
            height: 46,
            borderRadius: 10,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: t.canvas, fontSize: type.body, fontWeight: "700" }}>›</Text>
        </Pressable>
      </View>

      <Text style={{ color: failed ? t.danger : t.faint, fontSize: type.control, marginTop: 6 }}>
        {failed ??
          (running ? "send interrupts · hold to send without interrupting" : "hold to send")}
      </Text>
    </View>
  );
}
