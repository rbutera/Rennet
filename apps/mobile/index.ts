// Expo Router's entry: it registers the root component that mounts the `app/` route tree.
// Kept as the package `main` (apps/mobile/package.json). No app logic lives here — routes are
// files under `app/`. Polyfills load FIRST (side-effect import order is preserved) so the
// shared client bridge finds `crypto.randomUUID` before any route mounts.
import "./src/polyfills";
// Define + register the background notification-response task at entry, before the router mounts,
// so expo-task-manager finds it when the OS wakes the app in the background to honour an ask's
// answer chip on Android (#382 M2 finding 4).
import { registerBackgroundNotificationTask } from "./src/runtime/background-task";
import "expo-router/entry";

void registerBackgroundNotificationTask();
