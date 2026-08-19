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
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { Card, HunkBlock, Screen } from "../../../../../src/components/ui";
import {
  type CanvasCohort,
  type CanvasElement,
  type CanvasRow,
  flattenCanvasByCohort,
} from "../../../../../src/lib/canvas-rows";
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
  // The projected canvas: elements keyed by elementKey + the sequence canvas's cohorts, so the
  // rows fold under cohort headers with judged-cohort collapse (#382 M2, task 6.3). Virtualization
  // is kept — a collapsed cohort mounts no hunks, and each file is windowed hunk by hunk.
  const [elementsByKey, setElements] = useState<Map<string, CanvasElement>>(new Map());
  const [cohorts, setCohorts] = useState<CanvasCohort[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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
      const map = new Map<string, CanvasElement>();
      for (const [key, diff] of Object.entries(canvases.elementDiffs)) {
        map.set(key, { key, path: diff.path, diff: diff.diff });
      }
      setElements(map);
      // Cohorts come from the sequence canvas (reading order); absent ⇒ one flat group.
      const sequenceCohorts = canvases.canvases.sequence.layers.analysis.cohorts;
      setCohorts(
        sequenceCohorts.map((c) => ({
          cohortKey: c.cohortKey,
          title: c.title,
          elementKeys: c.elementKeys,
        })),
      );
    }
    void load().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connection, reviewId, repoKey]);

  const toggleCohort = useCallback((cohortKey: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cohortKey)) next.delete(cohortKey);
      else next.add(cohortKey);
      return next;
    });
  }, []);

  const rows: CanvasRow[] = flattenCanvasByCohort(cohorts, elementsByKey, collapsed);

  return (
    <Screen>
      <Text style={{ color: t.faint, fontSize: type.control, marginBottom: space.sm }}>
        reading order · {rows.filter((r) => r.type === "file").length} files
      </Text>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) =>
          item.type === "cohort" ? (
            <Pressable
              onPress={() => toggleCohort(item.cohortKey)}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                marginTop: space.md,
                marginBottom: space.xs,
              }}
            >
              <Text style={{ color: t.ink, fontSize: type.body, fontWeight: "600" }}>
                {item.collapsed ? "▸" : "▾"} {item.title}
              </Text>
              <Text style={{ color: t.faint, fontSize: type.control }}>{item.count}</Text>
            </Pressable>
          ) : item.type === "file" ? (
            <Text
              style={{
                color: t.text,
                fontSize: type.control,
                fontWeight: "600",
                marginTop: space.sm,
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
          <Text style={{ color: loaded.status === "error" ? t.danger : t.muted }}>
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
