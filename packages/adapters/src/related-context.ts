/**
 * Related-context retrieval (#461, B7).
 *
 * Deterministic ref extraction (zero cost, pure string logic over branch name /
 * commit messages / PR title / PR body), the injected `gh` runner the fetchers
 * ride — `gh` holds its own token; Rennet never reads or stores a credential on
 * this path (#483 reversal: gh first-class here) — and the retrieval flow:
 * extraction → fetch (gh / configured tracker REST) → one deterministic hop →
 * light-tier council enrichment → the bounded dossier (`DossierItem[]`).
 */
import { absentBudgetGrant, type HarnessTurnResult } from "@rennet/core";
import type { DossierItem, InvocationBudget } from "@rennet/protocol";
import { DOSSIER_BODY_MAX_CHARS, dossierItemSchema } from "@rennet/protocol";
import { execa } from "execa";
import { GITHUB_REQUEST_TIMEOUT_MS } from "./github-fetch";

// ---------------------------------------------------------------------------
// Deterministic ref extraction (task 2.1)
// ---------------------------------------------------------------------------

/** Where a ref was found — feeds dossier `provenance` verbatim. `scout-detection`
 * is the project scout's marker pass (README + commit subjects, B7 cluster 4). */
export type RefSource =
  | "branch-name"
  | "commit-message"
  | "pr-title"
  | "pr-body"
  | "scout-detection";

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
 * prefix or plausibility. An unconfigured prefix from a HIGH-SIGNAL source
 * (branch name, PR title — someone typed the key into the change's identity)
 * is believed on a single occurrence; in low-signal prose (commit bodies, PR
 * body) it must appear at least twice — a lone `UTF-8`-shaped token is noise,
 * a repeated `PROJ-…` is a project key. Dedup keeps first-seen provenance;
 * source order is the argument order above.
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

  // ponytail: repeat-count plausibility for unconfigured low-signal prefixes;
  // tighten to a scout-detected prefix list if real-world noise shows up.
  const highSignal = new Set<RefSource>(["branch-name", "pr-title"]);
  const plausible = [...keys.values()].filter(
    (ref) =>
      ref.tracker !== "unknown" ||
      highSignal.has(ref.provenance.source) ||
      (prefixCounts.get(ref.prefix) ?? 0) >= 2,
  );
  return [...github.values(), ...plausible];
}

// ---------------------------------------------------------------------------
// The gh runner port + fetchers (task 2.2)
// ---------------------------------------------------------------------------

/**
 * A narrow `gh` runner, injected so retrieval is testable without spawning a
 * process (the `GitExec` pattern). Rejects on non-zero exit or timeout.
 */
export type GhRunner = (args: string[]) => Promise<string>;

/** The real runner: `gh` in `repoRoot`, bounded by the GitHub request deadline. */
export function execaGhFor(repoRoot: string, timeoutMs = GITHUB_REQUEST_TIMEOUT_MS): GhRunner {
  return async (args) => {
    const result = await execa("gh", args, {
      cwd: repoRoot,
      shell: false,
      timeout: timeoutMs,
    });
    return result.stdout;
  };
}

export interface FetchedIssue {
  repo: { owner: string; name: string };
  number: number;
  title: string;
  /** The tracker's own state label, verbatim (`open` / `closed`). */
  state: string;
  body: string;
  /** Comment bodies, thread order. */
  comments: string[];
  url: string;
}

export interface FetchedPr {
  number: number;
  title: string;
  body: string;
  comments: string[];
}

/**
 * One fetch's outcome. A failed ref is a typed fact the flow reports — never a
 * crash, never a silent absence.
 */
export type RefFetchResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: "not-found" | "unreachable" | "invalid"; detail: string };

