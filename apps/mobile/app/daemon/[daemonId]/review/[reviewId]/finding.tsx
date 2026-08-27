// Review · finding detail — placeholder pending the Board rebuild (B2, #489, Q10).
// Mobile-on-boards is a separate future effort. This screen was built entirely on the
// deleted canvas projection (`review.canvases`, `canvas.adjudicateProposal`,
// `canvas.disposition`, the five-angle canvas set + elementDiffs); those are gone in
// this change, so the route renders a placeholder. Track C reinstates finding review
// on the Board surface.
import type { ReactNode } from "react";
import { Text } from "react-native";
import { Screen } from "../../../../../src/components/ui";
import { space, type } from "../../../../../src/theme/tokens";
import { useTheme } from "../../../../../src/theme/use-theme";

export default function FindingDetail(): ReactNode {
  const t = useTheme();
  return (
    <Screen>
      <Text style={{ color: t.muted, fontSize: type.body, marginTop: space.lg }}>
        The board is being rebuilt — finding review is temporarily unavailable on mobile.
      </Text>
    </Screen>
  );
}
