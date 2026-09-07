/**
 * The project scout (#461 §4, B7 cluster 4): the detection set that runs at
 * project add, re-runnable, deterministic-first.
 *
 * Zero-cost deterministic pass first (git remote → GitHub, JIRA/Linear markers
 * in README + commit subjects, package manifests → gate command, logo files,
 * `git worktree list` → base-dir convention). The `project-scout` council seat
 * (injected `runTurn`, B6 pattern) fills ONLY what determinism left empty —
 * a detected value is never overwritten — and every answer carries provenance
 * so the questionnaire renders detected vs guessed.
 *
 * Seed guidance rules (from CONTRIBUTING / CLAUDE.md / AGENTS.md) land in the
 * EXISTING repo-layer guidance catalogue (`.rennet/conventions.json`, the
 * convention-catalogue-reader's file) — written only when that file is absent,
 * never clobbering a user's catalogue. Cosmetics (the logo path) go to settings
 * only, never agent context.
 *
 * DETECTED-LAYER PERSISTENCE (reconciliation 3, recorded): scout facts persist
 * as `~/.rennet/projects/<esc>/scout.json` (project-store home pattern,
 * atomic write). `scoutSettingsOffers` reads them back as the `detected`-layer
 * offers for core's settings resolver — the locus precedent, made durable
 * because scout answers are not free to recompute at every resolve.
 */
import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type HarnessTurnResult, resolveTracker, type TrackerKind } from "@rennet/core";
import { renderProjectScoutPrompt } from "@rennet/prompts";
import type { GlobalConfig } from "@rennet/protocol";
import { z } from "zod";
import { CONVENTIONS_FILE } from "./convention-catalogue-reader";
import type { GitExec } from "./git-range-diff";
import type { ProjectSnapshotStore } from "./project-snapshot-store";
import type { MissingConfigFact, TrackerConfig } from "./related-context";
import { writeAtomic } from "./write-atomic";

export type ScoutProvenance = "detected" | "guessed";

/** One scouted answer: the value plus how it was found (detected vs guessed). */
export interface ScoutFact {
  readonly value: string;
  readonly provenance: ScoutProvenance;
  /** What produced it — a source string for the questionnaire's provenance render. */
  readonly source: string;
  /**
   * The repository the value is relative TO, for a fact whose value is a path (`logoPath`).
   * Recorded so a later re-copy resolves the file from the repo the scout actually read,
   * never from the project's open path — a workspace maps many repos to one identity, and
   * the project cannot say which one this came from (ADR 0004).
   */
  readonly repoRoot?: string;
}

/** The §4 detection set, keyed by the matching `SETTINGS_REGISTRY` row. */
export interface ScoutFacts {
  readonly trackerKind?: ScoutFact;
  readonly trackerProjectKey?: ScoutFact;
  readonly defaultBranch?: ScoutFact;
  readonly worktreeBaseDir?: ScoutFact;
  readonly gateCommand?: ScoutFact;
  readonly logoPath?: ScoutFact;
}

export interface ScoutResult {
  readonly facts: ScoutFacts;
  /** Guidance rules written into the catalogue (0 when skipped or none). */
  readonly guidanceSeeded: number;
  /** Why seeding did not write, when it did not. */
  readonly guidanceSkipped?: "existing-catalogue" | "no-rules" | "no-seat";
  /** Typed asks for B8 (reconciliation 7): never a modal, never a gate. */
  readonly missingConfig: MissingConfigFact[];
}

type RunTurn = (prompt: string, attempt: number) => Promise<HarnessTurnResult>;

export interface ProjectScoutProgress {
  readonly step: "remotes" | "config" | "guidance";
  readonly status: "running" | "done";
  readonly detail?: string;
}

export interface ProjectScoutDeps {
  readonly repoRoot: string;
  readonly git: GitExec;
  /** The branch already confirmed during project discovery, when available. */
  readonly knownDefaultBranch?: string;
  /** The `project-scout` council seat, resolved by the caller. Absent → deterministic only. */
  readonly runTurn?: RunTurn | null;
  /** Tracker endpoints already configured — silences the missing-config ask. */
  readonly trackerConfig?: TrackerConfig;
  /** Exact deterministic/model boundaries for the project-run timeline. */
  readonly onProgress?: (event: ProjectScoutProgress) => void;
  /**
   * The daemon's ONE session-context writer (`writeSessionContext`, bound to a root and
   * an id), injected because it lives in the server. It writes the files and returns the
   * directory; the scout turns that into the relative path its prompt names.
   *
   * Absent ⇒ no `scout-detected.json` and no line naming it. That is honest rather than
   * degraded: a detected value is never overwritten by the seat, so a seat that restates
   * one changes nothing.
   */
  readonly writeContext?: (files: readonly ScoutContextFile[]) => string;
}

