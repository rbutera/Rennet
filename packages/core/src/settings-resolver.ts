import {
  type AppearanceScheme,
  appearanceSchemeSchema,
  type ClientSettings,
  type Locus,
  locusSchema,
  type ProjectMarkChoice,
  type ProjectVisibility,
  projectMarkChoiceSchema,
  projectVisibilitySchema,
  type ResolvedProvenance,
  type SettingsLayer,
} from "@rennet/protocol";
import { HOST_LOCUS } from "./locus";

/**
 * The settings resolver — provenance is the return type, not a feature (Settings
 * and Setup Plan §1.4). There is no `resolve(key): T` that hands back a bare value;
 * every resolution returns `Resolved<T>`, carrying the effective layer AND the full
 * lowest-first list of contributions, so the surface renders the RESOLVER's own
 * answer rather than a recomputed one that could silently disagree with the engine.
 *
 * The ladder is `builtin < detected < global < repo` (the four layers with a live
 * producer today; `LAYER_ORDER` is the single source of precedence). `detected` is
 * the environment-derived rung — today, execution-locus auto-detection — so a value
 * the machine guessed enters the ladder as an ordinary contribution any explicit
 * user choice beats. Precedence is specificity-wins: the highest offered layer is
 * effective; the rest are inert contributions, kept so "why is this value X?" is
 * always answerable on the surface.
 *
 * Every consumed setting is DECLARED once in `SETTINGS_REGISTRY` (its validator,
 * builtin default, permitted layers, merge strategy, and provenance renderer), and
 * both the generic `resolve` and the settings surface derive from it — adding a
 * setting is one registry entry, not a new resolve function plus hand-wired plumbing.
 *
 * Pure: no I/O, no clock. The adapters read the files; this only merges.
 */

/** A resolved setting: the effective value plus where it came from. */
export interface Resolved<T> {
  readonly value: T;
  readonly layer: SettingsLayer;
  readonly provenance: ResolvedProvenance;
}

/**
 * The single lowest→highest precedence list. Future rungs (a `workspace` layer
 * between `global` and `repo`, a `changeset` layer above `repo`) slot in as one
 * enum member + one insertion here — no re-keying of stored values, because files
 * never store a layer name; a layer is WHERE a file is.
 */
export const LAYER_ORDER: readonly SettingsLayer[] = ["builtin", "detected", "global", "repo"];

/**
 * One setting's declaration: its validator (reused from the protocol schemas so it
 * cannot drift from the malformed-config check), its builtin default, the layers
 * permitted to set it, its merge strategy, and how a value renders for provenance.
 */
export interface SettingDeclaration<T> {
  readonly key: string;
  /** Validate/parse an unknown value to `T` (reuses the protocol zod schema). */
  readonly validate: (value: unknown) => T;
  readonly builtinDefault: T;
  readonly layers: readonly SettingsLayer[];
  readonly merge: "replace";
  readonly render: (value: T) => string;
}

/** The built-in defaults — the base of every ladder, owned by nobody, ever. */
export const BUILTIN_SCHEME: AppearanceScheme = "system";
export const BUILTIN_VISIBILITY: ProjectVisibility = "local";
export const BUILTIN_PROMOTED = false;

const identity = (value: string): string => value;
/** Provenance string for a locus: `"host"` or `"WSL · <distro>"` (design Decision 3). */
const renderLocus = (locus: Locus): string =>
  locus.kind === "host" ? "host" : `WSL · ${locus.distro}`;

const SCHEME_SETTING: SettingDeclaration<AppearanceScheme> = {
  key: "scheme",
  validate: (value) => appearanceSchemeSchema.parse(value),
  builtinDefault: BUILTIN_SCHEME,
  layers: ["builtin", "global"],
  merge: "replace",
  render: identity,
};

const VISIBILITY_SETTING: SettingDeclaration<ProjectVisibility> = {
  key: "visibility",
  validate: (value) => projectVisibilitySchema.parse(value),
  builtinDefault: BUILTIN_VISIBILITY,
  layers: ["builtin", "repo"],
  merge: "replace",
  render: identity,
};

const PROMOTED_SETTING: SettingDeclaration<boolean> = {
  key: "promoted",
  // No protocol schema for a bare flag; a boolean IS its own validator.
  validate: (value) => {
    if (typeof value !== "boolean") throw new Error("promoted must be a boolean");
    return value;
  },
  builtinDefault: BUILTIN_PROMOTED,
  layers: ["builtin", "repo"],
  merge: "replace",
  render: (value) => String(value),
};

