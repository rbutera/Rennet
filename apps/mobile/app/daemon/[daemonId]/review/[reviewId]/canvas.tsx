// Review · canvas route — placeholder pending the Board rebuild (B2, #489, Q10).
// Mobile-on-boards is a separate future effort. The canvas surface and its
// `review.canvases` command are deleted in this change, so this route renders a
// placeholder rather than the old flattened-hunk canvas; Track C reinstates the
// real screen on the Board.
import type { ReactNode } from "react";
import { Text } from "react-native";
import { Screen } from "../../../../../src/components/ui";
import { space, type } from "../../../../../src/theme/tokens";
import { useTheme } from "../../../../../src/theme/use-theme";

export default function Canvas(): ReactNode {
  const t = useTheme();
  return (
    <Screen>
      <Text style={{ color: t.muted, fontSize: type.body, marginTop: space.lg }}>
        The board is being rebuilt — this review's canvas is temporarily unavailable on mobile.
      </Text>
    </Screen>
  );
}