/**
 * One context file, structurally identical to the server's `SessionContextFile` — the
 * adapter layer cannot import the server, and this is the whole contract.
 */
export interface ScoutContextFile {
  readonly name: string;
  readonly body: string;
  readonly holds: string;
  readonly readWhen: string;
}

const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9})-\d+\b/g;

/**
 * The paths determinism PREFERS, in order — the old fixed candidate list (#461 §4), kept as
 * the ranking floor. It is no longer the whole search: #900 walks the repo for candidates and
 * lets the seat judge, and this list decides which candidate is the deterministic best guess
 * when there is no seat to ask (or its pick does not survive validation).
 */
const LOGO_PREFERRED = [
  "logo.svg",
  "logo.png",
  "icon.svg",
  "icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  "docs/logo.svg",
  "docs/logo.png",
] as const;

/** The image formats a project mark may be — the same set `projectLogoMimeSchema` admits. */
const LOGO_EXTENSIONS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp"]);

/** A basename that names itself as a mark. `favicon` matches by prefix, the rest anywhere. */
const LOGO_BASENAME = /logo|icon|mark|brand|^favicon/i;

/** Directories a project's images conventionally live in: everything with an accepted
 *  extension under one of these is a candidate, whatever it is called. */
const LOGO_DIRS = new Set(["public", "assets", "static", ".github", "docs"]);

/** Never walked: build output, dependencies, and the vendored tree. */
const LOGO_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  ".next",
  ".turbo",
  ".nx",
]);

/** How deep the walk goes. Four levels reaches `public/images/brand/logo.svg` and stops. */
const LOGO_WALK_DEPTH = 4;

/** How many paths the inventory carries. The prompt caps again at its own interpolation. */
export const LOGO_INVENTORY_CAP = 20;

const GUIDANCE_DOCS = ["CONTRIBUTING.md", "CLAUDE.md", "AGENTS.md"] as const;

/**
 * The file the scout's detected facts are written to, inside the context directory
 * `writeContext` owns. The prompt names this path; it never carries the facts.
 */
export const SCOUT_DETECTED_FILE = "scout-detected.json";

/**
 * The fixed context id the scout writes under when it runs for a PROJECT and there is
 * no session yet (design D3/D4). A session-scoped caller passes its own session id to
 * its own `writeContext`; this adapter never chooses the id.
 */
/**
 * The PREFIX of a scout run's context directory id, not the id itself. Each run appends
 * something unique: the scout runs for a project, before any session exists, so a fixed id
 * is never a session id — every daemon start read it as an orphan, and two scouts on one
 * root raced purge-then-write over each other's files (review finding 5). The runtime owns
 * the suffix and purges the directory when its turn returns.
 */
export const PROJECT_SCOUT_CONTEXT_PREFIX = "project-scout";

function readIfPresent(root: string, rel: string, cap: number): string | undefined {
  try {
    return readFileSync(join(root, rel), "utf8").slice(0, cap);
  } catch {
    return undefined;
  }
}

