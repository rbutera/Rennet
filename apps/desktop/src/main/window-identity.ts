import { existsSync } from "node:fs";
import { join } from "node:path";

// Stable Windows Application User Model ID. Without it Windows derives a default
// AUMID per executable path, so taskbar grouping, pinning, and toast identity
// break — a dev run and the packaged exe read as different apps. Kept aligned with
// the packaged identity (forge `executableName: "Rennet"`, reverse-DNS form).
export const APP_USER_MODEL_ID = "com.rennet.desktop";

// The AUMID Squirrel stamps onto the Start-menu/desktop shortcuts it creates on a
// win32 install: `com.squirrel.<AppName>.<ExeName>` — here both are "Rennet". Toasts
// only light up if the running process advertises the SAME id as its shortcut, so on
// a Squirrel install we must match this rather than our reverse-DNS default.
export const SQUIRREL_APP_USER_MODEL_ID = "com.squirrel.Rennet.Rennet";

// Pick the AUMID for the current process. On a Squirrel-installed win32 build the
// exe lives at `…\Root\app-<version>\Rennet.exe` with `Update.exe` one dir up, so
// that sibling is the tell. Everywhere else (dev run, ZIP build, non-win32) keep the
// stable reverse-DNS id. `exists` is injected so the choice is a pure, testable
// function with no electron/fs import.
export function resolveAppUserModelId(
  platform: NodeJS.Platform,
  execPath: string,
  exists: (candidate: string) => boolean,
): string {
  if (platform !== "win32") return APP_USER_MODEL_ID;
  const updateExe = join(execPath, "..", "..", "Update.exe");
  return exists(updateExe) ? SQUIRREL_APP_USER_MODEL_ID : APP_USER_MODEL_ID;
}

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

/**
 * True for a plain http(s) URL that may be handed to the OS browser. The window
 * shell routes `target="_blank"` opens and untrusted navigations through this:
 * matches open externally, everything else is denied outright (field bug
 * 2026-08-19: the GitHub device-flow verification link was a silent no-op under
 * the old deny-all handler).
 */
export function isExternalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
