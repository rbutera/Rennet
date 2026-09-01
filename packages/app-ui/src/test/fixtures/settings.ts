import type {
  AppearanceScheme,
  BenchmarkRun,
  CoachMarks,
  ResolvedProvenance,
  SettingsGuidance,
  SettingsProject,
  SettingsView,
  ThemePack,
} from "@rennet/protocol";
import { MemoryBridge, type MemoryBridgeHandlers } from "../memory-bridge";

// ─────────────────────────────────────────────────────────────────────────────
// The settings MemoryBridge fixture (C10 §2.2). A STATEFUL handler set for the live
// `settings.*` commands, so every settings page is provable now: a write mutates the
// store, `settings.get` re-reads it, and the seam's invalidation re-renders the
// resolver's own answer — never a hollow pass. Data enters the app only through the
// bridge context (the fence test keeps that true); this is not an importable data
// module a surface could reach.
//
// The PROJECTED reads (environments, detection, mappings, glyphs, worktree, tracker)
// do NOT ride these commands — they resolve through the `SettingsProjection` context,
// which the app binds to real commands in `live-projection.tsx` and a test binds to a
// stateful fixture. This fixture serves only the eight `settings.*` commands.
// ─────────────────────────────────────────────────────────────────────────────

/** Provenance for a value resolved from the global rung over the builtin default. */
function globalOverBuiltin(builtin: string, chosen: string): ResolvedProvenance {
  return {
    layer: "global",
    contributions: [
      { layer: "builtin", value: builtin, effective: false },
      { layer: "global", value: chosen, effective: true },
    ],
  };
}

/** Provenance for a value left at its builtin default (nothing overrode it). */
function builtinOnly(value: string): ResolvedProvenance {
  return { layer: "builtin", contributions: [{ layer: "builtin", value, effective: true }] };
}

export interface SettingsFixtureSeed {
  readonly scheme?: AppearanceScheme;
  readonly appearanceMalformed?: boolean;
  readonly keybindings?: Record<string, string | null>;
  readonly projects?: readonly SettingsProject[];
  /** Per-repoPath guidance catalogues (`settings.guidance` reads by repoPath). */
  readonly guidance?: Readonly<Record<string, SettingsGuidance>>;
  /** The persisted onboarding coach-mark slice (C13) the coach provider seeds from. */
  readonly coachmarks?: CoachMarks;
  readonly themePack?: ThemePack;
  readonly welcome?: SettingsView["welcome"];
  readonly navigation?: SettingsView["navigation"];
  /** Whether benchmark recording resolves ON (#731). Absent ⇒ on, the real default. */
  readonly benchmarkRecording?: boolean;
  /** The archive `benchmarks.list` serves, newest first. */
  readonly benchmarks?: readonly BenchmarkRun[];
  /** Archive lines the store could not read, which the panel must surface rather than
   *  quietly serve a shorter history. */
  readonly benchmarkSkipped?: readonly string[];
}

const EMPTY_GUIDANCE: SettingsGuidance = { rules: [], reason: "absent", dropped: 0 };

/**
 * A mutable settings store that produces {@link MemoryBridgeHandlers}. Holds the live
 * view + guidance and mutates on every write, so a test can drive an edit and assert a
 * re-read reflects it. `appearanceMalformed` makes the appearance write REFUSE (throw),
 * mirroring the real command's Rule-75 protection of unparseable bytes.
 */
export class SettingsStore {
  #scheme: AppearanceScheme;
  readonly #appearanceMalformed: boolean;
  #keybindings: Record<string, string | null>;
  #projects: SettingsProject[];
  readonly #guidance: Record<string, SettingsGuidance>;
  #coachmarks: CoachMarks | undefined;
  #themePack: ThemePack | undefined;
  #welcome: SettingsView["welcome"];
  #navigation: SettingsView["navigation"];
  #benchmarkRecording: boolean;
  readonly #benchmarks: BenchmarkRun[];
  readonly #benchmarkSkipped: string[];