async function tryGit(git: GitExec, root: string, args: string[]): Promise<string | undefined> {
  try {
    const text = (await git(root, args)).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/** github.com/owner/repo out of any common remote URL form, or undefined. */
function parseGithubRemote(url: string): { owner: string; name: string } | undefined {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url.trim());
  if (!match?.[1] || !match[2]) return undefined;
  return { owner: match[1], name: match[2] };
}

/** The most frequent JIRA-style prefix in `texts`, with its hit count. */
function dominantJiraPrefix(
  texts: readonly string[],
): { prefix: string; hits: number } | undefined {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const match of text.matchAll(JIRA_KEY)) {
      const prefix = match[1];
      if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  let best: { prefix: string; hits: number } | undefined;
  for (const [prefix, hits] of counts) {
    if (!best || hits > best.hits) best = { prefix, hits };
  }
  return best;
}

/** The logo candidates one repository offers, ranked, plus how many there were before the cap. */
export interface LogoInventory {
  /** Repo-relative paths, best guess first, at most {@link LOGO_INVENTORY_CAP} of them. */
  readonly paths: readonly string[];
  /** Every candidate the walk matched, so a truncated list can say how many it dropped. */
  readonly total: number;
}

/** Lower sorts first. The old fixed list keeps its exact order at the top; everything else
 *  ranks by format (svg beats raster), then by how loudly the name claims to be the mark,
 *  then by depth — a root `brand/logo.svg` before a `docs/guide/img/icon-warning.png`. */
function logoRank(path: string): number {
  const preferred = LOGO_PREFERRED.indexOf(path as (typeof LOGO_PREFERRED)[number]);
  if (preferred >= 0) return preferred;
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const svg = base.endsWith(".svg") ? 0 : 40;
  const named = /logo/.test(base) ? 0 : /mark|brand/.test(base) ? 4 : /icon/.test(base) ? 8 : 12;
  const depth = Math.min(path.split("/").length - 1, 8);
  return 100 + svg + named + depth;
}

/**
 * Walk the repository for files that could be its mark (#900): anything whose basename names
 * itself (`*logo*`, `*icon*`, `favicon*`, `*mark*`, `*brand*`) with an accepted extension,
 * plus anything with an accepted extension living where a project keeps its images. Bounded
 * on both axes — {@link LOGO_WALK_DEPTH} deep, skipping build output and dependencies — and
 * capped at {@link LOGO_INVENTORY_CAP} paths, because this list is interpolated into a prompt.
 *
 * Deterministic: the walk sorts every directory's entries, so the same tree always yields the
 * same inventory in the same order.
 */
export function logoInventory(repoRoot: string): LogoInventory {
  const matched: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth >= LOGO_WALK_DEPTH || LOGO_SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf(".");
      if (dot <= 0 || !LOGO_EXTENSIONS.has(entry.name.slice(dot).toLowerCase())) continue;
      // Either the file says what it is, or it sits where a project keeps its images.
      const topLevel = path.slice(0, Math.max(path.indexOf("/"), 0));
      if (!LOGO_BASENAME.test(entry.name) && !LOGO_DIRS.has(topLevel)) continue;
      matched.push(path);
    }
  };
  walk(repoRoot, "", 0);
  matched.sort((a, b) => logoRank(a) - logoRank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return { paths: matched.slice(0, LOGO_INVENTORY_CAP), total: matched.length };
}

/**
 * Accept a seat's `logoPath` answer, or refuse it. A model names a path; nothing guarantees
 * it exists, that it is a file, that it is an image, or that it is inside the repository at
 * all — a symlink out of the tree resolves anywhere the daemon can read. So: realpath both
 * sides, require containment, require a file, require an accepted extension. Returns the
 * repo-relative path (recomputed from the realpaths, so what comes back is what was checked).
 */
export function acceptLogoPick(repoRoot: string, pick: unknown): string | undefined {
  if (typeof pick !== "string" || pick.trim() === "") return undefined;
  try {
    const root = realpathSync(repoRoot);
    const target = realpathSync(resolve(root, pick.trim()));
    const relPath = relative(root, target);
    if (relPath === "" || relPath.startsWith("..") || isAbsolute(relPath)) return undefined;
    if (!statSync(target).isFile()) return undefined;
    const dot = target.lastIndexOf(".");
    if (dot <= 0 || !LOGO_EXTENSIONS.has(target.slice(dot).toLowerCase())) return undefined;
    return relPath.split(sep).join("/");
  } catch {
    return undefined;
  }
}

/** The deterministic best guess for one inventory, as a fact — or null for an empty repo. */
function deterministicLogoFact(repoRoot: string, inventory: LogoInventory): ScoutFact | null {
  const best = inventory.paths[0];
  if (best === undefined) return null;
  return { value: best, provenance: "detected", source: "file present", repoRoot };
}

/**
 * Detect ONE repository's mark on its own: inventory, then the seat's judgement over it.
 *
 * This is Identity's "Detect again" (#900). The full scout run does NOT call it — it folds
 * the same logo ask into its one existing turn rather than paying for a second — so the two
 * paths share the primitives ({@link logoInventory}, {@link acceptLogoPick}) instead of the
 * turn. `runTurn` absent, refused, or answering with a path that does not survive validation
 * all land on the same honest floor: the deterministic best guess, or null.
 */