function failureOf(cause: unknown): { error: "not-found" | "unreachable"; detail: string } {
  const text =
    cause instanceof Error
      ? `${cause.message}\n${(cause as { stderr?: string }).stderr ?? ""}`
      : String(cause);
  const timedOut = (cause as { timedOut?: boolean }).timedOut === true;
  if (!timedOut && /\b404\b|Not Found|Could not resolve/i.test(text)) {
    return { error: "not-found", detail: text.trim().slice(0, 500) };
  }
  return { error: "unreachable", detail: text.trim().slice(0, 500) };
}

/** `gh api` fetch of one issue (or PR-as-issue) plus its comment thread. */
export async function fetchGithubIssue(
  gh: GhRunner,
  repo: { owner: string; name: string },
  number: number,
): Promise<RefFetchResult<FetchedIssue>> {
  const base = `repos/${repo.owner}/${repo.name}/issues/${number}`;
  let issueRaw: string;
  let commentsRaw: string;
  try {
    issueRaw = await gh(["api", base]);
    commentsRaw = await gh(["api", `${base}/comments`, "--paginate"]);
  } catch (cause) {
    return { ok: false, ...failureOf(cause) };
  }
  try {
    const issue = JSON.parse(issueRaw) as {
      title?: string;
      state?: string;
      body?: string | null;
      html_url?: string;
    };
    const comments = JSON.parse(commentsRaw) as { body?: string | null }[];
    if (typeof issue.title !== "string" || typeof issue.state !== "string") {
      return { ok: false, error: "invalid", detail: `unexpected issue payload for ${base}` };
    }
    return {
      ok: true,
      value: {
        repo,
        number,
        title: issue.title,
        state: issue.state,
        body: issue.body ?? "",
        comments: comments.map((c) => c.body ?? ""),
        url: issue.html_url ?? `https://github.com/${repo.owner}/${repo.name}/issues/${number}`,
      },
    };
  } catch (cause) {
    return {
      ok: false,
      error: "invalid",
      detail: `unparseable gh payload for ${base}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/** `gh pr view --json` — the PR's own description + comments, extraction input. */
export async function fetchPrView(
  gh: GhRunner,
  number: number,
): Promise<RefFetchResult<FetchedPr>> {
  let raw: string;
  try {
    raw = await gh(["pr", "view", String(number), "--json", "number,title,body,comments"]);
  } catch (cause) {
    return { ok: false, ...failureOf(cause) };
  }
  try {
    const pr = JSON.parse(raw) as {
      number?: number;
      title?: string;
      body?: string | null;
      comments?: { body?: string | null }[];
    };
    if (typeof pr.title !== "string") {
      return { ok: false, error: "invalid", detail: `unexpected pr payload for #${number}` };
    }
    return {
      ok: true,
      value: {
        number: pr.number ?? number,
        title: pr.title,
        body: pr.body ?? "",
        comments: (pr.comments ?? []).map((c) => c.body ?? ""),
      },
    };
  } catch (cause) {
    return {
      ok: false,
      error: "invalid",
      detail: `unparseable gh pr payload for #${number}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// The retrieval flow (task 3.1): extraction → fetch → one hop → enrich → dossier
// ---------------------------------------------------------------------------

/** One tracker's config off the #476 ladder. The token itself is NEVER stored —
 * only the env var NAME travels; the value is read from `process.env` at call time. */
export interface TrackerEndpointConfig {
  readonly baseUrl: string;
  readonly tokenEnvVar: string;
  /** The project key prefixes that route to THIS endpoint (e.g. `["PROJ"]`,
   * from the `trackerProjectKey` settings row / scout detection). A key whose
   * prefix matches no configured endpoint stays `unknown` and surfaces as a
   * missing-config fact — endpoints never claim keys by mere existence. */
  readonly projectPrefixes?: readonly string[];
}

export interface TrackerConfig {
  readonly jira?: TrackerEndpointConfig;
  readonly linear?: TrackerEndpointConfig;
}

/**
 * A typed missing-config fact (reconciliation 7): a ref was SEEN for a tracker
 * that is not (fully) configured. Retrieval proceeds without it; the orchestrator
 * (B8) turns these into the persistent in-chat ask — never a modal, never a gate.
 */
export interface MissingConfigFact {
  readonly tracker: "jira" | "linear" | "unknown";
  readonly prefix: string;
  readonly missing: "tracker-kind" | "base-url-or-token-env" | "token-env-value";
  readonly provenance: RefProvenance;
}

/** A fetched raw payload, stored durably beside the dossier (depth on demand —
 * raw threads live behind the context tool, never in the dossier). */
export interface RawContextPayload {
  readonly id: string;
  readonly tracker: string;
  readonly payload: unknown;
}

/** A per-ref fetch failure, reported as a fact — never a crash, never silent. */
export interface RefFailure {
  readonly id: string;
  readonly error: "not-found" | "unreachable" | "invalid";
  readonly detail: string;
}

/** The REST seam for configured JIRA/Linear fetches — injected so tests never
 * hit the network. Resolves with the parsed JSON body or rejects. */
export type JsonFetcher = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
) => Promise<unknown>;

type RunTurn = (prompt: string, attempt: number) => Promise<HarnessTurnResult>;

export interface RetrieveRelatedContextDeps {
  readonly gh: GhRunner;
  /**
   * The review's own repo — resolves bare `#123` refs. Absent (a local capture
   * with no known forge repo), a bare ref is a typed failure; qualified
   * `owner/repo#123` and URL refs still resolve.
   */
  readonly repo?: { owner: string; name: string };
  readonly trackerConfig?: TrackerConfig;
  /** REST seam for JIRA/Linear. Default: global `fetch` returning parsed JSON. */
  readonly fetchJson?: JsonFetcher;
  /**
   * The `related-context-retrieval` council seat (B6-pattern injected turn),
   * already resolved by the caller. Absent → deterministic dossier only.
   */
  readonly runTurn?: RunTurn | null;
  /** Budget-normal path: metered and reported, never a refusal (Rule Zero). */
  readonly budget?: InvocationBudget;
  readonly now?: () => Date;
}

export interface EnrichmentReport {
  readonly status: "ran" | "skipped" | "failed";
  readonly reason?: string;
  /** Whether the shared budget had headroom; the turn runs either way. */
  readonly budgetGranted?: boolean;
  readonly overage?: boolean;
}

export interface RelatedContextResult {
  /** The bounded dossier — every item through `dossierItemSchema`. */
  readonly items: DossierItem[];
  /** Full fetched payloads for the durable store (context-tool depth). */
  readonly raw: RawContextPayload[];
  readonly missingConfig: MissingConfigFact[];
  readonly failures: RefFailure[];
  readonly enrichment: EnrichmentReport;
}

/** The JSON output schema the enrichment turn is constrained to. */
export const RELATED_CONTEXT_ENRICH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "keep"],
        properties: {
          id: { type: "string" },
          keep: { type: "boolean" },
          body: { type: "string" },
          acceptanceCriteria: { type: "string" },
        },
      },
    },
  },
} as const;

