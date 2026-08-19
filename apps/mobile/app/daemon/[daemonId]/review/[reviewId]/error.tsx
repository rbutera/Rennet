// Review · error state (issue #383 M1). The deep-link surface a "turn failed or interrupted"
// push lands on — the review in its error state, truthful about what stopped and why, never a
// hung spinner. Landing here still reports focus and clears the attention (clear-on-view).

import { useLocalSearchParams, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Text } from "react-native";
import { Card, OutlineButton, Screen } from "../../../../../src/components/ui";
import { useReviewFocus } from "../../../../../src/runtime/use-connection";
import { space, type } from "../../../../../src/theme/tokens";
import { useTheme } from "../../../../../src/theme/use-theme";

export default function ReviewError(): ReactNode {
  const t = useTheme();
  const router = useRouter();
  const { daemonId, reviewId } = useLocalSearchParams<{ daemonId: string; reviewId: string }>();
  // The error screen is the turn-failed landing (#382 M2 finding 10): clear exactly that.
  useReviewFocus(daemonId, reviewId, "turn-failed");

  return (
    <Screen>
      <Card>
        <Text style={{ color: t.danger, fontSize: type.body, fontWeight: "600" }}>
          A turn failed or was interrupted
        </Text>
        <Text
          style={{ color: t.muted, fontSize: type.control, marginTop: space.sm, lineHeight: 20 }}
        >
          The last turn on this review did not finish. Its interrupted state is preserved on the
          daemon — nothing was lost. Re-run it from your desktop, or open the review to read what
          landed before it stopped.
        </Text>
      </Card>
      <OutlineButton
        label="Open the review"
        onPress={() => router.replace(`/daemon/${daemonId}/review/${reviewId}/digest`)}
      />
    </Screen>
  );
}