export async function detectProjectLogo(deps: {
  readonly repoRoot: string;
  readonly runTurn?: RunTurn | null;
}): Promise<ScoutFact | null> {
  const inventory = logoInventory(deps.repoRoot);
  const fallback = deterministicLogoFact(deps.repoRoot, inventory);
  if (!deps.runTurn || inventory.total === 0) return fallback;
  try {
    const turn = await deps.runTurn(
      renderProjectScoutPrompt({
        gaps: ["logoPath"],
        guidanceDocs: [],
        logo: { candidates: inventory.paths, total: inventory.total },
      }),
      1,
    );
    const body = turn.status === "emitted" ? parseSeatBody(turn.body) : undefined;
    const picked = acceptLogoPick(deps.repoRoot, body?.facts?.logoPath);
    if (picked === undefined) return fallback;
    return { value: picked, provenance: "detected", source: "scout pick", repoRoot: deps.repoRoot };
  } catch {
    return fallback;
  }
}

/**
 * The zero-cost deterministic pass. Pure inspection of the working tree + git —
 * no network, no model, no writes. Explicit tracker markers (JIRA keys, a
 * linear.app link) outrank mere GitHub hosting for `trackerKind`: a repo hosted
 * on GitHub whose commits speak ABC-123 tracks in JIRA.
 */
export async function scoutDeterministic(
  deps: Pick<ProjectScoutDeps, "repoRoot" | "git" | "knownDefaultBranch" | "onProgress">,
): Promise<ScoutFacts> {
  const { repoRoot, git } = deps;
  const facts: Record<string, ScoutFact> = {};

  deps.onProgress?.({ step: "remotes", status: "running" });
  const remoteUrl = await tryGit(git, repoRoot, ["config", "--get", "remote.origin.url"]);
  const github = remoteUrl ? parseGithubRemote(remoteUrl) : undefined;
  deps.onProgress?.({
    step: "remotes",
    status: "done",
    detail: github ? `origin is ${github.owner}/${github.name}` : "no GitHub origin detected",
  });

  const knownDefaultBranch = deps.knownDefaultBranch?.trim();
  const remoteHead = knownDefaultBranch
    ? undefined
    : await tryGit(git, repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const defaultBranch = knownDefaultBranch || remoteHead?.replace(/^origin\//, "");
  if (defaultBranch) {
    facts.defaultBranch = {
      value: defaultBranch,
      provenance: "detected",
      source: knownDefaultBranch ? "confirmed during project discovery" : "origin/HEAD",
    };
  }

  deps.onProgress?.({ step: "config", status: "running" });
  const readme = readIfPresent(repoRoot, "README.md", 32_000) ?? "";
  const subjects = (await tryGit(git, repoRoot, ["log", "--format=%s", "-n", "50"])) ?? "";
  const markerTexts = [readme, subjects];
  const jira = dominantJiraPrefix(markerTexts);
  const linear = markerTexts.some((text) => text.includes("linear.app"));

  // Tracker-specific URL evidence outranks the key shape: `ABC-123` is the
  // generic shape BOTH trackers use, so a linear.app link decides Linear and
  // the dominant prefix classifies as the Linear project key.
  if (linear) {
    facts.trackerKind = { value: "linear", provenance: "detected", source: "linear.app link" };
    if (jira && jira.hits >= 2) {
      facts.trackerProjectKey = {
        value: jira.prefix,
        provenance: "detected",
        source: `${jira.hits}× ${jira.prefix}-… keys + linear.app link`,
      };
    }
  } else if (jira && jira.hits >= 2) {
    facts.trackerKind = {
      value: "jira",
      provenance: "detected",
      source: "JIRA keys in commits/README",
    };
    facts.trackerProjectKey = {
      value: jira.prefix,
      provenance: "detected",
      source: `${jira.hits}× ${jira.prefix}-… keys`,
    };
  } else if (github) {
    facts.trackerKind = {
      value: "github",
      provenance: "detected",
      source: `remote origin → ${github.owner}/${github.name}`,
    };
  }

  // Gate command from the package manifest: prefer `check`, else `test`; the
  // runner comes from the lockfile actually present.
  const manifest = readIfPresent(repoRoot, "package.json", 64_000);
  if (manifest) {
    try {
      const scripts = (JSON.parse(manifest) as { scripts?: Record<string, unknown> }).scripts ?? {};
      const script =
        typeof scripts.check === "string"
          ? "check"
          : typeof scripts.test === "string"
            ? "test"
            : undefined;
      if (script) {
        const runner = existsSync(join(repoRoot, "pnpm-lock.yaml"))
          ? "pnpm"
          : existsSync(join(repoRoot, "yarn.lock"))
            ? "yarn"
            : "npm run";
        facts.gateCommand = {
          value: `${runner} ${script}`,
          provenance: "detected",
          source: `package.json scripts.${script}`,
        };
      }
    } catch {
      // Malformed manifest: no gate-command detection, honestly absent.
    }
  }

  // The mark's deterministic floor (#900): the best-ranked candidate the walk found. The
  // seat is asked to judge the whole inventory on every run — this is what stands when
  // there is no seat, or when its answer does not survive validation.
  const logo = deterministicLogoFact(repoRoot, logoInventory(repoRoot));
  if (logo) facts.logoPath = logo;

  // Worktree base-dir convention: where this repo's OTHER worktrees already live.
  const worktrees = (await tryGit(git, repoRoot, ["worktree", "list", "--porcelain"])) ?? "";
  const roots = [...worktrees.matchAll(/^worktree (.+)$/gm)].map((match) => match[1] ?? "");
  const sibling = roots.find((root) => root.length > 0 && root !== repoRoot);
  if (sibling) {
    const base = sibling.slice(0, Math.max(sibling.lastIndexOf("/"), 0));
    if (base) {
      facts.worktreeBaseDir = { value: base, provenance: "detected", source: "git worktree list" };
    }
  }

  const detected = Object.keys(facts).length;
  deps.onProgress?.({
    step: "config",
    status: "done",
    detail: `${detected} ${detected === 1 ? "fact" : "facts"} detected`,
  });

  return facts as ScoutFacts;
}

/** The JSON shape the scout seat is constrained to. */
export const PROJECT_SCOUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    facts: {
      type: "object",
      additionalProperties: false,
      properties: {
        trackerKind: { type: "string", enum: ["github", "jira", "linear"] },
        trackerProjectKey: { type: "string" },
        defaultBranch: { type: "string" },
        worktreeBaseDir: { type: "string" },
        gateCommand: { type: "string" },
        logoPath: { type: "string" },
      },
    },
    guidanceRules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["convention", "rationale", "severity"],
        properties: {
          convention: { type: "string" },
          rationale: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          antiPattern: { type: "string" },
        },
      },
    },
  },
} as const;