const defaultFetchJson: JsonFetcher = async (url, init) => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${init.method} ${url} → ${response.status}`);
  return response.json();
};

function githubId(repo: { owner: string; name: string }, number: number): string {
  return `github:${repo.owner}/${repo.name}#${number}`;
}

/** Truncate a body to the dossier bound; the caller records truncation in provenance. */
function boundedBody(text: string): { body: string; truncated: boolean } {
  if (text.length <= DOSSIER_BODY_MAX_CHARS) return { body: text, truncated: false };
  return { body: text.slice(0, DOSSIER_BODY_MAX_CHARS), truncated: true };
}

function issueToItem(
  issue: FetchedIssue,
  provenance: string,
  fetchedAt: string,
): { item: DossierItem; raw: RawContextPayload } {
  const id = githubId(issue.repo, issue.number);
  const { body, truncated } = boundedBody(
    [issue.body, ...issue.comments].filter(Boolean).join("\n\n---\n\n"),
  );
  return {
    item: dossierItemSchema.parse({
      id,
      tracker: "github",
      title: issue.title,
      state: issue.state,
      body,
      url: issue.url,
      provenance: truncated ? `${provenance}; truncated at fetch edge` : provenance,
      fetchedAt,
    }),
    raw: { id, tracker: "github", payload: issue },
  };
}

