// Review · publish (issue #382 M2, wireframe 23). Preview → post, from anywhere. The preview shows
// the composed outbound review — verdict + destination — and one tap posts it; the posted screen
// states the real URL. No sign step, no biometric, no confirmation dialog: the post button IS the
// click. "Ask for changes" routes to a refine turn (never phone-editing the outbound review).
//
// The phone cannot compose the byte-exact payload (the DOM ui layer owns the editable collation
// model, off-limits to the mobile boundary), so the DAEMON composes it via `publish.compose` and
// the phone posts EXACTLY what it returned. Finding C ruling (a): BOTH loops end on the phone —
//   • a team-PR review (`postTarget` present) composes in `mode: "review"` and posts via
//     `publish.review` (dryRun:false);
//   • an own-branch capture composes in `mode: "pr"` and posts via `publish.submitPr`.
// Idempotency is the engine's — a double tap / retry yields exactly one review (or one PR).

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
import { fontFamily, space, type } from "../../../../../src/theme/tokens";
import { useTheme } from "../../../../../src/theme/use-theme";

type ReviewComment = {
  readonly path: string;
  readonly line?: number;
  readonly side: "LEFT" | "RIGHT";
  readonly type: string;
  readonly body: string;
};
type PostTarget = {
  repo: { forge: string; owner: string; name: string };
  number: number;
  forgeRef: string;
  headOid: string;
};

type PrSubmission = {
  readonly title: string;
  readonly body: string;
  readonly base: string;
  readonly head: string;
  readonly draft: boolean;
};

type Composed =
  | { readonly status: "loading" }
  | {
      readonly status: "review";
      readonly comments: readonly ReviewComment[];
      readonly payload: string;
      readonly verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      readonly destination: string;
      readonly title: string;
      readonly target: PostTarget;
      readonly compositionId: string;
    }
  | {
      readonly status: "pr";
      readonly submission: PrSubmission;
      readonly payload: string;
      readonly destination: string;
      readonly title: string;
      readonly compositionId: string;
    }
  | { readonly status: "unavailable"; readonly reason: string };

type Posting =
  | { readonly phase: "idle" }
  | { readonly phase: "posting" }
  | { readonly phase: "posted"; readonly url: string }
  | { readonly phase: "failed"; readonly reason: string };

/** Human label for the GitHub review event the post will carry. */
function verdictLabel(verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"): string {
  return verdict === "REQUEST_CHANGES"
    ? "Request changes"
    : verdict === "APPROVE"
      ? "Approve"
      : "Comment";
}

