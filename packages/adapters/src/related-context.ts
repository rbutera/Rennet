/**
 * Related-context retrieval (#461, B7).
 *
 * Cluster 2 slice: deterministic ref extraction (zero cost, pure string logic
 * over branch name / commit messages / PR title / PR body) and the injected
 * `gh` runner the fetchers ride — `gh` holds its own token; Rennet never reads
 * or stores a credential on this path (#483 reversal: gh first-class here).
 */

// ---------------------------------------------------------------------------
// Deterministic ref extraction (task 2.1)
// ---------------------------------------------------------------------------

/** Where a ref was found — feeds dossier `provenance` verbatim. */
export type RefSource = "branch-name" | "commit-message" | "pr-title" | "pr-body";

export interface RefProvenance {
  source: RefSource;
  /** The exact substring that matched, for honest display and debugging. */
  match: string;
}

/** A GitHub issue/PR reference: bare `#123`, `owner/repo#123`, or a full URL. */
export interface GithubRef {
  kind: "github";
  /** Absent for bare `#123` — the caller resolves against the review's repo. */
  repo?: { owner: string; name: string };
  number: number;
  provenance: RefProvenance;
}

/**
 * A `ABC-123`-shaped tracker key. `tracker` is decided by configured prefixes;
 * an unconfigured-but-plausible prefix stays `unknown` so cluster 3 can emit a
 * `missingConfig` fact instead of guessing an endpoint.
 */
export interface TrackerKeyRef {
  kind: "tracker-key";
  key: string;
  prefix: string;
  tracker: "jira" | "linear" | "unknown";
  provenance: RefProvenance;
}

export type ExtractedRef = GithubRef | TrackerKeyRef;

export interface ExtractRefsInput {
  branchName?: string;
  commitMessages?: readonly string[];
  prTitle?: string;
  prBody?: string;
}

export interface ExtractRefsOptions {
  /** Project prefixes configured (or scout-detected) as JIRA. Case-insensitive. */
  jiraPrefixes?: readonly string[];
  /** Project prefixes configured (or scout-detected) as Linear. Case-insensitive. */
  linearPrefixes?: readonly string[];
}

const GITHUB_URL_REF = /github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/g;
const OWNER_REPO_REF = /(?<![\w./])([\w.-]+)\/([\w.-]+)#(\d+)/g;
const BARE_HASH_REF = /(?<![\w/])#(\d+)\b/g;
const TRACKER_KEY = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;

function* sources(input: ExtractRefsInput): Generator<[RefSource, string]> {
  if (input.branchName) yield ["branch-name", input.branchName];
  for (const message of input.commitMessages ?? []) yield ["commit-message", message];
  if (input.prTitle) yield ["pr-title", input.prTitle];
  if (input.prBody) yield ["pr-body", input.prBody];
}

/**
 * Deterministic pass: every GitHub ref, plus tracker keys gated on a configured
 * prefix or plausibility (an unconfigured prefix must appear at least twice
 * across the sources before it is believed — a lone `UTF-8`-shaped token is
 * noise, a repeated `PROJ-…` is a project key). Dedup keeps first-seen
 * provenance; source order is the argument order above.
 */
export function extractRefs(
  input: ExtractRefsInput,
  options: ExtractRefsOptions = {},
): ExtractedRef[] {
  const jira = new Set((options.jiraPrefixes ?? []).map((p) => p.toUpperCase()));
  const linear = new Set((options.linearPrefixes ?? []).map((p) => p.toUpperCase()));

  const github = new Map<string, GithubRef>();
  const keys = new Map<string, TrackerKeyRef>();
  const prefixCounts = new Map<string, number>();

  for (const [source, text] of sources(input)) {
    for (const pattern of [GITHUB_URL_REF, OWNER_REPO_REF]) {
      for (const match of text.matchAll(pattern)) {
        const whole = match[0];
        const owner = match[1] ?? "";
        const name = match[2] ?? "";
        const number = Number(match[3]);
        const id = `${owner}/${name}#${number}`.toLowerCase();
        if (!github.has(id)) {
          github.set(id, {
            kind: "github",
            repo: { owner, name },
            number,
            provenance: { source, match: whole },
          });
        }
      }
    }
    for (const match of text.matchAll(BARE_HASH_REF)) {
      const whole = match[0];
      const number = Number(match[1]);
      const id = `#${number}`;
      if (!github.has(id)) {
        github.set(id, {
          kind: "github",
          number,
          provenance: { source, match: whole },
        });
      }
    }
    for (const match of text.matchAll(TRACKER_KEY)) {
      const whole = match[0];
      const upper = (match[1] ?? "").toUpperCase();
      prefixCounts.set(upper, (prefixCounts.get(upper) ?? 0) + 1);
      if (!keys.has(whole)) {
        keys.set(whole, {
          kind: "tracker-key",
          key: whole,
          prefix: upper,
          tracker: jira.has(upper) ? "jira" : linear.has(upper) ? "linear" : "unknown",
          provenance: { source, match: whole },
        });
      }
    }
  }

  // ponytail: repeat-count plausibility for unconfigured prefixes; tighten to a
  // scout-detected prefix list if real-world noise shows up.
  const plausible = [...keys.values()].filter(
    (ref) => ref.tracker !== "unknown" || (prefixCounts.get(ref.prefix) ?? 0) >= 2,
  );
  return [...github.values(), ...plausible];
}
