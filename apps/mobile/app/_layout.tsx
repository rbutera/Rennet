// Root layout (issue #383 M1). expo-router mounts this once; it wraps the whole route tree in
// the app runtime (the daemon registry + presence + attention) and a native stack. Navigation
// is a stack scoped by daemon id (the survey's shape: many daemons in one nav tree), with no
// persistent tab bar — overlay/stack navigation, per the mobile plan.

import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  useFonts,
} from "@expo-google-fonts/dm-sans";
import { Fraunces_600SemiBold } from "@expo-google-fonts/fraunces";
import { Stack } from "expo-router";
import type { ReactNode } from "react";
import { RuntimeProvider } from "../src/runtime/context";
import { useNotificationRouting } from "../src/runtime/use-notification-routing";
import { useShareIntentRouting } from "../src/runtime/use-share-intent-routing";

/** Mounts the notification-tap router and the share-sheet router inside the runtime. */
function AppRouting(): null {
  useNotificationRouting();
  useShareIntentRouting();
  return null;
}

export default function RootLayout(): ReactNode {
  // Interface = DM Sans, display titles = Fraunces (see src/theme/tokens.ts `fontFamily`).
  // RN needs each weight loaded as its own face; gate the tree until they're ready so text
  // never flashes in the system font first. A LOAD FAILURE releases the gate instead of
  // blanking the app forever — the system font is the honest fallback (review finding).
  const [fontsLoaded, fontError] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    Fraunces_600SemiBold,
  });
  if (!fontsLoaded && !fontError) return null;
  return (
    <RuntimeProvider>
      <AppRouting />
      <Stack screenOptions={{ headerShown: true, headerBackTitle: "Back" }}>
        <Stack.Screen name="index" options={{ title: "Rennet" }} />
        <Stack.Screen name="pair" options={{ title: "Pair a daemon" }} />
        <Stack.Screen name="connections" options={{ title: "Connections" }} />
        <Stack.Screen name="kickoff" options={{ title: "New review" }} />
        <Stack.Screen name="settings/notifications" options={{ title: "Notifications" }} />
      </Stack>
    </RuntimeProvider>
  );
}
