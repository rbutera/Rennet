// Notification settings (issue #383 M1, wireframe 24). The closed six-event taxonomy as
// per-event switches, grouped Needs-you / Progress, plus the push-permission prompt at the
// right moment (here, not on cold launch). "Project processed" is silent by taxonomy — shown
// off and non-interactive. Registering the token happens when the user turns push on.

import { type ReactNode, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { OutlineButton, Screen, SectionLabel, SwitchRow } from "../../src/components/ui";
import { useRuntime } from "../../src/runtime/context";
import {
  ensurePushPermission,
  getPushToken,
  registerPushWithAllDaemons,
} from "../../src/runtime/push";
import { space, type } from "../../src/theme/tokens";
import { useTheme } from "../../src/theme/use-theme";

/** The six families as user-facing switches (attention-notifications taxonomy). */
type Family =
  | "ask-pending"
  | "review-finished"
  | "turn-failed"
  | "handoff-completed"
  | "publish-ready"
  | "processing-finished";

const COPY: Record<Family, { title: string; subtitle: string }> = {
  "ask-pending": { title: "A turn needs you", subtitle: "the question, answerable right here" },
  "review-finished": { title: "Review finished", subtitle: "what was found, at a glance" },
  "turn-failed": { title: "Something went wrong", subtitle: "a turn failed or was interrupted" },
  "handoff-completed": {
    title: "Agent finished your asks",
    subtitle: "the follow-up work is ready to re-read",
  },
  "publish-ready": { title: "Ready to post", subtitle: "a drafted review is waiting for you" },
  "processing-finished": { title: "Project processed", subtitle: "quiet — shows in the app only" },
};

export default function Notifications(): ReactNode {
  const t = useTheme();
  const runtime = useRuntime();
  const [enabled, setEnabled] = useState<Record<Family, boolean>>({
    "ask-pending": true,
    "review-finished": true,
    "turn-failed": true,
    "handoff-completed": true,
    "publish-ready": true,
    "processing-finished": false,
  });
  const [pushOn, setPushOn] = useState(false);

  async function enablePush(): Promise<void> {
    const granted = await ensurePushPermission();
    if (!granted) return;
    const token = await getPushToken();
    if (token) {
      await registerPushWithAllDaemons(runtime.registry, token);
      setPushOn(true);
    }
  }

  const toggle = (family: Family) => (value: boolean) =>
    setEnabled((prev) => ({ ...prev, [family]: value }));

  const rowFor = (family: Family): ReactNode => (
    <SwitchRow
      key={family}
      title={COPY[family].title}
      subtitle={COPY[family].subtitle}
      value={enabled[family]}
      onValueChange={family === "processing-finished" ? undefined : toggle(family)}
      disabled={family === "processing-finished"}
    />
  );

  return (
    <Screen>
      <ScrollView>
        {!pushOn && (
          <View style={{ marginBottom: space.sm }}>
            <OutlineButton label="Enable push notifications" onPress={() => void enablePush()} />
          </View>
        )}

        <SectionLabel>Needs you</SectionLabel>
        {(["ask-pending", "review-finished", "turn-failed"] as Family[]).map(rowFor)}

        <SectionLabel>Progress</SectionLabel>
        {(["handoff-completed", "publish-ready", "processing-finished"] as Family[]).map(rowFor)}

        <Text
          style={{
            color: t.muted,
            fontSize: type.control,
            marginTop: space.lg,
            fontStyle: "italic",
          }}
        >
          You only hear about a review you aren't already looking at.
        </Text>
      </ScrollView>
    </Screen>
  );
}
