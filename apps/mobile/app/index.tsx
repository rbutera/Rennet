// Home (issue #383 M1). Two faces of one screen: the Welcome empty state (wireframe 19) when
// no daemon is paired yet, and the status-first review list (wireframe 20) once one is. The
// list aggregates across daemons, pins running + needs-you, groups the rest by recency, and
// shows freshness as a row fact — all from the pure `groupReviews` derivation.

import { Link, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  Card,
  Chip,
  type ChipTone,
  OutlineButton,
  PrimaryButton,
  Screen,
  SectionLabel,
  styles as ui,
} from "../src/components/ui";
import { groupReviews, type ReviewSummary } from "../src/lib/review-list";
import { useRuntime } from "../src/runtime/context";
import { useAggregatedReviews } from "../src/runtime/reviews";
import { space, type } from "../src/theme/tokens";
import { useTheme } from "../src/theme/use-theme";

export default function Home(): ReactNode {
  const runtime = useRuntime();
  const reviews = useAggregatedReviews(runtime);
  if (runtime.registry.list().length === 0) return <Welcome />;
  return <ReviewList reviews={reviews} />;
}

function Welcome(): ReactNode {
  const t = useTheme();
  const router = useRouter();
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", paddingBottom: space.xxl }}>
        <Text
          style={{ color: t.ink, fontSize: type.title, fontWeight: "600", textAlign: "center" }}
        >
          Connect to your Rennet
        </Text>
        <Text
          style={{ color: t.muted, fontSize: type.body, textAlign: "center", marginTop: space.sm }}
        >
          Your reviews run on your machine.{"\n"}Pair this phone with its daemon.
        </Text>
        <View style={{ marginTop: space.xl }}>
          <PrimaryButton label="Scan pairing QR" onPress={() => router.push("/pair")} />
          <OutlineButton label="Paste pairing link" onPress={() => router.push("/pair")} />
        </View>
        <View
          style={{
            marginTop: space.xl,
            borderWidth: 1,
            borderStyle: "dashed",
            borderColor: t.line2,
            borderRadius: 12,
            padding: space.lg,
          }}
        >
          <Text style={{ color: t.muted, fontSize: type.control, lineHeight: 20 }}>
            No Rennet backend. The phone talks to your daemon over your tailnet; the only egress is
            the harness/provider egress your desktop already discloses.
          </Text>
        </View>
      </View>
    </Screen>
  );
}

function ReviewList({ reviews }: { reviews: ReviewSummary[] }): ReactNode {
  const t = useTheme();
  const router = useRouter();
  const grouped = groupReviews(reviews, Date.now());
  return (
    <Screen>
      <ScrollView>
        <View
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
        >
          <Text style={{ color: t.ink, fontSize: type.title, fontWeight: "600" }}>Reviews</Text>
          <Link href="/connections" style={{ color: t.blueInk, fontSize: type.control }}>
            Connections
          </Link>
        </View>

        {grouped.pinned.map((r) => (
          <ReviewRow key={r.reviewId} review={r} backlit onPress={() => open(router, r)} />
        ))}
        {grouped.groups.map((group) => (
          <View key={group.label}>
            <SectionLabel>{group.label}</SectionLabel>
            {group.reviews.map((r) => (
              <ReviewRow key={r.reviewId} review={r} onPress={() => open(router, r)} />
            ))}
          </View>
        ))}

        {reviews.length === 0 && (
          <Text style={{ color: t.muted, marginTop: space.xl }}>
            No reviews yet — start one from your desktop, or pair another daemon.
          </Text>
        )}

        <View style={{ marginTop: space.md }}>
          <PrimaryButton label="+ New review" onPress={() => router.push("/kickoff")} />
          <OutlineButton label="Pair another daemon" onPress={() => router.push("/pair")} />
        </View>
      </ScrollView>
    </Screen>
  );
}

function open(router: ReturnType<typeof useRouter>, r: ReviewSummary): void {
  router.push(`/daemon/${r.daemonId}/review/${r.reviewId}/digest`);
}

function ReviewRow({
  review,
  backlit,
  onPress,
}: {
  review: ReviewSummary;
  backlit?: boolean;
  onPress: () => void;
}): ReactNode {
  const t = useTheme();
  const chips: { label: string; tone: ChipTone }[] = [];
  if (review.running) chips.push({ label: "running", tone: "blue" });
  if (review.needsYou) chips.push({ label: "needs you", tone: "amber" });
  if (review.stale) chips.push({ label: "stale", tone: "amber" });
  return (
    <Card backlit={backlit} onPress={onPress}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={[ui.rowTitle, { color: t.text }]}>{review.repoDisplayName}</Text>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {chips.map((c) => (
            <Chip key={c.label} label={c.label} tone={c.tone} />
          ))}
        </View>
      </View>
      <Text
        style={{
          color: review.reachable ? t.muted : t.faint,
          fontSize: type.control,
          marginTop: 4,
        }}
      >
        {review.reachable ? "on this daemon" : "offline · showing last replica"}
      </Text>
    </Card>
  );
}
