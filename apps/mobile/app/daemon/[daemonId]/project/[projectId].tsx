// Project detail (issue #383 batch, finding 11). The landing surface for a project-scoped deep
// link (processing finished). Processing-finished is a SILENT family — it never pushes — so this
// screen is reached only by an in-app tap, and M1 keeps it deliberately thin: it confirms the
// project the link named and routes back to the review list (per-project review filtering is a
// later cut). It exists so the routing table `routeHref` returns is never a dead link.

import { useLocalSearchParams, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Text } from "react-native";
import { Card, OutlineButton, Screen } from "../../../../src/components/ui";
import { space, type } from "../../../../src/theme/tokens";
import { useTheme } from "../../../../src/theme/use-theme";

export default function ProjectDetail(): ReactNode {
  const t = useTheme();
  const router = useRouter();
  const { projectId } = useLocalSearchParams<{ daemonId: string; projectId: string }>();

  return (
    <Screen>
      <Card>
        <Text style={{ color: t.text, fontSize: type.body, fontWeight: "600" }}>
          Project processing finished
        </Text>
        <Text
          style={{ color: t.muted, fontSize: type.control, marginTop: space.sm, lineHeight: 20 }}
        >
          The snapshot build for this project ({projectId}) completed on the daemon. Its reviews are
          on your list; a fuller project view is a later cut.
        </Text>
      </Card>
      <OutlineButton label="Back to reviews" onPress={() => router.replace("/")} />
    </Screen>
  );
}
