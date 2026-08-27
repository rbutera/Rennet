import type {
  AppearanceScheme,
  CoachMarks,
  ResolvedProvenance,
  SettingsGuidance,
  SettingsProject,
  SettingsView,
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
// The B10-absent projections (environments, detection, mappings, glyphs, worktree,
// tracker) do NOT ride these commands — they resolve through the `SettingsProjection`
// context (no new dispatch binding in C10, reconciliation 5). This fixture serves only
// the eight commands that exist on `main`.
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

  constructor(seed: SettingsFixtureSeed = {}) {
    this.#scheme = seed.scheme ?? "system";
    this.#appearanceMalformed = seed.appearanceMalformed ?? false;
    this.#keybindings = { ...(seed.keybindings ?? {}) };
    this.#projects = [...(seed.projects ?? [])];
    this.#guidance = { ...(seed.guidance ?? {}) };
    this.#coachmarks = seed.coachmarks ? { ...seed.coachmarks } : undefined;
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
      "settings.setKeybinding": ({ id, keybinding }) => {
        if (keybinding === undefined) delete this.#keybindings[id];
        else this.#keybindings[id] = keybinding;
        return { keybindings: { ...this.#keybindings } };
      },
      "settings.setCoachmarks": (input) => {
        this.#coachmarks = { ...input };
        return { ...input };
      },
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