interface TrackerFetchOutcome {
  item?: DossierItem;
  raw?: RawContextPayload;
  failure?: RefFailure;
  missing?: MissingConfigFact;
  /** The fetched body text, un-truncated — link-hop extraction input. */
  hopText?: string;
}

/** Fetch one JIRA issue via configured REST (`/rest/api/2/issue/<key>`). */
async function fetchJiraKey(
  ref: TrackerKeyRef,
  config: TrackerEndpointConfig,
  fetchJson: JsonFetcher,
  fetchedAt: string,
): Promise<TrackerFetchOutcome> {
  const token = process.env[config.tokenEnvVar];
  if (!token) {
    return {
      missing: {
        tracker: "jira",
        prefix: ref.prefix,
        missing: "token-env-value",
        provenance: ref.provenance,
      },
    };
  }
  const id = `jira:${ref.key}`;
  const base = config.baseUrl.replace(/\/+$/, "");
  const url = `${base}/rest/api/2/issue/${ref.key}?fields=summary,status,description`;
  try {
    const payload = (await fetchJson(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    })) as {
      fields?: { summary?: string; status?: { name?: string }; description?: string | null };
    };
    const fields = payload.fields ?? {};
    const { body, truncated } = boundedBody(fields.description ?? "");
    return {
      item: dossierItemSchema.parse({
        id,
        tracker: "jira",
        title: fields.summary ?? ref.key,
        state: fields.status?.name ?? "unknown",
        body,
        url: `${base}/browse/${ref.key}`,
        provenance: truncated
          ? `${ref.provenance.source}; truncated at fetch edge`
          : ref.provenance.source,
        fetchedAt,
      }),
      raw: { id, tracker: "jira", payload },
      hopText: fields.description ?? "",
    };
  } catch (cause) {
    return {
      failure: {
        id,
        ...failureOf(cause),
      },
    };
  }
}

/** Fetch one Linear issue via configured GraphQL REST endpoint. */
async function fetchLinearKey(
  ref: TrackerKeyRef,
  config: TrackerEndpointConfig,
  fetchJson: JsonFetcher,
  fetchedAt: string,
): Promise<TrackerFetchOutcome> {
  const token = process.env[config.tokenEnvVar];
  if (!token) {
    return {
      missing: {
        tracker: "linear",
        prefix: ref.prefix,
        missing: "token-env-value",
        provenance: ref.provenance,
      },
    };
  }
  const id = `linear:${ref.key}`;
  try {
    const payload = (await fetchJson(config.baseUrl, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "query($id: String!) { issue(id: $id) { title description url state { name } } }",
        variables: { id: ref.key },
      }),
    })) as {
      data?: {
        issue?: {
          title?: string;
          description?: string | null;
          url?: string;
          state?: { name?: string };
        };
      };
    };
    const issue = payload.data?.issue;
    if (!issue)
      return { failure: { id, error: "not-found", detail: `no Linear issue ${ref.key}` } };
    const { body, truncated } = boundedBody(issue.description ?? "");
    return {
      item: dossierItemSchema.parse({
        id,
        tracker: "linear",
        title: issue.title ?? ref.key,
        state: issue.state?.name ?? "unknown",
        body,
        url: issue.url ?? config.baseUrl,
        provenance: truncated
          ? `${ref.provenance.source}; truncated at fetch edge`
          : ref.provenance.source,
        fetchedAt,
      }),
      raw: { id, tracker: "linear", payload },
      hopText: issue.description ?? "",
    };
  } catch (cause) {
    return { failure: { id, ...failureOf(cause) } };
  }
}