const LOCUS_SETTING: SettingDeclaration<Locus> = {
  key: "locus",
  validate: (value) => locusSchema.parse(value),
  builtinDefault: HOST_LOCUS,
  // Execution locus is a DETECTED FACT now (#476): builtin `host`, else the
  // environment guess from the repo path. The `repo` rung is deliberately absent
  // so a stale stored `config.locus` can NEVER re-enter resolution and silently
  // route execution somewhere the "detected" surface does not admit to.
  layers: ["builtin", "detected"],
  merge: "replace",
  render: renderLocus,
};

/**
 * The issue-tracker section (#461 resolution 2, B7 reconciliation 3): tracker
 * keys ride the ladder like any other setting. The scout offers the `detected`
 * layer where determinism can find a value; user answers land on `global`; the
 * per-project store is the `repo` rung (the same rung `visibility` uses). Base
 * URL and token env var NAME are config-only (#461 point 1 — the user supplies
 * them; the token VALUE itself lives in the env, never in any store).
 *
 * §4 facts NOT declared here: default branch is already a resolved fact
 * (project-discovery's origin/HEAD detection) — a settings row would be a
 * second source of truth; PR conventions are deferred by #461 §4 verbatim.
 */
export type TrackerKind = "none" | "github" | "jira" | "linear";

const trackerKind = (value: unknown): TrackerKind => {
  if (value === "none" || value === "github" || value === "jira" || value === "linear") {
    return value;
  }
  throw new Error(`trackerKind must be none|github|jira|linear, got ${JSON.stringify(value)}`);
};

/** A plain string setting; the default empty builtin reads as "unset". A key whose
 *  builtin is a REAL value (the worktree patterns) passes it instead, so the ladder's
 *  base is the shape the binding actually uses rather than a blank the reader must
 *  know to translate. */
const stringSetting = (
  key: string,
  layers: readonly SettingsLayer[],
  builtinDefault = "",
): SettingDeclaration<string> => ({
  key,
  validate: (value) => {
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    return value.trim();
  },
  builtinDefault,
  layers,
  merge: "replace",
  render: (value) => (value === "" ? "(unset)" : value),
});

const TRACKER_KIND_SETTING: SettingDeclaration<TrackerKind> = {
  key: "trackerKind",
  validate: trackerKind,
  builtinDefault: "none",
  layers: ["builtin", "detected", "global", "repo"],
  merge: "replace",
  render: identity,
};

const DETECTABLE: readonly SettingsLayer[] = ["builtin", "detected", "global", "repo"];
const CONFIG_ONLY: readonly SettingsLayer[] = ["builtin", "global", "repo"];
/** No producer above the repo rung: nothing detects a glyph, and no global default
 *  exists for one — so the only offers are the builtin (unset) and the project's own. */
const REPO_ONLY: readonly SettingsLayer[] = ["builtin", "repo"];

/**
 * The worktree placement builtins (workspace-settings D2). These are EXACTLY the shapes
 * the previous release hardcoded — `join(dataDir, "worktrees", repoKey, ...branch)` and
 * `join(dataDir, "worktrees", owner, name, "pr-N")` — expressed as patterns, so an
 * install that never touches a rung places every worktree where it always did.
 */
export const BUILTIN_WORKTREE_PATTERN = "{repo}/{branch}";
export const BUILTIN_PR_WORKTREE_PATTERN = "{owner}/{name}/pr-{number}";

/**
 * Whether a review of a branch a checkout ALREADY has out binds to that checkout
 * (`share`) or to a worktree Rennet makes beside it on a sibling branch (`own`).
 * Builtin `share`: the agent's work lands where the reviewer is looking, which is the
 * right default; `own` is the reviewer's answer when that tree is theirs to keep.
 */
export type WorkspaceMode = "share" | "own";
export const BUILTIN_WORKSPACE: WorkspaceMode = "share";

const WORKSPACE_SETTING: SettingDeclaration<WorkspaceMode> = {
  key: "workspace",
  validate: (value) => {
    if (value === "share" || value === "own") return value;
    throw new Error(`workspace must be share|own, got ${JSON.stringify(value)}`);
  },
  builtinDefault: BUILTIN_WORKSPACE,
  // No detector: whether Rennet may work inside the reviewer's own checkout is a
  // decision about their tree, never a guess made from it.
  layers: CONFIG_ONLY,
  merge: "replace",
  render: identity,
};

