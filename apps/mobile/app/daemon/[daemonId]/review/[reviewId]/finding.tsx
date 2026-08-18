// Review · finding detail (issue #383 M1, wireframe 21 screen 2). One finding: claim, hunk,
// one-tap disposition (agree / disagree / discuss), and proposal adjudication. The disposition
// round-trips to the daemon and is visible from any other client (the tested scenario). The
// finding here is the first canvas element (M1 opens the reading-order head); richer per-
// finding navigation and live proposal adjudication are a thinner cut this cut — the
// disposition write-back is the load-bearing act and is fully wired.

import { useLocalSearchParams } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Card, HunkBlock, OutlineButton, Screen } from "../../../../../src/components/ui";
import { newCommandId } from "../../../../../src/lib/ids";
import { asProjectedReview } from "../../../../../src/lib/projection";
import { useConnection, useReviewFocus } from "../../../../../src/runtime/use-connection";
import { space, type } from "../../../../../src/theme/tokens";
import { useTheme } from "../../../../../src/theme/use-theme";

type Disposition = "approve" | "request-change" | "comment";

interface Finding {
  readonly path: string;
  readonly diff: string;
  readonly patchsetId: string;
}

export default function FindingDetail(): ReactNode {
  const t = useTheme();
  const { daemonId, reviewId } = useLocalSearchParams<{ daemonId: string; reviewId: string }>();
  useReviewFocus(daemonId, reviewId);
  const connection = useConnection(daemonId);
  const [finding, setFinding] = useState<Finding | null>(null);
  const [saved, setSaved] = useState<Disposition | null>(null);

  useEffect(() => {
    if (!connection) return;
    const conn = connection;
    let cancelled = false;
    async function load(): Promise<void> {
      const bootstrap = await conn.supervisor.invoke("app.bootstrap", {});
      const review = bootstrap.review ? asProjectedReview(bootstrap.review) : null;
      if (!review) return;
      const canvases = await conn.supervisor.invoke("review.canvases", {
        commandId: newCommandId(),
        reviewId,
        repoPath: review.repositoryRoot.repoKey,
      });
      const first = Object.values(canvases.elementDiffs)[0];
      if (!cancelled && first) {
        setFinding({ path: first.path, diff: first.diff, patchsetId: review.activePatchsetId });
      }
    }
    void load().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connection, reviewId]);

  async function dispose(disposition: Disposition): Promise<void> {
    if (!connection || !finding) return;
    setSaved(disposition);
    await connection.supervisor
      .invoke("canvas.disposition", {
        commandId: newCommandId(),
        reviewId,
        patchsetId: finding.patchsetId,
        path: finding.path,
        disposition,
        body: "",
      })
      .catch(() => setSaved(null));
  }

  if (!finding) {
    return (
      <Screen>
        <Text style={{ color: t.muted }}>
          {connection ? "Loading the finding…" : "Daemon unreachable — showing the last replica."}
        </Text>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView>
        <Text style={{ color: t.muted, fontSize: type.control }}>{finding.path}</Text>
        <HunkBlock diff={finding.diff} />

        <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.md }}>
          <View style={{ flex: 1 }}>
            <OutlineButton
              label={saved === "approve" ? "Agreed" : "Agree"}
              onPress={() => void dispose("approve")}
            />
          </View>
          <View style={{ flex: 1 }}>
            <OutlineButton
              label={saved === "request-change" ? "Disagreed" : "Disagree"}
              onPress={() => void dispose("request-change")}
            />
          </View>
          <View style={{ flex: 1 }}>
            <OutlineButton label="Discuss" onPress={() => void dispose("comment")} />
          </View>
        </View>

        <Card>
          <Text style={{ color: t.amber, fontSize: type.pill, letterSpacing: 1, marginBottom: 4 }}>
            PROPOSAL
          </Text>
          <Text style={{ color: t.text, fontSize: type.body }}>
            Proposal adjudication opens on the desktop this cut; the reading + disposition act is
            complete on the phone.
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}
