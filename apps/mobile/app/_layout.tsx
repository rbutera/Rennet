// Root layout (issue #383 M1). expo-router mounts this once; it wraps the whole route tree in
// the app runtime (the daemon registry + presence + attention) and a native stack. Navigation
// is a stack scoped by daemon id (the survey's shape: many daemons in one nav tree), with no
// persistent tab bar — overlay/stack navigation, per the mobile plan.

import { Stack } from "expo-router";
import type { ReactNode } from "react";
import { RuntimeProvider } from "../src/runtime/context";

export default function RootLayout(): ReactNode {
  return (
    <RuntimeProvider>
      <Stack screenOptions={{ headerShown: true, headerBackTitle: "Back" }}>
        <Stack.Screen name="index" options={{ title: "Rennet" }} />
        <Stack.Screen name="pair" options={{ title: "Pair a daemon" }} />
        <Stack.Screen name="connections" options={{ title: "Connections" }} />
        <Stack.Screen name="settings/notifications" options={{ title: "Notifications" }} />
      </Stack>
    </RuntimeProvider>
  );
}
