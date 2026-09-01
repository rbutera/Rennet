import { reviewRoleMappings } from "@rennet/core";
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
          // The council tables are STATIC, so the review-role mappings are
          // readable with no settings dep at all — honest-present (C16, #485).
          // No persistence here, so every cell is a `default`.
          reviewRoles: reviewRoleMappings(),
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
    "settings.setThemePack": async (rawInput) => {
      const name = "settings.setThemePack" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(name, {
        themePack: deps.settings?.setThemePack(input.themePack) ?? input.themePack,
      });
    },
    "settings.completeWelcome": async (rawInput) => {
      const name = "settings.completeWelcome" as const;
      parseCommandInput(name, rawInput);
      return parseCommandOutput(name, {
        completedAt: deps.settings?.completeWelcome() ?? new Date().toISOString(),
      });
    },
    "settings.resetWelcome": async (rawInput) => {
      const name = "settings.resetWelcome" as const;
      // Replays the first-run welcome: drops the completion stamp and records the
      // request the startup gate honors even when projects exist. Personal, app-side —
      // client settings only, never a repo. Refused (throws) on a malformed file.
      parseCommandInput(name, rawInput);
      return parseCommandOutput(name, {
        replayRequestedAt: deps.settings?.resetWelcome() ?? new Date().toISOString(),
      });
    },
    "settings.setLastProject": async (rawInput) => {
      const name = "settings.setLastProject" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(name, deps.settings?.setLastProject(input) ?? input);
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
    "settings.setBenchmarkRecording": async (rawInput) => {
      const name = "settings.setBenchmarkRecording" as const;
      // Observability configuration, not a gate (Rule Zero): the write lands on the
      // first click and turning it off changes nothing about how a review runs. Client
      // settings only, never a repo; the dep REFUSES (throws) on a malformed file.
      // Absent dep ⇒ echo the request — there is nowhere to store it, and claiming a
      // different state than the caller asked for would be the lie, not the honesty.
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(name, {
        enabled: deps.settings?.setBenchmarkRecording(input.enabled) ?? input.enabled,
      });
    },
    "benchmarks.list": async (rawInput) => {
      const name = "benchmarks.list" as const;
      // Read-only over the durable archive. Fail-safe: no recorder wired (or nothing
      // recorded yet) reads as no runs, never a throw — an empty benchmarks panel is
      // the honest answer for a fresh install.
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(
        name,
        deps.listBenchmarks?.(input.limit ?? 200) ?? { runs: [], total: 0, skipped: [] },
      );
    },
    "settings.setRoleAssignment": async (rawInput) => {
      const name = "settings.setRoleAssignment" as const;
      // Personal, app-side (C16 #485): writes only the viewer's `routing.task`
      // slice in client settings, never a repo. The dep REFUSES (throws) on a
      // malformed config; that error propagates rather than overwriting
      // unparseable bytes (Rule 75). `assignment: null` RESETS to the council
      // default. Absent dep ⇒ the re-resolved council DEFAULTS: nothing was
      // persisted, and the response says so (every cell `default`) rather than
      // echoing a fake success carrying the edit.
      const input = parseCommandInput(name, rawInput);
      if (!deps.settings) {
        return parseCommandOutput(name, { reviewRoles: reviewRoleMappings() });
      }
      return parseCommandOutput(name, {
        reviewRoles: deps.settings.setRoleAssignment({
          roleId: input.roleId,
          scenario: input.scenario,
          assignment: input.assignment,
        }),
      });
    },
    "settings.setProjectValue": async (rawInput) => {
      const name = "settings.setProjectValue" as const;
      // The repo-rung per-project prefs (C18 group A): glyph, the worktree pair, and
      // this project's issue-tracker override — the last of which RETRIEVAL resolves
      // through, so the write reaches the review it configures. A `status` other than
      // `applied` means NOTHING was written (an unresolved checkout, or a
      // refused-because-malformed config, Rule 75). Absent dep ⇒ a typed `unresolved`
      // no-op, mirroring `resetRepoValue`: no store, so nothing was persisted.
      const input = parseCommandInput(name, rawInput);
      if (!deps.settings) {
        return parseCommandOutput(name, { status: "unresolved", key: input.key, project: null });
      }
      return parseCommandOutput(
        name,
        await deps.settings.setProjectValue({
          projectId: input.projectId,
          repoPath: input.repoPath,
          key: input.key,
          value: input.value,
        }),
      );
    },
    "settings.setGuidance": async (rawInput) => {
      const name = "settings.setGuidance" as const;
      // The WRITE beside `settings.guidance`'s read: the repo's own
      // `.rennet/conventions.json`, the file the lens runners read before every review.
      // The output is the catalogue read BACK off the file. Absent dep ⇒ `unresolved`
      // with the honest empty catalogue — nothing was stored, and it says so.
      const input = parseCommandInput(name, rawInput);
      if (!deps.settings) {
        return parseCommandOutput(name, {
          status: "unresolved",
          guidance: { rules: [], reason: "absent", dropped: 0 },
        });
      }
      return parseCommandOutput(
        name,
        await deps.settings.setGuidance({
          projectId: input.projectId,
          repoPath: input.repoPath,
          rules: input.rules,
        }),
      );
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
