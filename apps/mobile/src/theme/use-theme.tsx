// The RN theme hook (issue #383 M1). Wraps the pure `resolveTheme` transpose with React
// Native's color scheme, so components read `const t = useTheme()` and get the light/dark
// palette that matches the device. Kept out of tokens.ts so the tokens stay framework-free
// and unit-testable.

import { useColorScheme } from "react-native";
import { type Palette, resolveTheme } from "./tokens";

/** The active palette for the device's colour scheme (defaults to light when unset). */
export function useTheme(): Palette {
  const scheme = useColorScheme();
  return resolveTheme(scheme === "dark" ? "dark" : "light");
}