/** The enrichment turn's parsed body shape. */
interface EnrichTrim {
  id: string;
  keep: boolean;
  body?: string;
  acceptanceCriteria?: string;
}

function parseEnrichBody(body: unknown): EnrichTrim[] | null {
  if (typeof body !== "object" || body === null) return null;
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const trims: EnrichTrim[] = [];
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) return null;
    const { id, keep, body: text, acceptanceCriteria } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof keep !== "boolean") return null;
    trims.push({
      id,
      keep,
      ...(typeof text === "string" ? { body: text } : {}),
      ...(typeof acceptanceCriteria === "string" ? { acceptanceCriteria } : {}),
    });
  }
  return trims;
}

/**
 * The #461 retrieval flow: deterministic extraction → fetch every ref (gh for
 * GitHub; configured REST for JIRA/Linear; unconfigured trackers become typed
 * `missingConfig` facts and retrieval proceeds) → ONE deterministic link hop
 * over fetched GitHub bodies → the light-tier council seat trims for relevance
 * and lifts acceptance criteria. The deterministic dossier is the floor: a
 * failed or absent enrichment turn leaves it standing, reported honestly.
 *
 * Budget-normal path: the injected `InvocationBudget` is METERED and REPORTED,
 * never a refusal (Rule Zero; only the #460 map path is uncapped by design).
 */
