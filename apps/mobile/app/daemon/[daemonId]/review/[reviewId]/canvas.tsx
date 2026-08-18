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
import { type CanvasRow, flattenCanvasRows } from "../../../../../src/lib/canvas-rows";
import { newCommandId } from "../../../../../src/lib/ids";
import {
  useConnection,
  useReviewFocus,
  useReviewLoad,
} from "../../../../../src/runtime/use-connection";
import { space, type } from "../../../../../src/theme/tokens";
import { useTheme } from "../../../../../src/theme/use-theme";

export default function Canvas(): ReactNode {
  const t = useTheme();
  const { daemonId, reviewId } = useLocalSearchParams<{ daemonId: string; reviewId: string }>();
  useReviewFocus(daemonId, reviewId);
  const connection = useConnection(daemonId);
  // Load THIS review's own metadata (#383 batch): its repo key comes from review.load(reviewId),
  // never the daemon's current bootstrap review — a deep-linked review may be a different one.
  const loaded = useReviewLoad(daemonId, reviewId);
  const repoKey = loaded.review?.repositoryRoot.repoKey;
  // Flattened rows: a file header + one row per hunk, so a large file diff is virtualized hunk
  // by hunk rather than mounted as one giant row (#383 batch, finding 16).
  const [rows, setRows] = useState<CanvasRow[]>([]);

  useEffect(() => {
    if (!connection || !repoKey) return;
    const conn = connection;
    let cancelled = false;
    async function load(): Promise<void> {
      const canvases = await conn.supervisor.invoke("review.canvases", {
        commandId: newCommandId(),
        reviewId,
        repoPath: repoKey as string,
      });
      if (cancelled) return;
      setRows(
        flattenCanvasRows(
          Object.entries(canvases.elementDiffs).map(([key, diff]) => ({
            key,
            path: diff.path,
            diff: diff.diff,
          })),
        ),
      );
    }
    void load().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connection, reviewId, repoKey]);

  return (
    <Screen>
      <Text style={{ color: t.faint, fontSize: type.control, marginBottom: space.sm }}>
        reading order · {rows.filter((r) => r.type === "file").length} files
      </Text>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) =>
          item.type === "file" ? (
            <Text
              style={{
                color: t.text,
                fontSize: type.control,
                fontWeight: "600",
                marginTop: space.md,
                marginBottom: space.xs,
              }}
            >
              {item.path}
            </Text>
          ) : (
            <Card>
              <HunkBlock diff={item.diff} />
            </Card>
          )
        }
        // Lazy hunk mounting: keep the mounted window small so a large review stays smooth.
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={7}
        removeClippedSubviews
        ListEmptyComponent={
          <Text style={{ color: loaded.status === "error" ? t.amber : t.muted }}>
            {loaded.status === "unreachable"
              ? "Daemon unreachable — showing the last replica."
              : loaded.status === "error"
                ? `This review could not be loaded. ${loaded.error ?? ""}`.trim()
                : "Loading the canvas…"}
          </Text>
        }
        ListFooterComponent={
          rows.length > 0 ? (
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
