import { existsSync } from "node:fs";
import { join } from "node:path";

// Stable Windows Application User Model ID. Without it Windows derives a default
// AUMID per executable path, so taskbar grouping, pinning, and toast identity
// break — a dev run and the packaged exe read as different apps. Kept aligned with
// the packaged identity (forge `executableName: "Rennet"`, reverse-DNS form).
export const APP_USER_MODEL_ID = "com.rennet.desktop";

// Window icon for the dev run and Linux, where nothing embeds an icon into the
// binary. The packaged win32 exe carries the brand `.ico` via forge, so on that
// path the file may be absent from the app layout — a missing file must degrade to
// "no icon option", never throw. `baseDir` is the compiled main's dir (dist/main);
// brand/ lives at the repo root in the dev/source layout.
export function brandWindowIcon(baseDir: string, platform: NodeJS.Platform): string | undefined {
  const rel =
    platform === "win32"
      ? "app-icons/windows/rennet-white-on-black.ico"
      : platform === "linux"
        ? "app-icons/linux/white-on-black/256x256.png"
        : undefined;
  if (!rel) return undefined;
  const candidate = join(baseDir, "../../../../brand/exports", rel);
  return existsSync(candidate) ? candidate : undefined;
}
