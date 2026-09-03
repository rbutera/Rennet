// Expo Router's entry: it registers the root component that mounts the `app/` route tree.
// Kept as the package `main` (apps/mobile/package.json). No app logic lives here — routes are
// files under `app/`. Polyfills load FIRST (side-effect import order is preserved) so the
// shared client bridge finds `crypto.randomUUID` before any route mounts.
import "./src/polyfills";
import "expo-router/entry";
