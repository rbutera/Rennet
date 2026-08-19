// Connections (issue #383 M1, wireframe 19). Every paired daemon with its live reachability
// (from the shared runtime's state machine), the harnesses it disclosed, and this phone's
// revocable device token. An unreachable daemon stays listed with its last replica readable —
// never blank — and a revoke removes the token everywhere.

import { useRouter } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Card, Chip, PrimaryButton, Screen, SectionLabel } from "../src/components/ui";
import { useRuntime } from "../src/runtime/context";
import type { DaemonConnection } from "../src/runtime/daemon-registry";
import { space, type } from "../src/theme/tokens";
import { useTheme } from "../src/theme/use-theme";

export default function Connections(): ReactNode {
  const router = useRouter();
  const runtime = useRuntime();
  const connections = runtime.registry.list();
  return (
    <Screen>
      <ScrollView>
        {connections.map((c) => (
          <ConnectionRow key={c.daemon.id} connection={c} />
        ))}

        <SectionLabel>This phone</SectionLabel>
        {connections.map((c) => (
          <DeviceTokenRow
            key={c.daemon.id}
            connection={c}
            onRevoke={() => {
              // Revoke on the daemon (severs the token + its live sockets), then forget locally —
              // erasing the keychain entry and the registry row (#383 batch, finding 1). Best-effort
              // on the wire: an offline daemon is still forgotten locally.
              void c.supervisor
                .invoke("pairing.revokeDevice", { deviceId: c.daemon.deviceId })
                .catch(() => undefined)
                .finally(() => void runtime.forgetDaemon(c.daemon.id));
            }}
          />
        ))}

        <View style={{ marginTop: space.md }}>
          <PrimaryButton label="+ Pair another daemon" onPress={() => router.push("/pair")} />
        </View>
      </ScrollView>
    </Screen>
  );
}

function ConnectionRow({ connection }: { connection: DaemonConnection }): ReactNode {
  const t = useTheme();
  const state = connection.status.state;
  const online = state === "online";
  const harnesses = useHarnesses(connection);
  return (
    <Card backlit={online}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text style={{ color: t.text, fontSize: type.body, fontWeight: "600" }}>
          {connection.daemon.name}
        </Text>
        <Chip
          label={online ? "online" : state === "error" ? "auth error" : "offline"}
          tone={online ? "green" : "accent"}
        />
      </View>
      <Text style={{ color: t.muted, fontSize: type.control, marginTop: 4 }}>
        {online
          ? connection.daemon.url
          : state === "error"
            ? "token rejected — re-pair from your desktop"
            : "showing last replica"}
      </Text>
      {harnesses && (
        <Text style={{ color: t.faint, fontSize: type.control, marginTop: 2 }}>
          {harnesses.length > 0 ? `${harnesses.join(" · ")} detected` : "no harness detected"}
        </Text>
      )}
    </Card>
  );
}

function DeviceTokenRow({
  connection,
  onRevoke,
}: {
  connection: DaemonConnection;
  onRevoke: () => void;
}): ReactNode {
  const t = useTheme();
  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontSize: type.body, fontWeight: "600" }}>
            Device token · {connection.daemon.name}
          </Text>
          <Text style={{ color: t.muted, fontSize: type.control, marginTop: 2 }}>
            revocable from any client
          </Text>
        </View>
        <Text
          onPress={onRevoke}
          style={{ color: t.danger, fontSize: type.control, fontWeight: "600" }}
        >
          revoke
        </Text>
      </View>
    </Card>
  );
}

/** Fetch the daemon's disclosed harnesses once online (read-mostly disclosure line). */
function useHarnesses(connection: DaemonConnection): string[] | null {
  const [harnesses, setHarnesses] = useState<string[] | null>(null);
  const online = connection.status.state === "online";
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    connection.supervisor
      .invoke("harness.detect", {})
      .then((result) => {
        if (!cancelled) setHarnesses(result.detected.map((h) => h.id));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connection, online]);
  return harnesses;
}