/**
 * Which project mark a project shows (#900): the builtin is `glyph`, the `detected` rung is
 * offered when the project holds a copied repo logo, and the user's own answer sits on the
 * repo rung. That ordering IS the product decision — a fresh add shows the repo's logo with
 * no click, and an explicit glyph beats a later detection — and it is the whole reason this
 * is a ladder row rather than a boolean somewhere. There is no global rung: a mark is a fact
 * about ONE project, and a host-wide default for it would mean nothing.
 */
const PROJECT_MARK_SETTING: SettingDeclaration<ProjectMarkChoice> = {
  key: "projectMark",
  validate: (value) => projectMarkChoiceSchema.parse(value),
  builtinDefault: "glyph",
  layers: ["builtin", "detected", "repo"],
  merge: "replace",
  render: identity,
};

/** Every consumed setting, keyed by id. Adding a setting is one entry here. */
export const SETTINGS_REGISTRY = {
  scheme: SCHEME_SETTING,
  visibility: VISIBILITY_SETTING,
  promoted: PROMOTED_SETTING,
  locus: LOCUS_SETTING,
  // Issue-tracker section (#461 §4 + resolution 2).
  trackerKind: TRACKER_KIND_SETTING,
  trackerProjectKey: stringSetting("trackerProjectKey", DETECTABLE),
  trackerBaseUrl: stringSetting("trackerBaseUrl", CONFIG_ONLY),
  trackerTokenEnv: stringSetting("trackerTokenEnv", CONFIG_ONLY),
  // §4 non-tracker facts the ladder does not already resolve.
  // The worktree LOCATION (workspace-settings D1). `CONFIG_ONLY`, like the two patterns
  // and `workspace`: the scout can see where a repository's own worktrees already live,
  // but that is the repository's convention, not an instruction about where Rennet should
  // place its own — and offering it moved placement under every repo that already had a
  // sibling worktree, which the spec's "an untouched install places nothing differently"
  // forbids. All four worktree keys resolve `builtin < global < repo`.
  worktreeBaseDir: stringSetting("worktreeBaseDir", CONFIG_ONLY),
  gateCommand: stringSetting("gateCommand", DETECTABLE),
  // The per-project prefs the Projects surface edits (C18 group A). They ride the
  // SAME ladder as everything above — the repo rung is the project's own
  // `config.json`, so a per-project answer beats the host's global one and the
  // builtin "" reads as unset (the client then shows ITS default, never a value the
  // ladder did not resolve). `worktreeBaseDir` above is the location half of the
  // worktree pair; nothing detects any of the four, so all of them are config-only.
  //
  // The two patterns' builtins are REAL values, not "": the binding reads them, so the
  // base of the ladder has to be the shape it places by. A snapshot has a number and no
  // branch and a branch has no number, which is why one grammar could not serve both.
  worktreePattern: stringSetting("worktreePattern", CONFIG_ONLY, BUILTIN_WORKTREE_PATTERN),
  prWorktreePattern: stringSetting("prWorktreePattern", CONFIG_ONLY, BUILTIN_PR_WORKTREE_PATTERN),
  workspace: WORKSPACE_SETTING,
  projectGlyph: stringSetting("projectGlyph", REPO_ONLY),
  projectMark: PROJECT_MARK_SETTING,
} as const;

/**
 * Resolve a setting by folding its offers in `LAYER_ORDER`. `builtin` always
 * contributes the declared default (so a result is total); every other layer
 * contributes only if it offered a defined value AND the declaration permits it —
 * an offer at a forbidden layer is a programming error and throws. The last
 * (highest) contribution is effective; every offer is kept as a contribution so the
 * surface can explain the value. `replace` is the only strategy any registered key
 * needs today (each offer wholly supersedes the lower ones).
 */
export function resolve<T>(
  decl: SettingDeclaration<T>,
  offers: Partial<Record<SettingsLayer, T | undefined>>,
): Resolved<T> {
  const contributions: ResolvedProvenance["contributions"] = [];
  let effectiveLayer: SettingsLayer = "builtin";
  let effectiveValue: T = decl.builtinDefault;
  for (const layer of LAYER_ORDER) {
    const value = layer === "builtin" ? decl.builtinDefault : offers[layer];
    if (value === undefined) continue;
    if (layer !== "builtin" && !decl.layers.includes(layer)) {
      throw new Error(`settings: layer "${layer}" may not set "${decl.key}"`);
    }
    contributions.push({ layer, value: decl.render(value), effective: false });
    effectiveLayer = layer;
    effectiveValue = value;
  }
  const last = contributions.at(-1);
  if (last === undefined) {
    throw new Error("settings resolver: no builtin value supplied (unreachable)");
  }
  last.effective = true;
  return {
    value: effectiveValue,
    layer: effectiveLayer,
    provenance: { layer: effectiveLayer, contributions },
  };
}