interface SeatBody {
  readonly facts?: Partial<Record<keyof ScoutFacts, unknown>>;
  readonly guidanceRules?: readonly unknown[];
}

function parseSeatBody(body: unknown): SeatBody | undefined {
  if (typeof body === "string") {
    try {
      return parseSeatBody(JSON.parse(body));
    } catch {
      return undefined;
    }
  }
  if (typeof body !== "object" || body === null) return undefined;
  return body as SeatBody;
}

/** The tracker vocabulary, for reading a STORED value back safely (C18 group A). */
const TRACKER_KINDS: readonly TrackerKind[] = ["none", "github", "jira", "linear"];

const SCOUT_FACT_KEYS = [
  "trackerKind",
  "trackerProjectKey",
  "defaultBranch",
  "worktreeBaseDir",
  "gateCommand",
  "logoPath",
] as const;

const SCOUT_FALLBACKS: Record<
  Exclude<(typeof SCOUT_FACT_KEYS)[number], "trackerProjectKey">,
  { readonly value: string; readonly source: string }
> = {
  trackerKind: { value: "none", source: "no issue-tracker marker found" },
  defaultBranch: { value: "main", source: "no default-branch evidence found" },
  // EMPTY, not `~/.rennet/worktrees` (#812). This fact is the repository's own worktree
  // convention, read off `git worktree list`; naming Rennet's own directory as the guess
  // said the round works there, which it does not — it runs in the session's workspace.
  worktreeBaseDir: { value: "", source: "no worktree convention found" },
  gateCommand: { value: "", source: "no repository gate command found" },
  logoPath: { value: "", source: "no repository logo found" },
};

