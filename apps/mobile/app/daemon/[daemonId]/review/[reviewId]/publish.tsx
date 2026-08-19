// Review · publish (issue #382 M2, wireframe 23). Preview → post, from anywhere. The preview shows
// the composed outbound review — verdict + destination — and one tap posts it; the posted screen
// states the real URL. No sign step, no biometric, no confirmation dialog: the post button IS the
// click. "Ask for changes" routes to a refine turn (never phone-editing the outbound review).
//
// The phone cannot compose the byte-exact payload (that lives in the DOM ui layer, off-limits to
// the mobile boundary), so the daemon composes it via `publish.compose` and the phone posts EXACTLY
// what it returned. Own-branch composes fully here; a team-PR review preview renders from the
// projected review and is posted from the desktop for now (truthful, never a dead post button).
// Idempotency is the engine's — a double tap / retry yields exactly one PR (or review).

import { useLocalSearchParams, useRouter } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  Card,
  OutlineButton,
  PrimaryButton,
  Screen,
  SectionLabel,
} from "../../../../../src/components/ui";
import { newCommandId } from "../../../../../src/lib/ids";
import {
  useConnection,
  useReviewFocus,
  useReviewLoad,
} from "../../../../../src/runtime/use-connection";
import { space, type } from "../../../../../src/theme/tokens";
import { useTheme } from "../../../../../src/theme/use-theme";

type Composed =
  | { readonly status: "loading" }
  | {
      readonly status: "pr";
      readonly submission: unknown;
      readonly payload: string;
      readonly destination: string;
      readonly title: string;
    }
  | { readonly status: "team-pr"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

type Posting =
  | { readonly phase: "idle" }
  | { readonly phase: "posting" }
  | { readonly phase: "posted"; readonly url: string }
  | { readonly phase: "failed"; readonly reason: string };

/** Derive the display verdict for a team-PR review from its dispositions. */
function verdictOf(dispositions: readonly { type?: string }[] | undefined): string {
  if (!dispositions || dispositions.length === 0) return "Comment";
  if (dispositions.some((d) => d.type === "request-change")) return "Request changes";
  if (dispositions.some((d) => d.type === "approve")) return "Approve";
  return "Comment";
}

export default function Publish(): ReactNode {
  const t = useTheme();
  const router = useRouter();
  const { daemonId, reviewId } = useLocalSearchParams<{ daemonId: string; reviewId: string }>();
  // Landing on the preview reports focus and clears the review's attention — including
  // publish-ready (clears on preview view, #382 M2 task 4.3).
  useReviewFocus(daemonId, reviewId);
  const connection = useConnection(daemonId);
  const loaded = useReviewLoad(daemonId, reviewId);
  const [composed, setComposed] = useState<Composed>({ status: "loading" });
  const [posting, setPosting] = useState<Posting>({ phase: "idle" });

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    connection.supervisor
      .invoke("publish.compose", { commandId: newCommandId(), reviewId })
      .then((result) => {
        if (cancelled) return;
        if (result.status === "pr") {
          setComposed({
            status: "pr",
            submission: result.submission,
            payload: result.payload,
            destination: result.destination,
            title: result.title,
          });
        } else {
          // Unavailable: a team-PR review previews here but posts from the desktop for now.
          const review = loaded.review as { postTarget?: unknown } | undefined;
          setComposed(
            review?.postTarget
              ? { status: "team-pr", reason: result.reason }
              : { status: "unavailable", reason: result.reason },
          );
        }
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setComposed({
            status: "unavailable",
            reason: error instanceof Error ? error.message : "The preview could not be composed.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [connection, reviewId, loaded.review]);

  async function postPr(submission: unknown, payload: string): Promise<void> {
    if (!connection) return;
    setPosting({ phase: "posting" });
    try {
      // One tap posts. Idempotent by head branch: a double tap / retry yields exactly one PR.
      const outcome = await connection.supervisor.invoke("publish.submitPr", {
        commandId: newCommandId(),
        reviewId,
        submission: submission as never,
        payload,
      });
      setPosting({ phase: "posted", url: outcome.url });
    } catch (error) {
      setPosting({
        phase: "failed",
        reason: error instanceof Error ? error.message : "The post did not land.",
      });
    }
  }

  if (posting.phase === "posted") {
    return (
      <Screen>
        <View style={{ alignItems: "center", marginTop: space.xxl }}>
          <Text style={{ fontSize: 44, color: t.green }}>✓</Text>
          <Text
            style={{ color: t.ink, fontSize: type.title, fontWeight: "600", marginTop: space.md }}
          >
            Posted
          </Text>
          <Text
            style={{
              color: t.blueInk,
              fontSize: type.body,
              marginTop: space.sm,
              textAlign: "center",
            }}
          >
            {posting.url}
          </Text>
          <View style={{ marginTop: space.xl, alignSelf: "stretch" }}>
            <OutlineButton label="Done" onPress={() => router.back()} />
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView>
        <SectionLabel>Preview</SectionLabel>
        {composed.status === "loading" ? (
          <Text style={{ color: t.muted }}>
            {connection
              ? "Composing the outbound review…"
              : "Daemon unreachable — showing the last replica."}
          </Text>
        ) : composed.status === "pr" ? (
          <>
            <Card>
              <Text style={{ color: t.faint, fontSize: type.control }}>{composed.destination}</Text>
              <Text style={{ color: t.text, fontSize: type.body, fontWeight: "600", marginTop: 4 }}>
                {composed.title}
              </Text>
              <Text style={{ color: t.muted, fontSize: type.control, marginTop: space.sm }}>
                Own branch · drafted body · opens exactly one PR
              </Text>
            </Card>
            <PrimaryButton
              label={posting.phase === "posting" ? "Posting…" : "↗ Open pull request"}
              onPress={() => void postPr(composed.submission, composed.payload)}
            />
          </>
        ) : composed.status === "team-pr" ? (
          <Card>
            <Text style={{ color: t.green, fontSize: type.control, fontWeight: "600" }}>
              {verdictOf((loaded.review as { dispositions?: { type?: string }[] })?.dispositions)}
            </Text>
            <Text style={{ color: t.text, fontSize: type.body, marginTop: space.xs }}>
              {(loaded.review as { dispositions?: unknown[] })?.dispositions?.length ?? 0} judged
              findings collated · your dispositions · your voice
            </Text>
            <Text style={{ color: t.muted, fontSize: type.control, marginTop: space.sm }}>
              {composed.reason}
            </Text>
          </Card>
        ) : (
          <Text style={{ color: t.amber }}>{composed.reason}</Text>
        )}

        {posting.phase === "failed" ? (
          <Text style={{ color: t.amber, fontSize: type.control, marginTop: space.sm }}>
            {posting.reason}
          </Text>
        ) : null}

        <SectionLabel>Not right?</SectionLabel>
        <OutlineButton
          label="↻ Ask for changes"
          onPress={() => router.push(`/daemon/${daemonId}/review/${reviewId}/turn`)}
        />
        <Text style={{ color: t.faint, fontSize: type.control, marginTop: 6 }}>
          Ask for changes runs a refine turn — the phone never text-edits the outbound review.
        </Text>

        <View style={{ height: space.xxl }} />
      </ScrollView>
    </Screen>
  );
}