export async function retrieveRelatedContext(
  input: ExtractRefsInput,
  deps: RetrieveRelatedContextDeps,
): Promise<RelatedContextResult> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const fetchedAt = (deps.now?.() ?? new Date()).toISOString();
  const config = deps.trackerConfig ?? {};
  // Tracker kinds come from configuration, not guessing: a key routes to the
  // endpoint whose configured prefixes claim it; everything else stays
  // `unknown` and surfaces as a missing-config fact.
  const options: ExtractRefsOptions = {
    jiraPrefixes: config.jira?.projectPrefixes ?? [],
    linearPrefixes: config.linear?.projectPrefixes ?? [],
  };
  const refs = extractRefs(input, options);

  const items = new Map<string, DossierItem>();
  const raw: RawContextPayload[] = [];
  const failures: RefFailure[] = [];
  const missingConfig: MissingConfigFact[] = [];

  const fetchedGithub = new Set<string>();
  const fetchGithub = async (ref: GithubRef, provenance: string): Promise<string[]> => {
    const repo = ref.repo ?? deps.repo;
    if (!repo) {
      failures.push({
        id: `#${ref.number}`,
        error: "invalid",
        detail: "bare ref with no known repo (no PR target and no configured forge repo)",
      });
      return [];
    }
    const key = `${repo.owner}/${repo.name}#${ref.number}`.toLowerCase();
    if (fetchedGithub.has(key)) return [];
    fetchedGithub.add(key);
    const result = await fetchGithubIssue(deps.gh, repo, ref.number);
    if (!result.ok) {
      failures.push({ id: githubId(repo, ref.number), error: result.error, detail: result.detail });
      return [];
    }
    const { item, raw: payload } = issueToItem(result.value, provenance, fetchedAt);
    items.set(item.id, item);
    raw.push(payload);
    return [result.value.body, ...result.value.comments];
  };

  // Hop 0: every extracted ref. Hop 1: refs found inside ANY fetched body —
  // GitHub, JIRA, and Linear payloads all contribute candidates, followed once
  // through the same visited sets (one hop total: hop fetches feed no further
  // extraction).
  const fetchedTracker = new Set<string>();
  const fetchTracker = async (ref: TrackerKeyRef): Promise<string[]> => {
    if (fetchedTracker.has(ref.key)) return [];
    fetchedTracker.add(ref.key);
    const outcome = await fetchTrackerKey(ref, config, fetchJson, fetchedAt);
    if (outcome.item) items.set(outcome.item.id, outcome.item);
    if (outcome.raw) raw.push(outcome.raw);
    if (outcome.failure) failures.push(outcome.failure);
    if (outcome.missing) missingConfig.push(outcome.missing);
    return outcome.hopText ? [outcome.hopText] : [];
  };

  const hopTexts: string[] = [];
  for (const ref of refs) {
    if (ref.kind === "github") {
      hopTexts.push(...(await fetchGithub(ref, ref.provenance.source)));
      continue;
    }
    hopTexts.push(...(await fetchTracker(ref)));
  }
  if (hopTexts.length > 0) {
    const hopRefs = extractRefs({ commitMessages: hopTexts }, options);
    for (const ref of hopRefs) {
      if (ref.kind === "github") {
        await fetchGithub(ref, "link-hop");
      } else if (ref.tracker !== "unknown") {
        // Configured tracker keys one hop out fetch too; unconfigured hop keys
        // stay out (hop prose is low-signal — the config story is unchanged).
        await fetchTracker(ref);
      }
    }
  }

  // Light-tier enrichment (relevance trim + acceptance criteria), metered.
  let enrichment: EnrichmentReport = { status: "skipped", reason: "no runTurn injected" };
  if (deps.runTurn && items.size > 0) {
    const grant = deps.budget
      ? deps.budget.tryConsume("related-context-retrieval")
      : absentBudgetGrant("related-context-retrieval");
    const budgetGranted = grant.granted;
    const overage = !grant.granted;
    const prompt = [
      "You are the related-context retrieval seat. Trim the candidate dossier",
      "for relevance to the change under review and lift acceptance criteria",
      "verbatim where a ticket states them. Return every item id with keep:",
      "true/false; optionally a tightened body (facts only, no invention).",
      "",
      JSON.stringify([...items.values()]),
    ].join("\n");
    try {
      const turn = await deps.runTurn(prompt, 1);
      if (turn.status !== "emitted") {
        enrichment = {
          status: "failed",
          reason: turn.message,
          budgetGranted,
          overage,
        };
      } else {
        const trims = parseEnrichBody(turn.body);
        if (!trims) {
          enrichment = {
            status: "failed",
            reason: "malformed enrichment output",
            budgetGranted,
            overage,
          };
        } else {
          for (const trim of trims) {
            const existing = items.get(trim.id);
            if (!existing) continue;
            if (!trim.keep) {
              items.delete(trim.id);
              continue;
            }
            const next = { ...existing };
            if (trim.body !== undefined) {
              const { body, truncated } = boundedBody(trim.body);
              next.body = body;
              if (truncated) next.provenance = `${next.provenance}; truncated at fetch edge`;
            }
            if (trim.acceptanceCriteria !== undefined) {
              next.acceptanceCriteria = trim.acceptanceCriteria;
            }
            items.set(trim.id, dossierItemSchema.parse(next));
          }
          enrichment = { status: "ran", budgetGranted, overage };
        }
      }
    } catch (cause) {
      enrichment = {
        status: "failed",
        reason: cause instanceof Error ? cause.message : String(cause),
        budgetGranted,
        overage,
      };
    }
  }

  return { items: [...items.values()], raw, missingConfig, failures, enrichment };
}

/** Route one tracker key to its configured endpoint, or a missing-config fact. */
async function fetchTrackerKey(
  ref: TrackerKeyRef,
  config: TrackerConfig,
  fetchJson: JsonFetcher,
  fetchedAt: string,
): Promise<TrackerFetchOutcome> {
  if (ref.tracker === "jira" && config.jira) {
    return fetchJiraKey(ref, config.jira, fetchJson, fetchedAt);
  }
  if (ref.tracker === "linear" && config.linear) {
    return fetchLinearKey(ref, config.linear, fetchJson, fetchedAt);
  }
  return {
    missing: {
      tracker: ref.tracker,
      prefix: ref.prefix,
      missing: ref.tracker === "unknown" ? "tracker-kind" : "base-url-or-token-env",
      provenance: ref.provenance,
    },
  };
}
