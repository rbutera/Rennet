import type { RennetBridge } from "@rennet/protocol";

// The browser shell's command-interception allowlist (issue #381, design D5/D6).
//
// Both shells share `WsRennetBridge`, so the transport drops no command — every wire
// command reaches dispatch. The ONE place the browser shell steps in front of the bridge
// is `repository.choose`: a browser tab has no native directory picker, so first-contact
// choose prompts for an absolute path on the daemon's machine and forwards it. This map is
// the single source of truth for what the browser shell intercepts and WHY; the parity
// inventory test asserts it is exactly this set with a justification for each, so a new
// interception cannot be added silently.
export const BROWSER_SHELL_INTERCEPTS = {
  "repository.choose":
    "A browser tab has no native directory picker; first-contact choose prompts for an absolute path on the daemon's machine (design D5). Parity holds — the command still reaches dispatch, just with a prompted path instead of a picked one.",
} as const satisfies Record<string, string>;

/** The set the browser composition checks before prompting. Derived from the allowlist above. */
export const BROWSER_SHELL_INTERCEPT_NAMES: ReadonlySet<string> = new Set(
  Object.keys(BROWSER_SHELL_INTERCEPTS),
);

export function composeBrowserInvoke(
  wsInvoke: RennetBridge["invoke"],
  promptForRepository = () =>
    window.prompt("Absolute path to a repository on the daemon's machine:"),
): RennetBridge["invoke"] {
  return async (name, input) => {
    if (
      BROWSER_SHELL_INTERCEPT_NAMES.has(name) &&
      (input as { path?: string }).path === undefined
    ) {
      const path = promptForRepository();
      if (!path) return { path: null } as never;
      return wsInvoke("repository.choose", { path }) as never;
    }
    return wsInvoke(name, input);
  };
}