/**
 * Run the scout: deterministic pass, then the council seat fills only the gaps.
 * Re-runnable by construction — determinism recomputes, the seat never
 * overwrites a detected value, and guidance seeds only into an absent catalogue.
 */
export async function runProjectScout(deps: ProjectScoutDeps): Promise<ScoutResult> {
  const detected = await scoutDeterministic(deps);
  const facts: Record<string, ScoutFact> = { ...detected };

  deps.onProgress?.({ step: "guidance", status: "running" });
  // NAMED, never embedded (session-context-files): the seat runs with `cwd` at the repo
  // root, so it opens these itself. Reading them here to paste into the prompt cost 18.4 kB
  // on Rennet's own checkout, re-billed on every retry. `existsSync` decides only whether
  // there is anything for the seat to distil.
  const guidanceDocs = GUIDANCE_DOCS.filter((doc) => existsSync(join(deps.repoRoot, doc)));
  const cataloguePath = join(deps.repoRoot, CONVENTIONS_FILE);
  const catalogueAbsent = !existsSync(cataloguePath);

  // `logoPath` is NOT a gap key (#900). Every other fact has one right answer determinism
  // either found or did not; the mark is a judgement over what is there, so the seat is
  // asked for it on EVERY run and the deterministic best guess is only the floor it lands
  // on when the seat is absent or its pick does not survive validation.
  const gaps = SCOUT_FACT_KEYS.filter((key) => key !== "logoPath" && facts[key] === undefined);
  // The SECOND walk of this run — `scoutDeterministic` did one for its own best guess. It is
  // a depth-4 readdir sweep that skips dependencies and build output, so the duplicate costs
  // far less than threading a pre-computed inventory through the deterministic pass's public
  // signature, where it is not a dependency but a result.
  const inventory = logoInventory(deps.repoRoot);
  let guidanceSeeded = 0;
  let guidanceSkipped: ScoutResult["guidanceSkipped"];

  // A repository with a candidate now wants the seat even when nothing else does: this is
  // the run's one real cost change (#900). A re-scout of a fully-configured project with a
  // seeded catalogue used to spend nothing and now spends one turn, because the mark is a
  // judgement that has to be re-made when the repository's images change.
  const wantSeat =
    deps.runTurn &&
    (gaps.length > 0 || inventory.total > 0 || (catalogueAbsent && guidanceDocs.length > 0));
  if (!deps.runTurn) guidanceSkipped = "no-seat";

  if (wantSeat && deps.runTurn) {
    const contextDir = deps.writeContext?.([
      {
        name: SCOUT_DETECTED_FILE,
        body: JSON.stringify(detected),
        holds: "The facts the deterministic pass already found, each with its provenance.",
        readWhen: "before you answer, so you never restate a fact that is already known.",
      },
    ]);
    const detectedRef =
      contextDir === undefined
        ? undefined
        : join(relative(deps.repoRoot, contextDir), SCOUT_DETECTED_FILE);
    const prompt = renderProjectScoutPrompt({
      gaps: [...gaps, ...(inventory.total > 0 ? ["logoPath"] : [])],
      ...(detectedRef === undefined ? {} : { detectedRef }),
      guidanceDocs,
      ...(inventory.total > 0
        ? { logo: { candidates: inventory.paths, total: inventory.total } }
        : {}),
    });
    try {
      const turn = await deps.runTurn(prompt, 1);
      const body = turn.status === "emitted" ? parseSeatBody(turn.body) : undefined;
      if (body?.facts) {
        for (const key of gaps) {
          const value = body.facts[key];
          if (typeof value === "string" && value.trim().length > 0) {
            facts[key] = {
              value: value.trim(),
              provenance: "guessed",
              source: "project-scout seat",
            };
          }
        }
        // The mark is the one answer the seat may OVERWRITE, and the one it must earn: a
        // path it names is validated against the checkout (exists, is a file, is an image,
        // is inside the repo) before it displaces determinism's guess.
        const picked = acceptLogoPick(deps.repoRoot, body.facts.logoPath);
        if (picked !== undefined) {
          facts.logoPath = {
            value: picked,
            provenance: "detected",
            source: "scout pick",
            repoRoot: deps.repoRoot,
          };
        }
      }
      const rules = (body?.guidanceRules ?? []).filter(
        (rule) => typeof rule === "object" && rule !== null,
      );
      if (catalogueAbsent) {
        if (rules.length > 0) {
          writeAtomic(
            cataloguePath,
            `${JSON.stringify({ rules, source: "project-scout" }, null, 2)}\n`,
          );
          guidanceSeeded = rules.length;
        } else {
          guidanceSkipped = "no-rules";
        }
      } else {
        guidanceSkipped = "existing-catalogue";
      }
    } catch {
      // A failed seat leaves the deterministic floor standing — honest degrade.
      if (guidanceSkipped === undefined) guidanceSkipped = "no-rules";
    }
  } else if (!catalogueAbsent) {
    guidanceSkipped = "existing-catalogue";
  }
  deps.onProgress?.({
    step: "guidance",
    status: "done",
    detail: deps.runTurn
      ? "seat pointed at the repository guidance"
      : "deterministic evidence only",
  });

  // The questionnaire is total even with no harness. Empty cosmetic/config values
  // are honest guessed defaults with an explicit source, not invented detections.
  for (const [key, fallback] of Object.entries(SCOUT_FALLBACKS)) {
    if (facts[key] === undefined) {
      facts[key] = { ...fallback, provenance: "guessed" };
    }
  }

  // A JIRA/Linear tracker without endpoint config → the typed ask (rec 7).
  const missingConfig: MissingConfigFact[] = [];
  const kind = facts.trackerKind?.value;
  if (
    (kind === "jira" && !deps.trackerConfig?.jira) ||
    (kind === "linear" && !deps.trackerConfig?.linear)
  ) {
    missingConfig.push({
      tracker: kind as "jira" | "linear",
      prefix: facts.trackerProjectKey?.value ?? "",
      missing: "base-url-or-token-env",
      provenance: { source: "scout-detection", match: facts.trackerKind?.source ?? "scout" },
    });
  }

  return { facts: facts as ScoutFacts, guidanceSeeded, guidanceSkipped, missingConfig };
}

