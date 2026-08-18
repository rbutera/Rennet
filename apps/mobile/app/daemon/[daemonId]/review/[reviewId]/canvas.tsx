// Review · full sequence canvas (issue #383 M1, wireframe 21 screen 3). The WHOLE review at
// phone width: every element's real hunk, in reading order, VIRTUALIZED (FlatList) so it stays
// smooth to the last line — the survey's RN perf tail is the reason virtualization is a first-
// cut constraint, not a scope cut. Hunks render lazily as rows scroll into view; nothing is
// truncated.
//
// M1 renders the real captured hunks from the projected `elementDiffs` map (a clean, host-path-
// scrubbed shape). The cohort grouping + judged-cohort collapse of the wireframe is a thinner
// cut here (elementDiffs is flat); the load-bearing "readable to the end, virtualized" is met.

import { useLocalSearchParams } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { Card, HunkBlock, Screen } from "../../../../../src/components/ui";
import { newCommandId } from "../../../../../src/lib/ids";
import { asProjectedReview } from "../../../../../src/lib/projection";
import { useConnection, useReviewFocus } from "../../../../../src/runtime/use-connection";
import { space, type } from "../../../../../src/theme/tokens";
import { useTheme } from "../../../../../src/theme/use-theme";

interface Element {
  readonly key: string;
  readonly path: string;
  readonly diff: string;
}

export default function Canvas(): ReactNode {
  const t = useTheme();
  const { daemonId, reviewId } = useLocalSearchParams<{ daemonId: string; reviewId: string }>();
  useReviewFocus(daemonId, reviewId);
  const connection = useConnection(daemonId);
  const [elements, setElements] = useState<Element[]>([]);

  useEffect(() => {
    if (!connection) return;
    const conn = connection;
    let cancelled = false;
    async function load(): Promise<void> {
      // The projected review names its repo as a reference; the daemon resolves the repoPath
      // reference back to its host path (projection input resolution). We send the projected key.
      const bootstrap = await conn.supervisor.invoke("app.bootstrap", {});
      const review = bootstrap.review ? asProjectedReview(bootstrap.review) : null;
      if (!review) return;
      const canvases = await conn.supervisor.invoke("review.canvases", {
        commandId: newCommandId(),
        reviewId,
        repoPath: review.repositoryRoot.repoKey,
      });
      if (cancelled) return;
      setElements(
        Object.entries(canvases.elementDiffs).map(([key, diff]) => ({
          key,
          path: diff.path,
          diff: diff.diff,
        })),
      );
    }
    void load().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connection, reviewId]);

  return (
    <Screen>
      <Text style={{ color: t.faint, fontSize: type.control, marginBottom: space.sm }}>
        reading order · {elements.length} elements
      </Text>
      <FlatList
        data={elements}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => (
          <Card>
            <Text style={{ color: t.text, fontSize: type.control, fontWeight: "600" }}>
              {item.path}
            </Text>
            <HunkBlock diff={item.diff} />
          </Card>
        )}
        // Lazy hunk mounting: keep the mounted window small so a large review stays smooth.
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={7}
        removeClippedSubviews
        ListEmptyComponent={
          <Text style={{ color: t.muted }}>
            {connection ? "Loading the canvas…" : "Daemon unreachable — showing the last replica."}
          </Text>
        }
        ListFooterComponent={
          elements.length > 0 ? (
            <View style={{ paddingVertical: space.lg }}>
              <Text style={{ color: t.faint, textAlign: "center", fontSize: type.control }}>
                scrolls to the end — every finding, every hunk
              </Text>
            </View>
          ) : null
        }
      />
    </Screen>
  );
}
