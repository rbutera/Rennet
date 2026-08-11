import type {
  AppearanceScheme,
  GlobalConfig,
  ProjectVisibility,
  ResolvedProvenance,
  SettingsLayer,
} from "@rennet/protocol";

/**
 * The settings resolver — provenance is the return type, not a feature (Settings
 * and Setup Plan §1.4). There is no `resolve(key): T` that hands back a bare value;
 * every resolution returns `Resolved<T>`, carrying the effective layer AND the full
 * lowest-first list of contributions, so the surface renders the RESOLVER's own
 * answer rather than a recomputed one that could silently disagree with the engine.
 *
 * The ladder is `builtin < global < repo` (a slice of the plan's eight layers —
 * the ones that exist as consumed config today). Precedence is specificity-wins:
 * the highest layer that offered a value is effective; the rest are inert
 * contributions, kept so "why is this value X?" is always answerable on the surface.
 *
 * Pure: no I/O, no clock. The adapters read the files; this only merges.
 */

/** A resolved setting: the effective value plus where it came from. */
export interface Resolved<T> {
  readonly value: T;
  readonly layer: SettingsLayer;
  readonly provenance: ResolvedProvenance;
}

/** The built-in defaults — the base of every ladder, owned by nobody, ever. */
export const BUILTIN_SCHEME: AppearanceScheme = "system";
export const BUILTIN_VISIBILITY: ProjectVisibility = "local";
export const BUILTIN_PROMOTED = false;

/**
 * Fold a lowest-first list of `(layer, value?)` offers into a `Resolved<T>`. The
 * last defined offer wins (specificity: later layers are more specific); every
 * offer that supplied a value becomes a contribution, exactly one flagged
 * effective. `render` stringifies a value for the provenance display (so a boolean
 * setting like promotion carries `"true"`/`"false"` on the surface). The builtin
 * offer must always supply a value, so a result is total.
 */
function fold<T>(
  offers: ReadonlyArray<{ layer: SettingsLayer; value: T | undefined }>,
  render: (value: T) => string,
): Resolved<T> {
  const contributions: ResolvedProvenance["contributions"] = [];
  let effectiveLayer: SettingsLayer = "builtin";
  let effectiveValue: T | undefined;
  for (const offer of offers) {
    if (offer.value === undefined) continue;
    contributions.push({ layer: offer.layer, value: render(offer.value), effective: false });
    effectiveLayer = offer.layer;
    effectiveValue = offer.value;
  }
  // The last contribution pushed IS the effective one (offers are lowest-first, so
  // the last defined value is the most specific). Flag it in place.
  const last = contributions.at(-1);
  if (last === undefined || effectiveValue === undefined) {
    throw new Error("settings resolver: no builtin value supplied (unreachable)");
  }
  last.effective = true;
  return {
    value: effectiveValue,
    layer: effectiveLayer,
    provenance: { layer: effectiveLayer, contributions },
  };
}

const identity = (value: string): string => value;

/**
 * Resolve the appearance scheme: builtin `system`, overridden by the global
 * personal config. There is no repo layer for a personal preference.
 */
export function resolveScheme(global: GlobalConfig): Resolved<AppearanceScheme> {
  return fold<AppearanceScheme>(
    [
      { layer: "builtin", value: BUILTIN_SCHEME },
      { layer: "global", value: global.appearance?.scheme },
    ],
    identity,
  );
}

/**
 * Resolve a project's map visibility: builtin `local`, overridden by the project's
 * own stored `visibility` (the repo layer). `repoVisibility` is the value read from
 * the project's `~/.rennet/projects/<key>/config.json`, or `undefined` when the
 * project has never set one (the common, zero-config case).
 */
export function resolveVisibility(
  repoVisibility: ProjectVisibility | undefined,
): Resolved<ProjectVisibility> {
  return fold<ProjectVisibility>(
    [
      { layer: "builtin", value: BUILTIN_VISIBILITY },
      { layer: "repo", value: repoVisibility },
    ],
    identity,
  );
}

/**
 * Resolve a project's map promotion state: builtin `false`, overridden by the
 * project's own stored `promoted` flag (the repo layer). Carries provenance like
 * every other row, so the surface can state whether `false` is the builtin default
 * or an explicit repo-set value (the wireframe's "every row states its source").
 */
export function resolvePromoted(repoPromoted: boolean | undefined): Resolved<boolean> {
  return fold<boolean>(
    [
      { layer: "builtin", value: BUILTIN_PROMOTED },
      { layer: "repo", value: repoPromoted },
    ],
    (value) => String(value),
  );
}
