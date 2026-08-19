// Review · delta digest (issue #383 M1, wireframe 21 screen 1). The entry point to a review:
// the delta digest leads, and the canvas entries take the user one tap deeper — never a
// desktop referral. Landing here reports focus and clears the review's attention (clear-on-
// view). The full-count breakdown is a thinner cut in M1 than the wireframe illustration (the
// counts come from several projected shapes); the digest prose + canvas entries are wired.

import { useLocalSearchParams, useRouter } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Card, Screen, SectionLabel, StatTile } from "../../../../../src/components/ui";
import { type DeltaAccountLike, deltaCounts } from "../../../../../src/lib/delta-counts";
import { newCommandId } from "../../../../../src/lib/ids";
import {
  useConnection,
  useReviewFocus,
  useReviewLoad,
} from "../../../../../src/runtime/use-connection";
import { space, type } from "../../../../../src/theme/tokens";
import { useTheme } from "../../../../../src/theme/use-theme";

export default function Digest(): ReactNode {
  const t = useTheme();
  const router = useRouter();
  const { daemonId, reviewId } = useLocalSearchParams<{ daemonId: string; reviewId: string }>();
  // The digest is the review-finished landing (#382 M2 finding 10): clear exactly that.
  useReviewFocus(daemonId, reviewId, "review-finished");
  const connection = useConnection(daemonId);
  const loaded = useReviewLoad(daemonId, reviewId);
  // The count tiles derive CLIENT-SIDE from the review's own delta account (#382 M2, task 6.3) —
  // an absent account (a first capture) reads an honest zero, never a fabricated number.
  const counts = deltaCounts(
    (loaded.review as { deltaAccount?: DeltaAccountLike } | undefined)?.deltaAccount,
  );
  const [digest, setDigest] = useState<string | null>(null);

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    connection.supervisor
      .invoke("review.deltaDigest", { commandId: newCommandId(), reviewId })
      .then((result) => {
        if (cancelled) return;
        setDigest(result.status === "drafted" ? result.text : null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connection, reviewId]);

  const base = `/daemon/${daemonId}/review/${reviewId}`;
  return (
    <Screen>
      <ScrollView>
        <SectionLabel>Delta digest</SectionLabel>
        <View style={{ flexDirection: "row", marginHorizontal: -3, marginBottom: space.sm }}>
          <StatTile value={counts.addressed} label="addressed" tone="green" />
          <StatTile value={counts.partially} label="partial" tone="accent" />
          <StatTile value={counts.untouched} label="untouched" tone="accent" />
          <StatTile value={counts.beyond} label="beyond" tone="accent" />
        </View>
        <Card>
          <Text style={{ color: t.text, fontSize: type.body, lineHeight: 22 }}>
            {digest ??
              (connection
                ? "Reading the delta since the last patchset…"
                : "Daemon unreachable — showing the last replica.")}
          </Text>
        </Card>

        <SectionLabel>Read the review</SectionLabel>
        <Card onPress={() => router.push(`${base}/canvas`)}>
          <Text style={{ color: t.text, fontSize: type.body, fontWeight: "600" }}>
            Full sequence canvas
          </Text>
          <Text style={{ color: t.muted, fontSize: type.control, marginTop: 2 }}>
            every cohort, finding, and hunk in reading order
          </Text>
        </Card>
        <Card onPress={() => router.push(`${base}/finding`)}>
          <Text style={{ color: t.text, fontSize: type.body, fontWeight: "600" }}>Findings</Text>
          <Text style={{ color: t.muted, fontSize: type.control, marginTop: 2 }}>
            open one at a time — agree, disagree, discuss
          </Text>
        </Card>

        <SectionLabel>Act</SectionLabel>
        <Card onPress={() => router.push(`${base}/turn`)}>
          <Text style={{ color: t.text, fontSize: type.body, fontWeight: "600" }}>
            Live turn & ask
          </Text>
          <Text style={{ color: t.muted, fontSize: type.control, marginTop: 2 }}>
            watch the stream, answer the ask, stop the turn
          </Text>
        </Card>
        <Card onPress={() => router.push(`${base}/publish`)}>
          <Text style={{ color: t.text, fontSize: type.body, fontWeight: "600" }}>Publish</Text>
          <Text style={{ color: t.muted, fontSize: type.control, marginTop: 2 }}>
            preview the outbound review, then post
          </Text>
        </Card>

        <View style={{ height: space.xxl }} />
      </ScrollView>
    </Screen>
  );
}
