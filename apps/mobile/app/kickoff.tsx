// New review · kickoff (issue #382 M2, wireframe 20). Two loops on one screen: paste (or share) a
// PR link → `review.openPr`, and an own-branch project → `review.capture`. Progress streams over
// `onProgress`; the new review lands in the home list on completion (the aggregation re-reads
// app.bootstrap). The share-sheet entry pre-fills the PR field via the `url` route param.
//
// The phone holds no host path: a project's projected `openPath` carries a `repoKey`, and the
// daemon resolves it inbound (the M1 projection pattern) — so capture/openPr address a repo by key.

import { useLocalSearchParams, useRouter } from "expo-router";
import { type ReactNode, useEffect, useMemo, useReducer, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { Card, OutlineButton, Screen, SectionLabel } from "../src/components/ui";
import { newCommandId } from "../src/lib/ids";
import {
  initialKickoff,
  type KickoffProject,
  kickoffReducer,
  matchProjectRepoKey,
  type ProjectedRepoRef,
  parsePrRef,
} from "../src/lib/kickoff";
import { useRuntime } from "../src/runtime/context";
import type { DaemonConnection } from "../src/runtime/daemon-registry";
import { space, type } from "../src/theme/tokens";
import { useTheme } from "../src/theme/use-theme";

/** Read a projected project's repo reference (the scrubbed `openPath`, else `path`). */
function repoRefOf(project: Record<string, unknown>): ProjectedRepoRef | null {
  const ref = (project.openPath ?? project.path) as ProjectedRepoRef | string | undefined;
  if (ref && typeof ref === "object" && typeof ref.repoKey === "string") return ref;
  return null;
}

export default function Kickoff(): ReactNode {
  const t = useTheme();
  const router = useRouter();
  const runtime = useRuntime();
  const { url } = useLocalSearchParams<{ url?: string }>();
  // Kickoff operates on the first reachable daemon (the common single-daemon case); a shared PR
  // URL lands here and matches a repo across it. Multi-daemon disambiguation is a later refinement.
  const connection =
    runtime.registry.list().find((c) => c.status.state === "online") ?? runtime.registry.list()[0];

  const [projects, setProjects] = useState<KickoffProject[]>([]);
  const [prLink, setPrLink] = useState(url ?? "");
  const [state, dispatch] = useReducer(kickoffReducer, initialKickoff);

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    connection.supervisor
      .invoke("projects.list", {})
      .then((result) => {
        if (cancelled) return;
        const rows: KickoffProject[] = [];
        for (const project of result.projects as unknown as Record<string, unknown>[]) {
          const repo = repoRefOf(project);
          if (repo)
            rows.push({
              id: String(project.id),
              name: String(project.name),
              repo,
              primaryBranch: String(project.primaryBranch ?? "main"),
            });
        }
        setProjects(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const parsed = useMemo(() => parsePrRef(prLink), [prLink]);

  async function openPr(): Promise<void> {
    if (!connection || !parsed) return;
    const repoKey = matchProjectRepoKey(projects, parsed);
    if (!repoKey) {
      dispatch({
        type: "failed",
        reason: `No paired project owns ${parsed.owner}/${parsed.repo}. Add it on your desktop first.`,
      });
      return;
    }
    dispatch({ type: "start", kind: "pr" });
    const commandId = newCommandId();
    const unsub = connection.supervisor.onProgress(commandId, (event) => {
      const note =
        (event as { message?: string; kind?: string }).message ?? (event as { kind?: string }).kind;
      if (note) dispatch({ type: "progress", note: String(note) });
    });
    try {
      const result = await connection.supervisor.invoke("review.openPr", {
        commandId,
        ref: parsed.ref,
        repoPath: repoKey,
      });
      finishInto(router, connection, result.review, dispatch);
    } catch (error) {
      dispatch({
        type: "failed",
        reason: error instanceof Error ? error.message : "The PR could not be opened.",
      });
    } finally {
      unsub();
    }
  }

  async function capture(project: KickoffProject): Promise<void> {
    if (!connection) return;
    dispatch({ type: "start", kind: "capture" });
    const commandId = newCommandId();
    const unsub = connection.supervisor.onProgress(commandId, (event) => {
      const note =
        (event as { message?: string; kind?: string }).message ?? (event as { kind?: string }).kind;
      if (note) dispatch({ type: "progress", note: String(note) });
    });
    try {
      const result = await connection.supervisor.invoke("review.capture", {
        commandId,
        repoPath: project.repo.repoKey,
      });
      finishInto(router, connection, result.review, dispatch);
    } catch (error) {
      dispatch({
        type: "failed",
        reason: error instanceof Error ? error.message : "The review could not start.",
      });
    } finally {
      unsub();
    }
  }

  if (!connection) {
    return (
      <Screen>
        <Text style={{ color: t.muted, marginTop: space.xl }}>
          Pair a daemon first — a new review runs on your machine.
        </Text>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView keyboardShouldPersistTaps="handled">
        <SectionLabel>From a pull request</SectionLabel>
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
          <TextInput
            value={prLink}
            onChangeText={setPrLink}
            placeholder="Paste a PR link…"
            placeholderTextColor={t.faint}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              flex: 1,
              color: t.text,
              fontSize: type.body,
              borderWidth: 1,
              borderColor: t.line2,
              borderRadius: 10,
              paddingHorizontal: 14,
              paddingVertical: 12,
              backgroundColor: t.card,
            }}
          />
          <View style={{ width: 96 }}>
            <OutlineButton
              label={state.status === "starting" && state.kind === "pr" ? "Opening…" : "Open"}
              onPress={() => void openPr()}
            />
          </View>
        </View>
        <Text style={{ color: t.faint, fontSize: type.control, marginTop: 6 }}>
          or share a PR to Rennet from any app (share sheet)
        </Text>

        <SectionLabel>Your branches on {connection.daemon.name}</SectionLabel>
        {projects.length === 0 ? (
          <Text style={{ color: t.muted, fontSize: type.control }}>
            No projects yet — add one on your desktop.
          </Text>
        ) : (
          projects.map((project) => (
            <Card key={project.id} onPress={() => void capture(project)}>
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text, fontSize: type.body, fontWeight: "600" }}>
                    {project.repo.displayName}
                  </Text>
                  <Text style={{ color: t.muted, fontSize: type.control, marginTop: 2 }}>
                    {project.primaryBranch}
                  </Text>
                </View>
                <Text style={{ color: t.accent, fontSize: type.control }}>review ›</Text>
              </View>
            </Card>
          ))
        )}

        {state.status === "starting" && state.note ? (
          <Text style={{ color: t.muted, fontSize: type.control, marginTop: space.md }}>
            {state.note}
          </Text>
        ) : null}
        {state.status === "failed" ? (
          <Text style={{ color: t.danger, fontSize: type.control, marginTop: space.md }}>
            {state.reason}
          </Text>
        ) : null}

        <View style={{ height: space.xxl }} />
      </ScrollView>
    </Screen>
  );
}

/** On a started review, save the replica and land on its digest — the new review is now in the list. */
function finishInto(
  router: ReturnType<typeof useRouter>,
  connection: DaemonConnection,
  review: { id: string },
  dispatch: (a: { type: "started"; reviewId: string }) => void,
): void {
  dispatch({ type: "started", reviewId: review.id });
  router.replace(`/daemon/${connection.daemon.id}/review/${review.id}/digest`);
}