/** The persisted scout record: `~/.rennet/projects/<esc>/scout.json`. */
const SCOUT_FILE = "scout.json";

export function saveScoutFacts(
  store: ProjectSnapshotStore,
  repoKey: string,
  result: ScoutResult,
): void {
  writeAtomic(
    join(store.paths(repoKey).projectDir, SCOUT_FILE),
    `${JSON.stringify({ facts: result.facts, missingConfig: result.missingConfig }, null, 2)}\n`,
  );
}

/** Persisted state crosses a trust boundary on the way back in: parse, never
 * cast — a forged `provenance: "detected"` in a hand-edited file must not walk
 * into the settings ladder as anything but what the schema admits. */
const scoutFactSchema = z.object({
  value: z.string(),
  provenance: z.enum(["detected", "guessed"]),
  source: z.string(),
  /** Additive-optional, so every record written before #900 still parses. */
  repoRoot: z.string().optional(),
});
const scoutRecordSchema = z.object({
  facts: z
    .object({
      trackerKind: scoutFactSchema.optional(),
      trackerProjectKey: scoutFactSchema.optional(),
      defaultBranch: scoutFactSchema.optional(),
      worktreeBaseDir: scoutFactSchema.optional(),
      gateCommand: scoutFactSchema.optional(),
      logoPath: scoutFactSchema.optional(),
    })
    .default({}),
  missingConfig: z
    .array(
      z.object({
        tracker: z.enum(["jira", "linear", "unknown"]),
        prefix: z.string(),
        missing: z.enum(["tracker-kind", "base-url-or-token-env", "token-env-value"]),
        provenance: z.object({
          source: z.enum([
            "branch-name",
            "commit-message",
            "pr-title",
            "pr-body",
            "pr-comment",
            "scout-detection",
          ]),
          match: z.string(),
        }),
      }),
    )
    .default([]),
});

