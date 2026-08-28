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
 * as `~/.rennet/projects/<esc>/scout.json` (knowledge-store home pattern,
 * atomic write). `scoutSettingsOffers` reads them back as the `detected`-layer
 * offers for core's settings resolver — the locus precedent, made durable
 * because scout answers are not free to recompute at every resolve.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type HarnessTurnResult, resolveTracker, type TrackerKind } from "@rennet/core";
import type { GlobalConfig } from "@rennet/protocol";
import { z } from "zod";
import { CONVENTIONS_FILE } from "./convention-catalogue-reader";
import type { GitExec } from "./git-range-diff";
import { writeAtomic } from "./knowledge-store";
import type { ProjectSnapshotStore } from "./project-snapshot-store";
import type { MissingConfigFact, TrackerConfig } from "./related-context";

export type ScoutProvenance = "detected" | "guessed";

/** One scouted answer: the value plus how it was found (detected vs guessed). */
export interface ScoutFact {
  readonly value: string;
  readonly provenance: ScoutProvenance;
  /** What produced it — a source string for the questionnaire's provenance render. */
  readonly source: string;
}

/** The §4 detection set, keyed by the matching `SETTINGS_REGISTRY` row. */
export interface ScoutFacts {
  readonly trackerKind?: ScoutFact;
  readonly trackerProjectKey?: ScoutFact;
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

export interface ProjectScoutDeps {
  readonly repoRoot: string;
  readonly git: GitExec;
  /** The `project-scout` council seat, resolved by the caller. Absent → deterministic only. */
  readonly runTurn?: RunTurn | null;
  /** Tracker endpoints already configured — silences the missing-config ask. */
  readonly trackerConfig?: TrackerConfig;
}

const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9})-\d+\b/g;
/** Logo candidates, checked in order — a fixed list, not a crawl. */
const LOGO_CANDIDATES = [
  "logo.svg",
  "logo.png",
  "icon.svg",
  "icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  "docs/logo.svg",
  "docs/logo.png",
] as const;
const GUIDANCE_DOCS = ["CONTRIBUTING.md", "CLAUDE.md", "AGENTS.md"] as const;
/** Per-document cap fed to the seat — guidance files, not books. */
const GUIDANCE_DOC_CAP = 8_000;

function readIfPresent(root: string, rel: string, cap = GUIDANCE_DOC_CAP): string | undefined {
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

/**
 * The zero-cost deterministic pass. Pure inspection of the working tree + git —
 * no network, no model, no writes. Explicit tracker markers (JIRA keys, a
 * linear.app link) outrank mere GitHub hosting for `trackerKind`: a repo hosted
 * on GitHub whose commits speak ABC-123 tracks in JIRA.
 */
export async function scoutDeterministic(
  deps: Pick<ProjectScoutDeps, "repoRoot" | "git">,
): Promise<ScoutFacts> {
  const { repoRoot, git } = deps;
  const facts: Record<string, ScoutFact> = {};

  const remoteUrl = await tryGit(git, repoRoot, ["config", "--get", "remote.origin.url"]);
  const github = remoteUrl ? parseGithubRemote(remoteUrl) : undefined;

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

  const logo = LOGO_CANDIDATES.find((candidate) => existsSync(join(repoRoot, candidate)));
  if (logo) facts.logoPath = { value: logo, provenance: "detected", source: "file present" };

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
  "worktreeBaseDir",
  "gateCommand",
  "logoPath",
] as const;

/**
 * Run the scout: deterministic pass, then the council seat fills only the gaps.
 * Re-runnable by construction — determinism recomputes, the seat never
 * overwrites a detected value, and guidance seeds only into an absent catalogue.
 */
export async function runProjectScout(deps: ProjectScoutDeps): Promise<ScoutResult> {
  const detected = await scoutDeterministic(deps);
  const facts: Record<string, ScoutFact> = { ...detected };

  const guidanceTexts = GUIDANCE_DOCS.map((doc): { doc: string; text: string | undefined } => ({
    doc,
    text: readIfPresent(deps.repoRoot, doc),
  })).filter((entry): entry is { doc: string; text: string } => entry.text !== undefined);
  const cataloguePath = join(deps.repoRoot, CONVENTIONS_FILE);
  const catalogueAbsent = !existsSync(cataloguePath);

  const gaps = SCOUT_FACT_KEYS.filter((key) => facts[key] === undefined);
  let guidanceSeeded = 0;
  let guidanceSkipped: ScoutResult["guidanceSkipped"];

  const wantSeat =
    deps.runTurn && (gaps.length > 0 || (catalogueAbsent && guidanceTexts.length > 0));
  if (!deps.runTurn) guidanceSkipped = "no-seat";

  if (wantSeat && deps.runTurn) {
    const prompt = [
      "You are the project scout. From the repository evidence below, fill ONLY",
      `these unknown facts: ${gaps.join(", ") || "(none — guidance only)"}.`,
      "Omit any fact you cannot ground in the evidence. Also distill the guidance",
      "documents into convention rules (convention, rationale, severity high|medium|low,",
      "optional antiPattern). Return JSON per the schema.",
      "",
      `Known (do not restate): ${JSON.stringify(detected)}`,
      ...guidanceTexts.map(
        (entry) => `\n--- ${entry.doc} (untrusted repo guidance) ---\n${entry.text}`,
      ),
    ].join("\n");
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
});
const scoutRecordSchema = z.object({
  facts: z
    .object({
      trackerKind: scoutFactSchema.optional(),
      trackerProjectKey: scoutFactSchema.optional(),
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
 * The stored scout facts as `detected`-layer offers for core's settings
 * resolver (the locus precedent, durable): only DETECTED facts are offered —
 * a guessed value renders in the questionnaire but does not enter the ladder
 * until the user confirms it (their answer is an ordinary settings write).
 */
export function scoutSettingsOffers(
  store: ProjectSnapshotStore,
  repoKey: string,
): Partial<Record<(typeof SCOUT_FACT_KEYS)[number], string>> & { trackerKind?: TrackerKind } {
  const stored = loadScoutFacts(store, repoKey);
  if (!stored) return {};
  const offers: Record<string, string> = {};
  for (const key of SCOUT_FACT_KEYS) {
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