export default function Publish(): ReactNode {
  const t = useTheme();
  const router = useRouter();
  const { daemonId, reviewId } = useLocalSearchParams<{ daemonId: string; reviewId: string }>();
  // Landing on the preview reports focus (push suppression) but does NOT clear publish-ready here
  // (#382 M2 finding 10): publish.compose below RE-RAISES publish-ready, so the clear must land
  // AFTER a successful compose, not on mount — otherwise the re-raise leaves a stale badge. No
  // `family` ⇒ presence only; the ack happens in the compose success handler.
  useReviewFocus(daemonId, reviewId);
  const connection = useConnection(daemonId);
  const loaded = useReviewLoad(daemonId, reviewId);
  const [composed, setComposed] = useState<Composed>({ status: "loading" });
  const [posting, setPosting] = useState<Posting>({ phase: "idle" });

  // The review determines the loop: a team-PR review (postTarget present) posts a review; an
  // own-branch capture opens a PR. Wait for the loaded review before composing so the mode fits.
  const review = loaded.review as { postTarget?: PostTarget } | undefined;
  const mode: "review" | "pr" | undefined =
    review === undefined ? undefined : review.postTarget ? "review" : "pr";

  useEffect(() => {
    // Reset per-review state on every route/mode change (#382 M2 finding 2): expo-router reuses
    // this component across params, so without this the PREVIOUS review's composed preview (and a
    // stale "posted" screen) would flash while the new one loads. Always start from a clean slate.
    setComposed({ status: "loading" });
    setPosting({ phase: "idle" });
    if (!connection || mode === undefined) return;
    let cancelled = false;
    // A pre-M2 daemon never advertises `act`, so it has no `publish.compose`. Say so truthfully
    // (like the turn screen's Stop) instead of surfacing a raw "unknown command" throw (#382 M2,
    // Finding C).
    if (!connection.supervisor.actAdvertised()) {
      setComposed({
        status: "unavailable",
        reason: "This daemon needs updating to preview and post from the phone.",
      });
      return;
    }
    connection.supervisor
      .invoke("publish.compose", { commandId: newCommandId(), reviewId, mode })
      .then((result) => {
        if (cancelled) return;
        if (result.status === "review") {
          const target = review?.postTarget;
          if (!target) {
            setComposed({
              status: "unavailable",
              reason: "This review has no pull request to post to.",
            });
            return;
          }
          setComposed({
            status: "review",
            comments: result.comments,
            payload: result.payload,
            verdict: result.verdict,
            destination: result.destination,
            title: result.title,
            target,
            compositionId: result.compositionId,
          });
        } else if (result.status === "pr") {
          setComposed({
            status: "pr",
            submission: result.submission,
            payload: result.payload,
            destination: result.destination,
            title: result.title,
            compositionId: result.compositionId,
          });
        } else {
          setComposed({ status: "unavailable", reason: result.reason });
          return;
        }
        // Clear publish-ready AFTER a successful compose (#382 M2 finding 10): compose itself
        // re-raised it, so this is the clear-on-view, landing after the raise. Exact id only —
        // viewing the preview never silences a live ask on the same review.
        void connection.supervisor
          .invoke("attention.acknowledge", { attentionId: `publish-ready:${reviewId}` })
          .catch(() => undefined);
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
  }, [connection, reviewId, mode, review?.postTarget]);

  async function postReview(c: Extract<Composed, { status: "review" }>): Promise<void> {
    if (!connection) return;
    setPosting({ phase: "posting" });
    try {
      // One tap posts — the tap IS the authorization, there is no token and no confirm step.
      // The composed `compositionId` binds these bytes AND this verdict, so the engine refuses
      // anything but the composition previewed above. The engine's idempotency marker makes a
      // double tap / retry reuse the same review — exactly one lands.
      const outcome = await connection.supervisor.invoke("publish.review", {
        commandId: newCommandId(),
        reviewId,
        target: c.target as never,
        comments: c.comments as never,
        payload: c.payload,
        verdict: c.verdict,
        compositionId: c.compositionId,
        dryRun: false,
      });
      if (!outcome.outcome) {
        setPosting({ phase: "failed", reason: "The post did not land (nothing was posted)." });
        return;
      }
      setPosting({ phase: "posted", url: outcome.outcome.url ?? c.destination });
    } catch (error) {
      setPosting({
        phase: "failed",
        reason: error instanceof Error ? error.message : "The post did not land.",
      });
    }
  }

  async function postPr(c: Extract<Composed, { status: "pr" }>): Promise<void> {
    if (!connection) return;
    setPosting({ phase: "posting" });
    try {
      // One tap posts. Idempotent by head branch: a double tap / retry yields exactly one PR.
      const outcome = await connection.supervisor.invoke("publish.submitPr", {
        commandId: newCommandId(),
        reviewId,
        submission: c.submission as never,
        payload: c.payload,
        compositionId: c.compositionId,
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
            style={{
              color: t.ink,
              fontSize: type.title,
              fontFamily: fontFamily.display,
              marginTop: space.md,
            }}
          >
            Posted
          </Text>
          <Text
            style={{
              color: t.accent,
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
        ) : composed.status === "review" ? (
          <>
            <Card>
              <Text style={{ color: t.faint, fontSize: type.control }}>{composed.destination}</Text>
              <Text
                style={{
                  color: composed.verdict === "REQUEST_CHANGES" ? t.accent : t.green,
                  fontSize: type.control,
                  fontWeight: "600",
                  marginTop: 4,
                }}
              >
                {verdictLabel(composed.verdict)}
              </Text>
              <Text style={{ color: t.muted, fontSize: type.control, marginTop: space.xs }}>
                {composed.comments.length} comment{composed.comments.length === 1 ? "" : "s"} ·
                exactly what posts
              </Text>
            </Card>
            {/* Show EVERY comment in full — path (+line) and body — so the preview is the whole
                outbound review, never a "3 comments collated" summary that hides what posts
                (#382 M2 finding 1). This is the product's core promise: what you preview is what
                posts. */}
            {composed.comments.map((c) => (
              <Card key={`${c.path}:${c.line ?? "file"}:${c.side}:${c.type}`}>
                <Text style={{ color: t.faint, fontSize: type.control }}>
                  {c.path}
                  {c.line !== undefined ? `:${c.line}` : ""} · {c.side} · {c.type}
                </Text>
                <Text
                  style={{
                    color: t.text,
                    fontSize: type.body,
                    lineHeight: 22,
                    marginTop: space.xs,
                  }}
                >
                  {c.body}
                </Text>
              </Card>
            ))}
            <PrimaryButton
              label={posting.phase === "posting" ? "Posting…" : "↗ Post review"}
              onPress={() => void postReview(composed)}
            />
          </>
        ) : composed.status === "pr" ? (
          <>
            <Card>
              <Text style={{ color: t.faint, fontSize: type.control }}>{composed.destination}</Text>
              <Text style={{ color: t.text, fontSize: type.body, fontWeight: "600", marginTop: 4 }}>
                {composed.submission.title}
              </Text>
              {/* The full PR the phone opens: base ← head, draft flag, and the whole drafted body —
                  the preview IS the pull request, nothing hidden (#382 M2 finding 1). */}
              <Text style={{ color: t.faint, fontSize: type.control, marginTop: space.xs }}>
                {composed.submission.base} ← {composed.submission.head}
                {composed.submission.draft ? " · draft" : ""}
              </Text>
              <Text
                style={{ color: t.text, fontSize: type.body, lineHeight: 22, marginTop: space.sm }}
              >
                {composed.submission.body || "(no body)"}
              </Text>
            </Card>
            <PrimaryButton
              label={posting.phase === "posting" ? "Posting…" : "↗ Open pull request"}
              onPress={() => void postPr(composed)}
            />
          </>
        ) : (
          <Text style={{ color: t.accent }}>{composed.reason}</Text>
        )}

        {posting.phase === "failed" ? (
          <Text style={{ color: t.danger, fontSize: type.control, marginTop: space.sm }}>
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