  constructor(seed: SettingsFixtureSeed = {}) {
    this.#scheme = seed.scheme ?? "system";
    this.#appearanceMalformed = seed.appearanceMalformed ?? false;
    this.#keybindings = { ...(seed.keybindings ?? {}) };
    this.#projects = [...(seed.projects ?? [])];
    this.#guidance = { ...(seed.guidance ?? {}) };
    this.#coachmarks = seed.coachmarks ? { ...seed.coachmarks } : undefined;
    this.#themePack = seed.themePack;
    this.#welcome = seed.welcome ?? { completedAt: "2026-08-28T00:00:00.000Z" };
    this.#navigation = seed.navigation;
    this.#benchmarkRecording = seed.benchmarkRecording ?? true;
    this.#benchmarks = [...(seed.benchmarks ?? [])];
    this.#benchmarkSkipped = [...(seed.benchmarkSkipped ?? [])];
  }

  #view(): SettingsView {
    const scheme = this.#appearanceMalformed ? "system" : this.#scheme;
    const schemeProvenance =
      !this.#appearanceMalformed && this.#scheme !== "system"
        ? globalOverBuiltin("system", this.#scheme)
        : builtinOnly("system");
    return {
      scheme,
      schemeProvenance,
      appearanceMalformed: this.#appearanceMalformed,
      projects: this.#projects,
      keybindings: Object.keys(this.#keybindings).length > 0 ? { ...this.#keybindings } : undefined,
      coachmarks: this.#coachmarks ? { ...this.#coachmarks } : undefined,
      themePack: this.#themePack,
      welcome: this.#welcome,
      navigation: this.#navigation,
      benchmarkRecording: this.#benchmarkRecording,
    };
  }

  handlers(): MemoryBridgeHandlers {
    return {
      "settings.get": () => this.#view(),
      "settings.guidance": ({ repoPath }) => this.#guidance[repoPath] ?? EMPTY_GUIDANCE,
      "settings.setAppearance": ({ scheme }) => {
        if (this.#appearanceMalformed) throw new Error("settings config malformed");
        this.#scheme = scheme ?? "system";
        return { scheme: this.#view().scheme, schemeProvenance: this.#view().schemeProvenance };
      },
      "settings.setThemePack": ({ themePack }) => {
        this.#themePack = themePack;
        return { themePack };
      },
      "settings.completeWelcome": () => {
        const completedAt = "2026-08-28T12:00:00.000Z";
        this.#welcome = { completedAt };
        return { completedAt };
      },
      // Mirrors the real command: the request is ADDED and an existing completion stamp
      // is PRESERVED (an older v1 build requires `welcome.completedAt`). The startup
      // gate elects the replay on the request's presence, so the pair is unambiguous.
      "settings.resetWelcome": () => {
        const replayRequestedAt = "2026-08-28T13:00:00.000Z";
        this.#welcome = this.#welcome?.completedAt
          ? { completedAt: this.#welcome.completedAt, replayRequestedAt }
          : { replayRequestedAt };
        return { replayRequestedAt };
      },
      "settings.setLastProject": ({ source, projectId }) => {
        this.#navigation = {
          lastProjectBySource: { ...this.#navigation?.lastProjectBySource, [source]: projectId },
        };
        return { source, projectId };
      },
      "settings.setKeybinding": ({ id, keybinding }) => {
        if (keybinding === undefined) delete this.#keybindings[id];
        else this.#keybindings[id] = keybinding;
        return { keybindings: { ...this.#keybindings } };
      },
      "settings.setCoachmarks": (input) => {
        this.#coachmarks = { ...input };
        return { ...input };
      },
      "settings.setBenchmarkRecording": ({ enabled }) => {
        this.#benchmarkRecording = enabled;
        return { enabled };
      },
      // The panel's read honours its own `limit`, exactly as the real command does — the
      // cap is what keeps a long history off the wire, so a fixture that ignored it would
      // make the perf property untestable.
      "benchmarks.list": ({ limit }) => ({
        runs: this.#benchmarks.slice(0, limit ?? 200),
        total: this.#benchmarks.length,
        skipped: [...this.#benchmarkSkipped],
      }),
    };
  }
}

/** A MemoryBridge pre-loaded with the settings handlers for `seed`. */
export function settingsBridge(
  seed: SettingsFixtureSeed = {},
  options: { readonly platform?: string; readonly version?: string } = {},
): MemoryBridge {
  return new MemoryBridge(new SettingsStore(seed).handlers(), options);
}