export function loadScoutFacts(
  store: ProjectSnapshotStore,
  repoKey: string,
): { facts: ScoutFacts; missingConfig: MissingConfigFact[] } | null {
  try {
    const parsed = scoutRecordSchema.safeParse(
      JSON.parse(readFileSync(join(store.paths(repoKey).projectDir, SCOUT_FILE), "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The keys whose detected value is a LADDER offer. `logoPath` is deliberately absent
 * (#900): the mark does not resolve off the detected path, it resolves off the copy in the
 * project dir (ADR 0004), so offering the path here was a row nothing read — a dead offer.
 * The fact itself is still stored and still shown in the questionnaire; it is the SOURCE the
 * copy is made from, not a settings value.
 */
const SCOUT_OFFER_KEYS = SCOUT_FACT_KEYS.filter((key) => key !== "logoPath");

/**
 * The stored scout facts as `detected`-layer offers for core's settings
 * resolver (the locus precedent, durable): only DETECTED facts are offered —
 * a guessed value renders in the questionnaire but does not enter the ladder
 * until the user confirms it (their answer is an ordinary settings write).
 */
export function scoutSettingsOffers(
  store: ProjectSnapshotStore,
  repoKey: string,
): Partial<Record<Exclude<(typeof SCOUT_FACT_KEYS)[number], "logoPath">, string>> & {
  trackerKind?: TrackerKind;
} {
  const stored = loadScoutFacts(store, repoKey);
  if (!stored) return {};
  const offers: Record<string, string> = {};
  for (const key of SCOUT_OFFER_KEYS) {
    const fact = stored.facts[key];
    if (fact && fact.provenance === "detected") offers[key] = fact.value;
  }
  return offers as ReturnType<typeof scoutSettingsOffers>;
}

/**
 * Resolve the retrieval-facing `TrackerConfig` off the settings ladder: the
 * scout's detected offers under the user's global-rung answers, under the
 * PROJECT's own repo-rung answers, folded through core's resolver (one
 * precedence law, no side computation). `undefined` when the resolved kind
 * needs no endpoint (`none`/`github`) or the endpoint is incomplete — seen
 * tracker keys then surface as missing-config facts, and retrieval proceeds
 * (never a gate).
 *
 * The REPO rung (C18 group A) is what makes a per-project tracker real: before
 * it, the settings surface could only ever write the host's global answer, so
 * two projects on one machine could not point at different trackers and a
 * "per-project" tracker control would have been a lie. The offers are read from
 * the project's own `config.json` — the same repo rung `visibility` uses — and
 * a project that has set nothing offers nothing, so retrieval resolves exactly
 * as it did before.
 */
export function resolveTrackerConfig(
  store: ProjectSnapshotStore,
  repoKey: string,
  global: GlobalConfig,
): TrackerConfig | undefined {
  const detected = scoutSettingsOffers(store, repoKey);
  const rung = global.tracker ?? {};
  // A MALFORMED project config reads as no config (`loadConfig` is fail-safe), so a
  // corrupt file never leaks an unparseable override into retrieval.
  const repo = store.loadConfig(repoKey)?.tracker ?? {};
  const offer = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === "" ? undefined : value.trim();
  // ONE law for the whole section (`resolveTracker`), shared with the settings
  // surface: an endpoint field offered BELOW the layer that set the kind belongs to a
  // different provider and is masked out, so a per-project JIRA can never be called
  // with the host's Linear credentials.
  const resolved = resolveTracker({
    kind: {
      detected: detected.trackerKind,
      global: TRACKER_KINDS.includes(rung.kind as TrackerKind)
        ? (rung.kind as TrackerKind)
        : undefined,
      // The stored repo answer rides the SAME validator the write used; an
      // out-of-vocabulary value is dropped rather than thrown into resolution.
      repo: TRACKER_KINDS.includes(repo.kind as TrackerKind)
        ? (repo.kind as TrackerKind)
        : undefined,
    },
    projectKey: {
      detected: detected.trackerProjectKey,
      global: offer(rung.projectKey),
      repo: offer(repo.projectKey),
    },
    baseUrl: { global: offer(rung.baseUrl), repo: offer(repo.baseUrl) },
    tokenEnv: { global: offer(rung.tokenEnv), repo: offer(repo.tokenEnv) },
  });
  const kind = resolved.kind.value;
  if (kind !== "jira" && kind !== "linear") return undefined;
  const baseUrl = resolved.baseUrl.value;
  const tokenEnvVar = resolved.tokenEnv.value;
  if (baseUrl === "" || tokenEnvVar === "") return undefined;
  const projectKey = resolved.projectKey.value;
  const endpoint = {
    baseUrl,
    tokenEnvVar,
    ...(projectKey === "" ? {} : { projectPrefixes: [projectKey] }),
  };
  return kind === "jira" ? { jira: endpoint } : { linear: endpoint };
}
