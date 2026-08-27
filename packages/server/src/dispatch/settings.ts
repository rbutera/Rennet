import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

export function settingsHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "settings.get": async (rawInput) => {
      const name = "settings.get" as const;
      // Read-only: the global appearance layer + every project's resolved repo
      // config with provenance. Absent settings dep ⇒ builtin-only view (no
      // global override, no projects), never a throw.
      parseCommandInput(name, rawInput);
      if (!deps.settings) {
        return parseCommandOutput(name, {
          scheme: "system",
          schemeProvenance: {
            layer: "builtin",
            contributions: [{ layer: "builtin", value: "system", effective: true }],
          },
          appearanceMalformed: false,
          projects: [],
        });
      }
      return parseCommandOutput(name, await deps.settings.get());
    },
    "settings.guidance": async (rawInput) => {
      const name = "settings.guidance" as const;
      // Read-only: one repo's `.rennet/conventions.json` house rules, shown
      // read-through. Absent dep ⇒ the honest empty catalogue.
      const input = parseCommandInput(name, rawInput);
      if (!deps.settings) {
        return parseCommandOutput(name, { rules: [], reason: "absent", dropped: 0 });
      }
      return parseCommandOutput(
        name,
        await deps.settings.guidance(input.projectId, input.repoPath),
      );
    },
    "settings.setAppearance": async (rawInput) => {
      const name = "settings.setAppearance" as const;
      // Personal, app-side: writes only `~/.rennet/config.json`. No repo write.
      // The dep REFUSES (throws) when the config is malformed; that error
      // propagates to the renderer rather than overwriting unparseable bytes.
      const input = parseCommandInput(name, rawInput);
      if (!deps.settings) {
        // A null scheme RESETS to the builtin (`system`); a concrete scheme sets it.
        return parseCommandOutput(
          name,
          input.scheme === null
            ? {
                scheme: "system",
                schemeProvenance: {
                  layer: "builtin",
                  contributions: [{ layer: "builtin", value: "system", effective: true }],
                },
              }
            : {
                scheme: input.scheme,
                schemeProvenance: {
                  layer: "global",
                  contributions: [
                    { layer: "builtin", value: "system", effective: false },
                    { layer: "global", value: input.scheme, effective: true },
                  ],
                },
              },
        );
      }
      const scheme = deps.settings.setAppearance(input.scheme);
      // Re-resolve so the surface renders the resolver's own provenance answer.
      return parseCommandOutput(name, {
        scheme,
        schemeProvenance: (await deps.settings.get()).schemeProvenance,
      });
    },
    "settings.setKeybinding": async (rawInput) => {
      const name = "settings.setKeybinding" as const;
      // Personal, app-side (#44): writes only `~/.rennet/config.json`, never a repo.
      // The dep REFUSES (throws) on a malformed config; that error propagates rather
      // than overwriting unparseable bytes. A conflicting chord is accepted and
      // persisted — disclosure, not a gate (Rule Zero). Absent dep ⇒ an empty map.
      const input = parseCommandInput(name, rawInput);
      if (!deps.settings) {
        return parseCommandOutput(name, { keybindings: {} });
      }
      return parseCommandOutput(name, {
        keybindings: deps.settings.setKeybinding({
          id: input.id,
          keybinding: input.keybinding,
        }),
      });
    },
    "settings.setCoachmarks": async (rawInput) => {
      const name = "settings.setCoachmarks" as const;
      // Personal, app-side (C13): writes only client settings, never a repo. The dep
      // REFUSES (throws) on a malformed config; that error propagates rather than
      // overwriting unparseable bytes (Rule 75). No gate — skip/dismiss/replay each
      // persist on the first click (Rule Zero). Absent dep ⇒ echo the slice unstored.
      const input = parseCommandInput(name, rawInput);
      if (!deps.settings) {
        return parseCommandOutput(name, input);
      }
      return parseCommandOutput(name, deps.settings.setCoachmarks(input));
    },
    "settings.setRepoVisibility": async (rawInput) => {
      const name = "settings.setRepoVisibility" as const;
      // Genuinely consumed: runs the real visibility switch (a repo `.gitignore`
      // write, exclusion state only) and records `visibility` in the repo's
      // config. A `status` other than `applied` means NOTHING was written (an
      // unresolved checkout or a refused-because-malformed config). Absent dep ⇒
      // a typed `unresolved` no-op, mirroring `openInEditor`.
      const input = parseCommandInput(name, rawInput);
      if (!deps.settings) {
        return parseCommandOutput(name, {
          status: "unresolved",
          visibility: input.visibility,
          changed: false,
          gitignorePath: "",
        });
      }
      const result = await deps.settings.setRepoVisibility({
        projectId: input.projectId,
        repoPath: input.repoPath,
        visibility: input.visibility,
      });
      return parseCommandOutput(name, result);
    },
    "settings.resetRepoValue": async (rawInput) => {
      const name = "settings.resetRepoValue" as const;
      // Reset a repo-scoped value to inheritance (drop the repo-layer entry;
      // visibility also re-applies the gitignore switch). A plain write, no gate
      // (Rule Zero). Absent dep ⇒ a typed `unresolved` no-op.
      const input = parseCommandInput(name, rawInput);
      if (!deps.settings) {
        return parseCommandOutput(name, {
          status: "unresolved",
          key: input.key,
          project: null,
        });
      }
      return parseCommandOutput(
        name,
        await deps.settings.resetRepoValue({
          projectId: input.projectId,
          repoPath: input.repoPath,
          key: input.key,
        }),
      );
    },
    "settings.pinRepoValue": async (rawInput) => {
      const name = "settings.pinRepoValue" as const;
      // Pin a repo-scoped value at the repo layer (set-to-current-effective).
      // Absent dep ⇒ a typed `unresolved` no-op.
      const input = parseCommandInput(name, rawInput);
      if (!deps.settings) {
        return parseCommandOutput(name, {
          status: "unresolved",
          key: input.key,
          project: null,
        });
      }
      return parseCommandOutput(
        name,
        await deps.settings.pinRepoValue({
          projectId: input.projectId,
          repoPath: input.repoPath,
          key: input.key,
        }),
      );
    },
  } satisfies Record<string, CommandHandler>;
}
