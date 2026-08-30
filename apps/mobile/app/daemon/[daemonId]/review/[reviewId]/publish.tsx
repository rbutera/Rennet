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

import type { CommandOutput } from "@rennet/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { PreviewMarkdown } from "../../../../../src/components/preview-markdown";
import {
  Card,
  OutlineButton,
  PrimaryButton,
  Screen,
  SectionLabel,
} from "../../../../../src/components/ui";
import { changeRequestCopy } from "../../../../../src/lib/change-request-copy";
import { createComposeRefreshController } from "../../../../../src/lib/compose-refresh";
import { newCommandId } from "../../../../../src/lib/ids";
import { mobilePublishDecision } from "../../../../../src/lib/publish-mode";
import {
  useConnection,
  useReviewFocus,
  useReviewLoad,
} from "../../../../../src/runtime/use-connection";
import { fontFamily, space, type } from "../../../../../src/theme/tokens";
import { useTheme } from "../../../../../src/theme/use-theme";

type Composed = { readonly status: "loading" } | CommandOutput<"publish.compose">;

type Posting =
  | { readonly phase: "idle" }
  | { readonly phase: "posting" }
  | {
      readonly phase: "posted";
      readonly url: string;
      readonly request?: { readonly forge: string | undefined; readonly number: number };
    }
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

  // The same ownership split as desktop: teammate PRs post a review, a branch capture with no
  // existing PR opens one, and an authored existing PR stays in the rounds loop.
  const decision = mobilePublishDecision(loaded.review);
  const mode = decision.status === "mode" ? decision.mode : undefined;
  const unavailableReason = decision.status === "unavailable" ? decision.reason : undefined;

  useEffect(() => {
    // Reset per-review state on every route/mode change (#382 M2 finding 2): expo-router reuses
    // this component across params, so without this the PREVIOUS review's composed preview (and a
    // stale "posted" screen) would flash while the new one loads. Always start from a clean slate.
    setComposed({ status: "loading" });
    setPosting({ phase: "idle" });
    if (unavailableReason !== undefined) {
      setComposed({ status: "unavailable", reason: unavailableReason });
      return;
    }
    if (!connection || mode === undefined) return;
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
    const controller = createComposeRefreshController({
      compose: () =>
        connection.supervisor.invoke("publish.compose", {
          commandId: newCommandId(),
          reviewId,
          mode,
        }),
      onResult: (result) => {
        setComposed(result);
        if (result.status !== "unavailable") {
          // Clear publish-ready AFTER a successful compose (#382 M2 finding 10): compose itself
          // re-raised it, so this is the clear-on-view, landing after the raise. Exact id only —
          // viewing the preview never silences a live ask on the same review.
          void connection.supervisor
            .invoke("attention.acknowledge", { attentionId: `publish-ready:${reviewId}` })
            .catch(() => undefined);
        }
      },
      onError: (error) =>
        setComposed({
          status: "unavailable",
          reason: error instanceof Error ? error.message : "The preview could not be composed.",
        }),
    });
    // Another client can edit the durable ask projection while this signing view stays open,
    // and a completed round can clear it server-side. Hide the now-stale bytes immediately and
    // recompose from that pushed authority; the controller prevents an older in-flight
    // response from overwriting the newer preview.
    const unsubscribe = connection.supervisor.onAskProjection(reviewId, () => {
      setComposed({ status: "loading" });
      controller.refresh();
    });
    controller.start();
    return () => {
      unsubscribe();
      controller.stop();
    };
  }, [connection, reviewId, mode, unavailableReason]);

  async function postReview(c: Extract<Composed, { status: "review" }>): Promise<void> {
    if (!connection) return;
    setPosting({ phase: "posting" });
    try {
      // One tap posts — the tap IS the authorization, there is no token and no confirm step.
      // Round-trip the frozen aggregate exactly. The addressed review supplies the persisted
      // forge target; the event exists only in the descriptor the reviewer saw.
      const outcome = await connection.supervisor.invoke("publish.review", {
        commandId: newCommandId(),
        reviewId,
        artifact: c.artifact,
        post: c.post,
        payload: c.payload,
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
      // One tap posts. Idempotent by head branch: a double tap / retry yields one change request.
      const outcome = await connection.supervisor.invoke("publish.submitPr", {
        commandId: newCommandId(),
        reviewId,
        ...(c.target === undefined ? {} : { target: c.target }),
        submission: c.submission,
        payload: c.payload,
        compositionId: c.compositionId,
      });
      setPosting({
        phase: "posted",
        url: outcome.url,
        request: { forge: c.target?.repo.forge, number: outcome.number },
      });
    } catch (error) {
      setPosting({
        phase: "failed",
        reason: error instanceof Error ? error.message : "The post did not land.",
      });
    }
  }

  if (posting.phase === "posted") {
    const receipt =
      posting.request === undefined
        ? undefined
        : { ...changeRequestCopy(posting.request.forge), number: posting.request.number };
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
            {receipt === undefined
              ? "Posted"
              : `${receipt.opened} · ${receipt.sigil}${receipt.number}`}
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
                  color: composed.post.event === "REQUEST_CHANGES" ? t.accent : t.green,
                  fontSize: type.control,
                  fontWeight: "600",
                  marginTop: 4,
                }}
              >
                {verdictLabel(composed.post.event)}
              </Text>
              <Text style={{ color: t.muted, fontSize: type.control, marginTop: space.xs }}>
                {composed.post.threads.length} thread
                {composed.post.threads.length === 1 ? "" : "s"} · exactly what posts
              </Text>
            </Card>
            <Card>
              <Text style={{ color: t.faint, fontSize: type.control }}>Review body</Text>
              <PreviewMarkdown
                markdown={composed.post.body}
                color={t.text}
                fontSize={type.body}
                lineHeight={22}
                marginTop={space.xs}
                hideFinalReviewMarker
              />
            </Card>
            {composed.post.threads.map((thread, index) => (
              <Card
                // biome-ignore lint/suspicious/noArrayIndexKey: the frozen descriptor permits duplicate threads and never reorders.
                key={`${thread.path}:${thread.startLine ?? thread.line}:${thread.line}:${thread.side}:${index}`}
              >
                <Text style={{ color: t.faint, fontSize: type.control }}>
                  {thread.path}:{thread.startLine ?? thread.line}
                  {thread.startLine === undefined || thread.startLine === thread.line
                    ? ""
                    : `–${thread.line}`}{" "}
                  · {thread.side}
                </Text>
                <PreviewMarkdown
                  markdown={thread.body}
                  color={t.text}
                  fontSize={type.body}
                  lineHeight={22}
                  marginTop={space.xs}
                />
              </Card>
            ))}
            {composed.artifact.bodyNotes.length > 0 ? (
              <>
                <SectionLabel>Body note provenance</SectionLabel>
                {composed.artifact.bodyNotes.map((note, index) => (
                  <Card key={note.id ?? `${note.anchor ?? "note"}:${index}`}>
                    <Text style={{ color: t.faint, fontSize: type.control }}>
                      {note.type}
                      {note.anchor === undefined ? "" : ` · ${note.anchor}`}
                    </Text>
                    <PreviewMarkdown
                      markdown={note.body}
                      color={t.text}
                      fontSize={type.body}
                      lineHeight={22}
                      marginTop={space.xs}
                    />
                  </Card>
                ))}
              </>
            ) : null}
            {composed.ledger.length > 0 ? (
              <>
                <SectionLabel>Outbound accounting</SectionLabel>
                {composed.ledger.map((entry, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: duplicate accounting entries are valid and the frozen ledger never reorders.
                  <Card key={`${entry.kind}:${entry.path}:${index}`}>
                    <Text style={{ color: t.faint, fontSize: type.control }}>
                      {entry.kind} · {entry.path}
                    </Text>
                    <Text style={{ color: t.text, fontSize: type.control, marginTop: space.xs }}>
                      {entry.detail}
                    </Text>
                  </Card>
                ))}
              </>
            ) : null}
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
              {/* The full change request the phone opens: base ← head, draft flag, and the whole
                  drafted body — the preview is the request, nothing hidden (#382 M2 finding 1). */}
              <Text style={{ color: t.faint, fontSize: type.control, marginTop: space.xs }}>
                {composed.submission.base} ← {composed.submission.head}
                {composed.submission.draft ? " · draft" : ""}
              </Text>
              <PreviewMarkdown
                markdown={composed.submission.body}
                color={t.text}
                fontSize={type.body}
                lineHeight={22}
                marginTop={space.sm}
                empty="(no body)"
              />
            </Card>
            <PrimaryButton
              label={
                posting.phase === "posting"
                  ? changeRequestCopy(composed.target?.repo.forge).opening
                  : `↗ Open ${changeRequestCopy(composed.target?.repo.forge).noun}`
              }
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