/** One tracker section's offers, per key, per layer. */
export interface TrackerOffers {
  readonly kind: Partial<Record<SettingsLayer, TrackerKind | undefined>>;
  readonly projectKey: Partial<Record<SettingsLayer, string | undefined>>;
  readonly baseUrl: Partial<Record<SettingsLayer, string | undefined>>;
  readonly tokenEnv: Partial<Record<SettingsLayer, string | undefined>>;
}

/** A tracker section as the ladder resolves it: the kind plus its endpoint fields. */
export interface ResolvedTracker {
  readonly kind: Resolved<TrackerKind>;
  readonly projectKey: Resolved<string>;
  readonly baseUrl: Resolved<string>;
  readonly tokenEnv: Resolved<string>;
}

/**
 * Resolve a whole tracker section under ONE law, because the keys are not
 * independent: `baseUrl`, `tokenEnv` and `projectKey` belong to a PROVIDER. Resolving
 * them key-by-key mixed rungs — a project that set `kind: jira` on its repo rung
 * inherited the host's Linear URL and Linear token env var from the global rung, and
 * retrieval then called a JIRA endpoint with Linear credentials.
 *
 * So: the layer that supplies the effective KIND is the floor for its endpoint fields.
 * An offer BELOW that layer described a different provider and is masked out (the
 * field falls to its builtin — honestly absent, which reads as missing config and
 * disables retrieval, never a wrong endpoint). An offer AT or ABOVE it is a
 * refinement of the same choice and still wins, so a global kind with a per-project
 * base URL keeps working.
 *
 * Shared by the settings surface and by retrieval's `resolveTrackerConfig`, so the
 * provenance chip can never disagree with the endpoint a review actually calls.
 */
export function resolveTracker(offers: TrackerOffers): ResolvedTracker {
  const kind = resolve(SETTINGS_REGISTRY.trackerKind, offers.kind);
  const floor = LAYER_ORDER.indexOf(kind.layer);
  const belowKind = (
    field: Partial<Record<SettingsLayer, string | undefined>>,
  ): Partial<Record<SettingsLayer, string | undefined>> => {
    const kept: Partial<Record<SettingsLayer, string | undefined>> = {};
    for (const [layer, value] of Object.entries(field) as [SettingsLayer, string | undefined][]) {
      if (LAYER_ORDER.indexOf(layer) >= floor) kept[layer] = value;
    }
    return kept;
  };
  return {
    kind,
    projectKey: resolve(SETTINGS_REGISTRY.trackerProjectKey, belowKind(offers.projectKey)),
    baseUrl: resolve(SETTINGS_REGISTRY.trackerBaseUrl, belowKind(offers.baseUrl)),
    tokenEnv: resolve(SETTINGS_REGISTRY.trackerTokenEnv, belowKind(offers.tokenEnv)),
  };
}

/**
 * Resolve the appearance scheme: builtin `system`, overridden by the viewer's
 * personal client settings. There is no repo layer for a personal preference.
 */
export function resolveScheme(client: ClientSettings): Resolved<AppearanceScheme> {
  return resolve(SCHEME_SETTING, { global: client.appearance?.scheme });
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
  return resolve(VISIBILITY_SETTING, { repo: repoVisibility });
}

/**
 * Resolve a project's map promotion state: builtin `false`, overridden by the
 * project's own stored `promoted` flag (the repo layer). Carries provenance like
 * every other row, so the surface can state whether `false` is the builtin default
 * or an explicit repo-set value (the wireframe's "every row states its source").
 */
export function resolvePromoted(repoPromoted: boolean | undefined): Resolved<boolean> {
  return resolve(PROMOTED_SETTING, { repo: repoPromoted });
}

/**
 * Resolve a project's execution locus: builtin `host` under the `detected`
 * environment guess (auto-detection from the repo path). Detection-only (#476) —
 * there is NO stored override rung, so `config.locus` from an old config never
 * reaches execution; the resolved value always matches what the surface shows.
 */
export function resolveLocus(detected: Locus): Resolved<Locus> {
  return resolve(LOCUS_SETTING, { detected });
}
