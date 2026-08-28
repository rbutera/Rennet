import { z } from "zod";
import type { CommandInput, CommandName, CommandOutput } from "./commands";
import type { RenderedHunkOccurrence } from "./delta/citations";
import { anchorSideSchema, anchorSpanSchema } from "./delta/citations";
import type {
  CiSignal,
  CouncilEffort,
  CouncilModel,
  DeltaDigestResult,
  DispositionAnchor,
  FindingAgreement,
  FlaggedReview,
  NoiseReview,
  PrBodyDraftResult,
  RefinementResult,
  UiVerification,
} from "./domain";
import { MAX_UI_SCREENSHOTS_PER_RUN } from "./domain";
import type { AttentionEventFrame, RoundEvent } from "./session";

const fileChangeStatusSchema = z.enum(["added", "modified", "deleted", "renamed"]);

const repositoryProvenanceSchema = z.object({
  id: z.string().min(1),
  root: z.string().min(1),
  commonDir: z.string().min(1),
  baseRef: z.string().min(1),
  baseOid: z.string().min(1),
  headOid: z.string().min(1),
  // The head's branch ref (#107) — named in the schema so it survives IPC intact
  // rather than being stripped (the type declares it, so the schema must carry it,
  // the #242 discipline). Optional: a detached HEAD has no branch, so the field is
  // absent, but when present it is the ref an own-branch PR `head` opens against.
  headRef: z.string().min(1).optional(),
});

// The change's stated intent (#136), captured with the patchset. It reaches the
// command boundary here so it survives IPC intact rather than being stripped: the
// type declares it, so the schema must carry it (#242).
const patchsetIntentSurfaceSchema = z.enum(["github-pr", "github-rest", "working-tree"]);
const patchsetSpecSnapshotSchema = z.object({
  path: z.string(),
  digest: z.string(),
  content: z.string().optional(),
});
const patchsetIntentSchema = z.object({
  surface: patchsetIntentSurfaceSchema,
  prTitle: z.string().optional(),
  prBody: z.string().optional(),
  prBodyAbsent: z.boolean().optional(),
  specSnapshots: z.array(patchsetSpecSnapshotSchema).optional(),
  commitSubjects: z.array(z.string()).optional(),
});

export const patchsetSchema = z.object({
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  repository: repositoryProvenanceSchema,
  files: z.array(
    z.object({
      path: z.string(),
      previousPath: z.string().optional(),
      status: fileChangeStatusSchema,
      additions: z.number().int().nonnegative().nullable(),
      deletions: z.number().int().nonnegative().nullable(),
      binary: z.boolean(),
      patch: z.string(),
    }),
  ),
  rawDiff: z.string(),
  byteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
  // Provenance of the content, so a GitHub-PR (github-local/github-rest) patchset
  // survives the command round-trip intact — the renderer distinguishes a PR
  // snapshot from a working-tree capture by this, and the degraded badge reads
  // from `degraded`/`degradationReason`. Absent ⇒ `local` (additive; identity
  // ignores it). Without these here, zod strips them and every PR review looks
  // like a local capture.
  source: z.enum(["local", "github-local", "github-rest"]).optional(),
  degraded: z.boolean().optional(),
  degradationReason: z.string().optional(),
  // #144: the ProjectSnapshot the changeset was computed against, and #136: the
  // captured intent. Both optional/additive on the TYPE, so the old
  // `z.ZodType<Patchset>` annotation never noticed the schema omitted them and
  // stripped both at every IPC crossing (a silent #242 strip — the type promised
  // fields that never survived). Declared here so the schema matches the type.
  projectSnapshotId: z.string().optional(),
  intent: patchsetIntentSchema.optional(),
});

export const dispositionTypeSchema = z.enum(["approve", "request-change", "comment", "question"]);

const dispositionAnchorSchema: z.ZodType<DispositionAnchor> = z
  .object({
    path: z.string(),
    contentDigest: z.string().min(1),
    // Optional span anchor (issue #78): a 1-based file-line range on `side`.
    span: z
      .object({
        startLine: z.number().int().min(1),
        endLine: z.number().int().min(1).optional(),
      })
      .optional(),
    side: z.enum(["additions", "deletions", "context"]).optional(),
    spanDigest: z.string().min(1).optional(),
  })
  // span/side/spanDigest are all-or-none: a span anchor needs all three; a
  // path-grained anchor has none. A partial presence is rejected.
  .refine(
    (anchor) =>
      [anchor.span, anchor.side, anchor.spanDigest].filter((field) => field !== undefined).length %
        3 ===
      0,
    { message: "span, side, and spanDigest must all be present (span anchor) or all absent" },
  )
  .refine(
    (anchor) =>
      anchor.span === undefined ||
      anchor.span.endLine === undefined ||
      anchor.span.endLine >= anchor.span.startLine,
    { message: "span.endLine must be >= span.startLine" },
  );

export const dispositionSchema = z.object({
  anchor: dispositionAnchorSchema,
  type: dispositionTypeSchema,
  body: z.string(),
});

// The real forge post-target — the single source of truth reused by BOTH the
// review snapshot (`Review.postTarget`) and the publish commands
// (`publishTargetSchema`), so the coordinates the renderer reads off a review are
// byte-identical to the ones it hands to `publish.review`.
const forgeRepoSchema = z.object({
  forge: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
});

/** The pinned publish target: which PR, which node id, which reviewed head. */
const forgePublishTargetSchema = z.object({
  repo: forgeRepoSchema,
  number: z.number().int().positive(),
  /** The forge's opaque PR node id (carried, interpreted only in the adapter). */
  forgeRef: z.string().min(1),
  /** The reviewed head commit OID, pinned at review start (GraphQL `commitOID`). */
  headOid: z.string().min(1),
  /**
   * Whether the authenticated viewer authored this PR (GraphQL `viewerDidAuthor`) —
   * the ownership fact that routes an OWN PR down the own-branch lane. Optional +
   * additive: absent on every existing snapshot, which parses unchanged.
   */
  viewerDidAuthor: z.boolean().optional(),
});

// The delta re-review account (issue #73): the deterministic record of what a
// successor patchset did to the staged asks + the paths it changed beyond them. It
// crosses IPC on `Review.successorAccount`, so it is declared here (an unlisted optional
// on Review would be silently stripped at the boundary — the #242 discipline).
const deltaAskStatusSchema = z.enum(["addressed", "partially-addressed", "untouched"]);
const deltaAskAccountSchema = z.object({
  path: z.string().min(1),
  span: anchorSpanSchema.optional(),
  side: anchorSideSchema.optional(),
  type: dispositionTypeSchema,
  summary: z.string(),
  status: deltaAskStatusSchema,
  // Handoff task attribution (issue #73 wave 3). Optional + additive: absent on a
  // regenerate and on every legacy account, so old snapshots parse unchanged.
  handoffTask: z.object({ index: z.number().int().nonnegative(), title: z.string() }).optional(),
});
// Hunk-grain beyond-asks (issue #73 wave 3): one uncovered new hunk, its file line range
// and bucket. `side: "deletions"` on a pure-deletion hunk (range is the old-file image).
const deltaBeyondHunkSchema = z.object({
  path: z.string().min(1),
  span: anchorSpanSchema,
  side: anchorSideSchema.optional(),
  bucket: z.enum(["unasked-file", "asked-file"]),
  excerpt: z.string(),
});
export const successorAccountSchema = z.object({
  asks: z.array(deltaAskAccountSchema),
  beyondAsks: z.array(z.string()),
  // Hunk grain (issue #73 wave 3). Optional + additive: ABSENT ⇒ a legacy path-grain
  // account (render path grain only); an EMPTY ARRAY ⇒ computed, nothing beyond.
  beyondAskHunks: z.array(deltaBeyondHunkSchema).optional(),
});

export const reviewSchema = z.object({
  id: z.string().min(1),
  repositoryRoot: z.string().min(1),
  patchsets: z.array(patchsetSchema).min(1),
  activePatchsetId: z.string().min(1),
  pendingPatchsetId: z.string().optional(),
  dispositions: z.array(dispositionSchema),
  // The orphan tray (issue #16): dispositions whose occurrence VANISHED from the
  // successor patchset, surfaced against their last-known version rather than
  // dropped to void. Optional field crossing IPC — declared by hand (a `z.ZodType`
  // on Review only guards REQUIRED fields; an unlisted optional is silently
  // stripped at the boundary). Absent ⇒ no orphans, so every existing snapshot
  // validates unchanged.
  orphaned: z.array(dispositionSchema).optional(),
  status: z.enum(["current", "invalid"]),
  // A retrospective (read-only, no-post) review. Optional so every existing
  // review snapshot validates unchanged; absent ⇒ a normal postable review.
  retrospective: z.boolean().optional(),
  // The real PR post-target (issue #21). Present ONLY on a non-retrospective PR
  // review; its presence is exactly "this review can post to a real PR". Optional
  // so every existing snapshot (and every local/retrospective review) validates
  // unchanged.
  postTarget: forgePublishTargetSchema.optional(),
  // The delta re-review account (issue #73): stamped on a successor review, absent on
  // a first capture. Optional so every existing snapshot validates unchanged.
  successorAccount: successorAccountSchema.optional(),
});

// ── Publish egress schemas (issue #21) ───────────────────────────────────────
// The forge-neutral shapes the renderer sends to MAIN for the outbound GitHub
// review post. The renderer supplies the pinned target, the canonical review
// content, and the canonical payload bytes; MAIN independently re-derives the
// bytes and fails CLOSED on any disagreement (the egress-side "what you see is what
// leaves", R33), then gates the real egress on the effective mode + a single-use,
// target-and-payload-bound consent token before anything leaves the machine.

// `forgeRepoSchema` and the publish target now live above `reviewSchema` (the
// single source of truth `Review.postTarget` also reuses). Alias kept so the
// publish-command definitions below read unchanged.
export const publishTargetSchema = forgePublishTargetSchema;

/** The review verdict (the real GitHub review event). */
export const forgeReviewEventSchema = z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);

/** One review comment in the canonical `pr-review` shape (mirrors the ui preview). */
export const reviewCommentSchema = z.object({
  path: z.string().min(1),
  /** The file line, when a span anchor is known (#78). Absent ⇒ a file-level note. */
  line: z.number().int().min(1).optional(),
  side: z.enum(["LEFT", "RIGHT"]),
  type: dispositionTypeSchema,
  body: z.string(),
});

/**
 * One review-BODY note — the body stratum (B11 P0 finding 2, handoff-and-exits.md "The
 * review's two strata"). An ask with NO diff position (a prose/quote-of-board ask, or a
 * path-only ask) has no line to pin to, so it travels in the review BODY rather than
 * vanishing. Carries only its intent `type` + outbound `body`; the anchor is provenance
 * and does not egress.
 */
export const reviewBodyNoteSchema = z.object({
  type: dispositionTypeSchema,
  body: z.string(),
});

export const forgeRequestSchema = z.object({
  endpoint: z.string(),
  method: z.string(),
  // The GraphQL `{ query, variables }` document. Opaque here (validated by shape at
  // the adapter): it carries NO secret — the bearer token is a send-time header.
  body: z.unknown(),
});

export const publishDegradationSchema = z.object({
  // "file-level-fold": a no-line comment with a path folded to a file-level note.
  // "body-note": a pathless/prose ask woven into the review body (B11 finding 2).
  kind: z.enum(["file-level-fold", "body-note"]),
  path: z.string(),
  detail: z.string(),
});

export const publishOutcomeSchema = z.object({
  reviewRef: z.string(),
  url: z.string().nullable(),
  reused: z.boolean(),
});

/**
 * The own-branch PR submission (#257 / #107) — the title/body/base/head/draft the
 * paper previews and signs. `head` is a BRANCH ref, never a commit SHA: a GitHub PR
 * cannot open with a bare SHA as `head`. Mirrors the ui `PrSubmission`; the bytes
 * `prSubmissionPayload` serialises from it are what MAIN round-trips against `payload`.
 */
export const prSubmissionSchema = z.object({
  title: z.string(),
  body: z.string(),
  base: z.string().min(1),
  head: z.string().min(1),
  draft: z.boolean(),
});

// ── Projects + discovery (issue #29 / #37) ───────────────────────────────────
// The projects list is the app's entry; a project is a WORKSPACE (a folder of
// repos) or a single PROJECT REPO. These are the only two nouns the user meets;
// everything else is inferred by read-only discovery. The shapes are
// protocol-local: the renderer, the discovery adapter, and the project store all
// speak them, and they cross the command boundary intact.
export const projectKindSchema = z.enum(["workspace", "repo"]);
export type ProjectKind = z.infer<typeof projectKindSchema>;

/**
 * Which daemon a project lives on: the local machine, an in-distro WSL daemon
 * (`wsl:<distro>`), or a paired remote (`remote:<deviceId>`). Persisted on the
 * project so reopening it routes to the daemon that can actually see its path,
 * instead of always assuming local.
 */
export const sourceSchema = z.union([
  z.literal("local"),
  z.string().regex(/^wsl:.+$/),
  z.string().regex(/^remote:.+$/),
]);
export type ProjectSource = z.infer<typeof sourceSchema>;

/** A git repo discovered at (repo kind) or under (workspace kind) the pointed-at path. */
export const discoveredRepoSchema = z.object({
  name: z.string().min(1),
  /** Absolute path to the repo — the reviewable open target. */
  path: z.string().min(1),
  /** Local branch count (`for-each-ref refs/heads`). */
  branches: z.number().int().nonnegative(),
  /** `host/owner/name` parsed from the origin remote, when the repo has a forge remote. */
  remote: z.string().optional(),
  /** A terse, honest note surfaced by discovery (e.g. "docs only"); omitted when clean. */
  note: z.string().optional(),
});
export type DiscoveredRepo = z.infer<typeof discoveredRepoSchema>;

/** A single child directory entry returned by `fs.listDir`'s directory browser. */
export const fsEntrySchema = z.object({
  /** Directory name only (not the full path). */
  name: z.string().min(1),
  /** Absolute path on the source's filesystem. */
  path: z.string().min(1),
  /** True when this directory contains a `.git` entry (a git repo). */
  isRepo: z.boolean(),
  /** True when the directory could not be read (permission denied); render dim, non-descendable. */
  unreadable: z.boolean(),
});
export type FsEntry = z.infer<typeof fsEntrySchema>;

/** The `fs.listDir` output: one directory's listing plus enough context to navigate. */
export const fsListDirResultSchema = z.object({
  /** The resolved absolute directory that was listed. */
  path: z.string().min(1),
  /** The source daemon's home directory (the browser's start point). */
  home: z.string().min(1),
  /** The parent directory, or null at the filesystem root. */
  parent: z.string().nullable(),
  /** Child directories only (files omitted), hidden dirs included, name-sorted. */
  entries: z.array(fsEntrySchema),
});
export type FsListDirResult = z.infer<typeof fsListDirResultSchema>;

/**
 * The read-only discovery result: what the worktree-config step renders as
 * EDITABLE DEFAULTS, never questions (User Journey stage 1). `repos` are the
 * toggle rows (all on in the UI); `primaryBranch` is confirmed and editable; a
 * walk-vs-list disagreement is SURFACED in `reconciliation` rather than silently
 * resolved.
 */
export const discoveryResultSchema = z.object({
  path: z.string().min(1),
  kind: projectKindSchema,
  repos: z.array(discoveredRepoSchema),
  /** origin/HEAD, else the current branch, else `main`. */
  primaryBranch: z.string().min(1),
  /** A walk-vs-list disagreement, surfaced (not resolved); omitted when the two agree. */
  reconciliation: z.string().optional(),
  /** The daemon this discovery ran on. Defaults to `local` for pre-existing callers. */
  source: sourceSchema.default("local"),
});
export type DiscoveryResult = z.infer<typeof discoveryResultSchema>;

/** A persisted project listed by a source. */
export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  kind: projectKindSchema,
  /** The number of included repos (1 for a project repo). */
  repoCount: z.number().int().nonnegative(),
  /** The summed local-branch count across the included repos. */
  branchCount: z.number().int().nonnegative(),
  primaryBranch: z.string().min(1),
  /** The reviewable path a project row opens (the repo, or the first included repo). */
  openPath: z.string().min(1),
  /**
   * The working-tree paths of the repos the user INCLUDED at add time (a workspace
   * can exclude some of its repos). Persisted so live detail honours the selection
   * instead of re-scanning every repo under the workspace. Optional for
   * backward-compatibility: a project stored before this field existed has it
   * absent, and the reader falls back to discovering all repos under the path.
   */
  includedRepoPaths: z.array(z.string().min(1)).optional(),
  addedAt: z.iso.datetime(),
  /**
   * Which daemon this project lives on. Defaults to `local` so a project
   * persisted before this field existed reads back unchanged.
   */
  source: sourceSchema.default("local"),
});
export type Project = z.infer<typeof projectSchema>;

/** A harness detected on the machine, for the ambient first-run detection line. */
export const detectedHarnessSchema = z.object({
  id: z.string().min(1),
  version: z.string().nullable(),
});
export type DetectedHarness = z.infer<typeof detectedHarnessSchema>;

/** The honest state of a forge (source-control) CLI detected on a host (#484 seam; #483
 *  "gh rides again"). A subset of the client `ToolStatus` — a forge CLI probe never yields
 *  `unreachable` (that is a host-daemon state, not a CLI state). */
export const forgeStatusSchema = z.enum(["available", "not-authenticated", "not-installed"]);
export type ForgeStatus = z.infer<typeof forgeStatusSchema>;

/** A forge CLI detected on the host its daemon runs on (the wire shape `forge.detect`
 *  returns). The client maps it to a `DetectedTool` row, adding the label + enable toggle. */
export const detectedForgeSchema = z.object({
  id: z.string().min(1),
  version: z.string().nullable(),
  status: forgeStatusSchema,
  detail: z.string(),
});
export type DetectedForge = z.infer<typeof detectedForgeSchema>;

// ── The GitHub account (v4.2: OAuth device flow replaces the gh-CLI piggyback) ─
// The renderer-safe projection of the host-side auth state. The TOKEN itself is
// never here — only who is connected, with which scopes, or which distinct
// problem (with its copy) stands between the user and a connection.
export const gitHubAuthStatusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("connected"),
    /** The signed-in GitHub login (`@user` on the settings row), when resolvable. */
    login: z.string().nullable(),
    scopes: z.array(z.string()),
  }),
  z.object({ state: z.literal("not-connected"), copy: z.string().min(1) }),
  z.object({ state: z.literal("token-invalid"), copy: z.string().min(1) }),
  /** GitHub is unreachable (timeout/DNS/offline) — says nothing about the token. */
  z.object({ state: z.literal("network"), copy: z.string().min(1) }),
  z.object({
    state: z.literal("insufficient-scope"),
    copy: z.string().min(1),
    scopes: z.array(z.string()),
  }),
]);
export type GitHubAuthStatus = z.infer<typeof gitHubAuthStatusSchema>;

/** One in-flight device-flow connect, as the renderer polls it. */
export const gitHubConnectPollSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("pending") }),
  z.object({ phase: z.literal("connected"), status: gitHubAuthStatusSchema }),
  z.object({ phase: z.literal("failed"), message: z.string() }),
  /** No flow is in flight (never started, cancelled, or already consumed). */
  z.object({ phase: z.literal("idle") }),
]);
export type GitHubConnectPoll = z.infer<typeof gitHubConnectPollSchema>;

// ── Processing a freshly-added project: the initial context dump ─────────────
// After `projects.add` persists a project, Rennet PROCESSES each included repo —
// building the deterministic ProjectSnapshot / repo-map that every later review
// reads. It is the "initial context dump" (Rai's wireframe #2): a delightful
// spinner with LIVE narration that explains what it is doing in real time. The
// narration is wired to the REAL generator stages (below), not scripted text.
//
// Progress is pushed main→renderer over the `onProgress` channel keyed by the
// `commandId`; the `project.process` command resolves with the final per-repo
// summary once every repo has been built (or has failed softly). No gate, no
// model spend: the snapshot build is pure over git.

/**
 * The real stages of a single repo's snapshot build, in order. Each maps 1:1 to
 * a step the {@link https://ProjectSnapshotGenerator} actually performs, so the
 * narration is honest: `resolve` (find the default branch) → `tree` (read the
 * file tree at the base OID) → `workspace` (map scopes/edges/entry points) →
 * `conventions` (learn conventions, ownership, tests) → `symbols` (extract
 * symbols + references from the changed closure) → `build` (assemble the map) →
 * `verify` (integrity check) → `store` (persist as current). `knowledge` is the
 * one post-build stage: the partitioned knowledge swarm's per-partition and
 * verify-seat lines (#460) ride the same channel after `store`.
 */
export const snapshotStageSchema = z.enum([
  "resolve",
  "tree",
  "workspace",
  "conventions",
  "symbols",
  "build",
  "verify",
  "store",
  "knowledge",
]);
export type SnapshotStage = z.infer<typeof snapshotStageSchema>;

/** The outcome of processing one repo — real counts from the built snapshot. */
export const processedRepoSummarySchema = z.object({
  repo: z.string().min(1),
  path: z.string().min(1),
  ok: z.boolean(),
  /** Files in the tree at the base OID (present on success). */
  files: z.number().int().nonnegative().optional(),
  /** Symbol shards in the built snapshot (present on success). */
  symbols: z.number().int().nonnegative().optional(),
  /** Reference shards in the built snapshot (present on success). */
  references: z.number().int().nonnegative().optional(),
  /** Symbol shards reused verbatim from a previous snapshot (incremental builds). */
  reusedSymbols: z.number().int().nonnegative().optional(),
  /** The resolved primary branch the snapshot was taken at (present on success). */
  baseRef: z.string().optional(),
  /** A legible failure message (present on failure); the other repos still process. */
  error: z.string().optional(),
});
export type ProcessedRepoSummary = z.infer<typeof processedRepoSummarySchema>;

/**
 * A typed reference to the project a landed processing line produced (issue #71
 * anchoring). A landed progress event may carry one so the renderer can navigate
 * to it via the existing flow handlers; a line with no ref is honestly inert.
 */
export const progressArtifactRefSchema = z.object({
  kind: z.literal("project"),
  projectId: z.string().min(1),
});
export type ProgressArtifactRef = z.infer<typeof progressArtifactRefSchema>;

/**
 * A single live-narration event pushed while a project processes. `repo-start` and
 * `repo-done` bracket each repo; `stage` fires
 * as the build advances, each carrying a real `note` (and often a real `detail`,
 * e.g. "412 files"); `done` fires once at the end with the full per-repo summary.
 * `repo-error` is a SOFT failure for one repo — processing continues, and `done`
 * still fires.
 */
export const projectProcessEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repo-start"),
    repo: z.string().min(1),
    /** 1-based position in the workspace's included repos. */
    index: z.number().int().positive(),
    total: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("stage"),
    repo: z.string().min(1),
    stage: snapshotStageSchema,
    /** The friendly, present-tense line ("Reading the file tree"). */
    note: z.string().min(1),
    /** A real, specific detail when known ("412 files", "main"). */
    detail: z.string().optional(),
  }),
  z.object({
    kind: z.literal("repo-done"),
    repo: z.string().min(1),
    summary: processedRepoSummarySchema,
    /** The landed artifact this repo produced, for anchoring (optional). */
    artifact: progressArtifactRefSchema.optional(),
  }),
  z.object({
    kind: z.literal("repo-error"),
    repo: z.string().min(1),
    message: z.string().min(1),
  }),
  z.object({
    kind: z.literal("done"),
    repos: z.array(processedRepoSummarySchema),
  }),
]);
export type ProjectProcessEvent = z.infer<typeof projectProcessEventSchema>;

/**
 * Live narration for a `project.detail` fetch — the PR half only (the local half
 * is instant git). `prs-start` announces the determinate total (forge repos to
 * fetch); one `repo-prs` fires as each repo's PRs land, carrying its 1-based
 * position and how many it contributed. A separate, smaller union from
 * `ProjectProcessEvent` (snapshot-build narration is a different shape), streamed
 * on its own `onProjectDetailProgress` channel so the two never intermix.
 */
export const projectDetailProgressEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("prs-start"),
    /** Forge repos whose PRs will be fetched — the honest denominator. */
    total: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("repo-prs"),
    repo: z.string().min(1),
    /** 1-based position among the forge repos being fetched. */
    index: z.number().int().positive(),
    total: z.number().int().positive(),
    /** PRs this repo contributed (for a truthful running tally). */
    count: z.number().int().nonnegative(),
  }),
]);
export type ProjectDetailProgressEvent = z.infer<typeof projectDetailProgressEventSchema>;

/**
 * Every event the single commandId-keyed progress frame can carry. The transport
 * routes by commandId and stays agnostic to shape; the two public channels
 * (`onProgress` / `onProjectDetailProgress`) each expose their own member. The
 * wire frame validates against this union, so a detail event is not dropped as
 * unparseable (a given commandId only ever carries one member's kinds).
 */
export const projectProgressEventSchema = z.union([
  projectProcessEventSchema,
  projectDetailProgressEventSchema,
]);
export type ProjectProgressEvent = z.infer<typeof projectProgressEventSchema>;

// ── Project detail: the unified smart list (issue #37) ───────────────────────
// Clicking a project opens ONE scrolling surface: local work AND every pull
// request in a single list, rows visually distinct by state, filterable, HOT-sorted
// (recency of engagement) with a relevance boost that floats a row up when it needs
// the viewer. MAIN supplies the raw substrate — local worktrees/branches, pull
// requests, and the viewer login — and the renderer DERIVES the unified rows from
// it: dedupe (a branch with a PR shows as the PR, the worktree an annotation on it),
// ownership (row appearance + filter, not a hard wall), needs-you, and merged →
// read-only. Live git + GitHub wiring (the home-surface GraphQL query set + the
// REST-conditional polling loop) is a LATER slice; a fixture stands behind this
// typed boundary now so the screen comes alive without an invented integration.

/** Where a local piece of work sits in the local pipeline (captured > reviewed > prd). */
export const smartListStageSchema = z.enum(["captured", "reviewed", "prd"]);
export type SmartListStage = z.infer<typeof smartListStageSchema>;

/** Continuous-integration state for a pull request (honest "none" when unknown). */
export const smartListCiSchema = z.enum(["none", "passing", "failing", "pending"]);
export type SmartListCi = z.infer<typeof smartListCiSchema>;

/** A local worktree/branch detected for the project — private/local (backlight). */
export const localWorkSchema = z.object({
  /** A stable, unique worktree identifier — the clean-up target (unambiguous even
   * across a workspace and across a reused branch name). */
  id: z.string().min(1),
  /**
   * A stable identity for the repository this worktree belongs to. A workspace holds
   * several repos, so a branch NAME is unique only within one repo; dedupe keys on the
   * composite `(repository, branch)`, never the bare branch.
   */
  repository: z.string().min(1),
  /** The branch/worktree name (half of the composite dedupe key). */
  branch: z.string().min(1),
  /** The login that owns this local work — matched against the viewer for ownership. */
  author: z.string().min(1),
  /** Uncommitted changes present in the worktree. */
  dirty: z.boolean(),
  /**
   * Commits ahead of / behind the primary branch. `null` means the comparison could
   * NOT be computed (the base ref is unresolvable in this repo) — distinct from `0`,
   * which is a genuinely even branch. A live source must never collapse an
   * un-computable comparison to `0/0`, or a branch with an unknown base reads as
   * "fully merged, nothing to do" (a lying gauge).
   */
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  /** How far along the local pipeline this work sits. */
  stage: smartListStageSchema,
  /** Recency of engagement (ISO), the HOT-sort key. */
  lastActivityAt: z.iso.datetime(),
});
export type LocalWork = z.infer<typeof localWorkSchema>;

/** A PR's lifecycle state — also the `project.detail` history filter vocabulary. */
export const pullRequestStateSchema = z.enum(["open", "merged", "closed"]);
export type PullRequestState = z.infer<typeof pullRequestStateSchema>;

/**
 * How the reviewed PR worktree's `.rennet/setup` run went. `none` = no setup file;
 * `failed` names the command and exit code (setup never blocks the review).
 */
export const prWorktreeSetupSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }),
  z.object({ status: z.literal("running") }),
  z.object({ status: z.literal("ok") }),
  z.object({ status: z.literal("failed"), command: z.string().min(1), exitCode: z.number().int() }),
]);
export type PrWorktreeSetup = z.infer<typeof prWorktreeSetupSchema>;

/** A pull request on the project — public/what-exists-in-the-world (ink). */
export const pullRequestSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  /**
   * A stable identity for the repository this PR belongs to — the other half of the
   * composite `(repository, branch)` dedupe key. A workspace PR for `repo-a/feat/x`
   * must not match a local worktree `repo-b/feat/x`.
   */
  repository: z.string().min(1),
  /** The PR's head branch (half of the composite dedupe key against a local worktree). */
  branch: z.string().min(1),
  author: z.string().min(1),
  state: pullRequestStateSchema,
  /** The viewer has been asked to review this PR — the relevance boost's core signal. */
  reviewRequestedFromViewer: z.boolean(),
  ci: smartListCiSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  lastActivityAt: z.iso.datetime(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

/** The signed-in GitHub user, so the renderer can tag ownership (mine vs theirs). */
export const projectViewerSchema = z.object({ login: z.string().min(1) });
export type ProjectViewer = z.infer<typeof projectViewerSchema>;

/** The raw project-detail substrate MAIN delivers; the renderer derives the rows. */
export const projectDetailSchema = z.object({
  viewer: projectViewerSchema,
  locals: z.array(localWorkSchema),
  prs: z.array(pullRequestSchema),
  /**
   * A >1000 upstream truncation, surfaced so a partial surface never renders as
   * complete (the SSO partial-results banner). The fixture sets it false today; the
   * live GraphQL loop sets it from the explicit truncation state later.
   */
  truncated: z.boolean(),
  /**
   * Why GitHub auth is unavailable. Absent (undefined) when auth resolved and PRs
   * were fetched. Present when the PR source was not wired — a missing token renders
   * as an honest hint, never as "zero PRs".
   */
  authUnavailable: z
    .enum(["not-connected", "token-invalid", "insufficient-scope", "network"])
    .optional(),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

// ── The Context Map surface (change add-context-map-view) ─────────────────────
// The persisted Repo Map behind the typed boundary: the deterministic ProjectMap
// (structure) plus the model-derived knowledge set (labelled hypotheses), read
// from the local project store — no rebuild, no model spend on the read path.
export const projectMapSchema = z.object({
  baseRef: z.string().min(1),
  baseRefResolution: z.enum([
    "forge-metadata",
    "symbolic-head",
    "configured-upstream",
    "explicit-setting",
  ]),
  baseOid: z.string().min(1),
  fingerprint: z.string().min(1),
  files: z.array(
    z.object({
      path: z.string(),
      blobOid: z.string(),
      size: z.number(),
      mode: z.string(),
    }),
  ),
  scopes: z.array(
    z.object({
      name: z.string(),
      root: z.string(),
      sourceRoot: z.string().optional(),
      type: z.enum(["library", "application"]).optional(),
      private: z.boolean(),
      tags: z.array(z.string()),
    }),
  ),
  edges: z.array(
    z.object({ from: z.string(), to: z.string(), kind: z.enum(["manifest", "implicit"]) }),
  ),
  entryPoints: z.array(
    z.object({
      scope: z.string(),
      main: z.string().optional(),
      module: z.string().optional(),
      types: z.string().optional(),
      /** The `exports` field, canonicalized; opaque JSON preserved verbatim. */
      exports: z.unknown().optional(),
      bin: z.array(z.tuple([z.string(), z.string()])),
    }),
  ),
  tests: z.array(
    z.object({ path: z.string(), scope: z.string().nullable(), matchedBy: z.string() }),
  ),
  ownership: z.array(z.object({ pattern: z.string(), owners: z.array(z.string()) })),
  conventions: z.array(
    z.object({
      path: z.string(),
      digest: z.string(),
      kind: z.enum([
        "formatter",
        "linter",
        "typescript",
        "workspace",
        "nx",
        "editorconfig",
        "rennet",
        "other",
      ]),
    }),
  ),
});
export type ProjectMapPayload = z.infer<typeof projectMapSchema>;

export const knowledgeAnchorSchema = z.object({
  path: z.string().min(1),
  blobOid: z.string().min(1),
  symbol: z.string().optional(),
  lines: z
    .object({ startLine: z.number().min(1), endLine: z.number().min(1).optional() })
    .optional(),
});

export const knowledgeStatementSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  aspect: z.enum(["purpose", "convention", "why"]),
  claim: z.string().min(1),
  evidence: z.array(knowledgeAnchorSchema),
  confidence: z.enum(["high", "medium", "low"]),
  status: z.enum(["hypothesis", "confirmed", "rejected"]),
  provenance: z.object({
    generator: z.string(),
    model: z.string().nullable(),
    apiKeySource: z.string().nullable(),
  }),
  learnedAgainst: z.object({ baseOid: z.string(), snapshotFingerprint: z.string() }),
});
export type KnowledgeStatementPayload = z.infer<typeof knowledgeStatementSchema>;

export const knowledgeSetSchema = z.object({
  schemaVersion: z.number(),
  repoKey: z.string(),
  baseOid: z.string(),
  snapshotFingerprint: z.string(),
  generator: z.string(),
  statements: z.array(knowledgeStatementSchema),
});
export type KnowledgeSetPayload = z.infer<typeof knowledgeSetSchema>;

export const projectContextMapResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    map: projectMapSchema,
    knowledge: knowledgeSetSchema.nullable(),
  }),
  // No persisted snapshot (or it failed the freshness/integrity gate): a typed
  // absent naming why — never a fabricated or partially-served map.
  z.object({ status: z.literal("absent"), reason: z.string().min(1) }),
]);
export type ProjectContextMapResult = z.infer<typeof projectContextMapResultSchema>;

// The project-scoped context ask (the same engine `context.ask` runs for a
// review, keyed by {repoKey, baseOid} at the persisted tip). Cost is ALWAYS
// reported — a failed ask still spent (or honestly reports zero) turns.
export const contextAskCostSchema = z.object({
  turns: z.number(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  budgetGranted: z.boolean(),
  overage: z.boolean(),
  /** The council's inspectable "why this model" trace; opaque JSON preserved verbatim. */
  resolution: z.unknown(),
});

export const contextAnswerSchema = z.object({
  answer: z.string(),
  evidence: z.array(knowledgeAnchorSchema),
  confidence: z.enum(["high", "medium", "low"]),
  consulted: z.array(z.string()),
  cost: contextAskCostSchema,
  unanswered: z.object({ reason: z.string() }).optional(),
});

export const projectContextAskResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("answered"), answer: contextAnswerSchema }),
  z.object({ status: z.literal("unanswered"), answer: contextAnswerSchema }),
  z.object({
    status: z.literal("failed"),
    failureReason: z.string().min(1),
    cost: contextAskCostSchema,
  }),
]);
export type ProjectContextAskResult = z.infer<typeof projectContextAskResultSchema>;

export const knowledgeDispositionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), statement: knowledgeStatementSchema }),
  z.object({ status: z.literal("not-found"), statementId: z.string().min(1) }),
]);
export type KnowledgeDispositionResult = z.infer<typeof knowledgeDispositionResultSchema>;

// ── The Flagged lens: findings + dual-review agreement (issue #138) ───────────
// The automated review layer's output for a review, delivered behind the typed
// command boundary. A fixture stands behind it until the live finding-generation
// runner + aggregation land (they sequence with #32/#41). The renderer folds this
// into the flagged index; `status` keeps "ran clean" honestly apart from "the
// runner did not complete".
export const findingSeveritySchema = z.enum(["high", "medium", "low"]);
export const findingModelAnswerSchema = z.object({
  model: z.string().min(1),
  answer: z.string(),
});
export const findingAdjudicationSchema = z.object({
  verdict: z.enum(["supported", "contradicted", "insufficient"]),
  evidence: z.string(),
  adjudicatedBy: z.string().min(1),
});
export const findingAgreementSchema: z.ZodType<FindingAgreement> = z.union([
  z.object({
    kind: z.literal("concur"),
    agree: z.number(),
    total: z.number(),
  }),
  z.object({
    kind: z.literal("disagree"),
    answers: z.array(findingModelAnswerSchema),
    adjudication: findingAdjudicationSchema.optional(),
  }),
]);
/**
 * The reproduce-or-refute verification chip (issue #179). Additive optional on a
 * finding: a `reproduced` chip carries its one-line evidence, an `inconclusive`
 * chip its honest caveat; a `refuted` finding never surfaces (core drops it before
 * the lens). This field MUST be in the schema or the `flagged.review` command
 * boundary strips it (the finding is a strict `z.object`) and the evidence the
 * verification pass computed would silently never reach the row (a delivery gap,
 * Rule 80) — the UI would render every finding as unverified.
 */
export const findingVerificationSchema = z.object({
  verdict: z.enum(["reproduced", "refuted", "inconclusive"]),
  evidence: z.string(),
});
export const findingElementSchema = z.object({
  findingId: z.string().min(1),
  anchor: z.string().min(1),
  summary: z.string(),
  severity: findingSeveritySchema,
  agreement: findingAgreementSchema,
  verification: findingVerificationSchema.optional(),
});
/**
 * The dual-model provenance note (issue #41). Additive optional on the `ok`
 * flagged review: `seats` names the provider labels that ran; `secondSeatUnavailable`
 * is the honest degradation marker. It carries NO merged verdict.
 */
export const dualReviewNoteSchema = z.object({
  seats: z.array(z.string().min(1)),
  secondSeatUnavailable: z.string().optional(),
});
/**
 * The predicted-risk cross-check (issue #181): one hypothesised risk reconciled
 * against the surfaced findings. `open` (no finding addressed it) carries an empty
 * `findingIds`; `confirmed` names the findings that addressed it. Additive optional
 * on the `ok` flagged review — a review formed without a hypothesis omits it. This
 * field MUST be in the schema or the command boundary would strip it before the
 * renderer (the ok branch is a strict `z.object`), so the anti-rubber-stamp payoff
 * would silently never reach the UI (a delivery check, Rule 80).
 */
export const riskCrossCheckSchema = z.object({
  riskId: z.string().min(1),
  status: z.enum(["confirmed", "open"]),
  findingIds: z.array(z.string().min(1)),
});
export const ciFailureVerdictSchema = z.enum(["change-caused", "environmental", "unclassified"]);
export const ciFailureSchema = z.object({
  checkId: z.string().min(1),
  checkName: z.string().min(1),
  verdict: ciFailureVerdictSchema,
  evidence: z.string(),
  implicatedPaths: z.array(z.string().min(1)),
  detailsUrl: z.string().url().optional(),
  classifiedBy: z.enum(["deterministic", "model"]),
  findingId: z.string().min(1).optional(),
});
export const ciSignalSchema: z.ZodType<CiSignal> = z.union([
  z.object({
    status: z.literal("checked"),
    overall: z.enum(["passing", "failing", "pending"]),
    failures: z.array(ciFailureSchema),
    headOid: z.string().min(1),
    incomplete: z.boolean(),
  }),
  z.object({ status: z.literal("no-checks"), headOid: z.string().min(1) }),
  z.object({ status: z.literal("unavailable"), reason: z.string().min(1) }),
]);
/**
 * The committed hypothesis (issue #178): the reviewer's reading frame — the domain,
 * in/out scope, the design we'd have chosen, and the predicted risks (each with the
 * `riskId` the pass minted). It rides the `ok` flagged review additively, ALONGSIDE
 * `crossChecks`, and this pairing is load-bearing: `riskId` is minted per pass with a
 * random id, and the crossChecks reconcile THIS hypothesis's risks against the
 * findings — so the reading frame must be folded from the SAME hypothesis, or every
 * risk would fall back to `open` (a riskId mismatch). Carrying both on one review
 * keeps that pair consistent. Absent ⇒ no hypothesis was produced (the pre-#178
 * shape); the reading frame is simply not shown.
 */
export const reviewHypothesisSchema = z.object({
  domain: z.string(),
  scope: z.object({
    inScope: z.array(z.string()),
    outOfScope: z.array(z.string()),
  }),
  designExpectation: z.string(),
  risks: z.array(
    z.object({
      riskId: z.string().min(1),
      statement: z.string(),
      severity: findingSeveritySchema,
      disconfirmer: z.string(),
    }),
  ),
  repoContextPresent: z.boolean(),
});
// Incomplete-ingestion blocker (R18, #309): content the deterministic floor could
// not ingest. Rides FlaggedReview so it reaches the Flagged lens and PublishSheet
// as render-only honest copy. `path` is null for a patchset-wide truncation.
const flaggedBlockingStateSchema = z.object({
  reason: z.enum(["truncated", "binary", "submodule"]),
  path: z.string().nullable(),
  detail: z.string(),
});
/**
 * The verify-ui status (issue #183). Additive optional on the `ok` flagged review.
 * This field MUST be declared here or the strict `flagged.review` command boundary
 * silently strips it (Rule 80 delivery gap): the honest ran/not-ui/unavailable
 * status and its screenshot references would never reach the renderer, and the
 * Flagged lens would show no verify-ui strip even when the pass ran. The screenshot
 * BYTES never ride this shape — only `{ path, label }` references the renderer reads
 * on demand via `review.uiEvidence`, so the review payload stays small.
 */
export const uiScreenshotSchema = z.object({
  path: z.string().min(1),
  label: z.string(),
});
export const uiVerificationSchema: z.ZodType<UiVerification> = z.union([
  z.object({
    status: z.literal("ran"),
    classifierVersion: z.number().int().positive(),
    screenshots: z.array(uiScreenshotSchema).max(MAX_UI_SCREENSHOTS_PER_RUN),
    observationCount: z.number(),
    mounted: z.boolean(),
  }),
  z.object({
    status: z.literal("pending"),
    classifierVersion: z.number().int().positive(),
  }),
  z.object({
    status: z.literal("not-ui"),
    classifierVersion: z.number().int().positive(),
  }),
  z.object({
    status: z.literal("unavailable"),
    classifierVersion: z.number().int().positive(),
    reason: z.string(),
  }),
]);
export const flaggedReviewSchema: z.ZodType<FlaggedReview> = z.union([
  z.object({
    status: z.literal("ok"),
    findings: z.array(findingElementSchema),
    dual: dualReviewNoteSchema.optional(),
    crossChecks: z.array(riskCrossCheckSchema).optional(),
    // The verify-ui status (#183). MUST be declared or the strict command boundary
    // strips it (Rule 80). Additive optional — absent ⇒ the pre-#183 shape.
    uiVerification: uiVerificationSchema.optional(),
    lateEnrichmentScheduled: z.literal(true).optional(),
    // Additive informational CI signal (#182). This MUST be declared on BOTH
    // branches or the strict command boundary silently strips it (Rule 80).
    ciSignal: ciSignalSchema.optional(),
    hypothesis: reviewHypothesisSchema.optional(),
    // The patchset this result was computed against (#160/P0-2), so the renderer can
    // bind it to the canvases it is shown beside and drop a result that regenerate
    // left stale. Additive optional — absent ⇒ unbound (pre-#160 shape).
    patchsetId: z.string().min(1).optional(),
    // Incomplete-ingestion blockers (R18, #309). Declared on BOTH branches or the
    // strict boundary strips it (Rule 80). Additive optional — absent ⇒ pre-#309.
    blockingStates: z.array(flaggedBlockingStateSchema).optional(),
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.string(),
    // CI facts survive even when the model review fails; omission strips them.
    ciSignal: ciSignalSchema.optional(),
    patchsetId: z.string().min(1).optional(),
    blockingStates: z.array(flaggedBlockingStateSchema).optional(),
    uiVerification: uiVerificationSchema.optional(),
    lateEnrichmentScheduled: z.literal(true).optional(),
  }),
]);

// ── review.ask: ask the AI a question, one model or both (issue #139) ─────────
// The wire shape of a review question's routing + result. `mode` defaults to
// "orchestrator" so an omitted mode NEVER fires a second model. The result can
// carry at most `primary` (always the orchestrator) + `secondOpinion` (Codex, only
// in "both" mode) — there is no field for a merged answer, so "no synthesis, ever"
// is enforced by the schema itself, not only by the router.
export const askModeSchema = z.enum(["orchestrator", "both"]);
export const askAnswerSchema = z.object({
  model: z.string().min(1),
  answer: z.string(),
});
export const askReviewResultSchema = z.object({
  mode: askModeSchema,
  primary: askAnswerSchema,
  secondOpinion: askAnswerSchema.optional(),
});

// ── #251 conversation durability: token streaming + persistence + re-attach ───
// The final answer still returns from `invoke("review.ask")` (back-compat); these
// add the token STREAM alongside it, and the persisted-thread shapes a re-attach
// reloads. All fields optional on review.ask stay back-compatible with a #139 ask.

/** The channel a streamed answer arrives on — the orchestrator, or Codex's second opinion. */
export const streamChannelSchema = z.enum(["orchestrator", "codex"]);
export type StreamChannel = z.infer<typeof streamChannelSchema>;

/** A harness turn's lifecycle. ABSENT on a message = `complete` (back-compat). */
export const turnStatusSchema = z.enum(["streaming", "complete", "interrupted"]);
export type TurnStatus = z.infer<typeof turnStatusSchema>;

// Token-stream events, pushed main→renderer and keyed by `reviewId` (NOT commandId):
// a conversation stream must survive a renderer reload — Cmd-R keeps the turn running
// in main — whereas project.process's narration dies with its command. The kind
// literals are `ask-*`, DELIBERATELY disjoint from projectProcessEvent's own "done",
// so the two event families can never collide on a shared discriminator.
// A per-review MONOTONIC sequence number the daemon stamps on every emitted ask-stream event
// (#382 M2 finding 5, additive). `ask-delta` is the one event that APPENDS rather than sets, so a
// re-delivered delta (a reconnect that replays, a doubled broadcast) would duplicate text; the
// reducer rejects any event whose seq it has already applied. Optional for back-compat: a daemon
// that predates the field sends none and the reducer keeps its by-id idempotence for set-events.
const askStreamSeqSchema = z.number().int().nonnegative().optional();
export const reviewAskStreamEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ask-focus"),
    anchor: z.string().min(1),
    threadId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    seq: askStreamSeqSchema,
  }),
  z.object({
    kind: z.literal("ask-delta"),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    channel: streamChannelSchema,
    delta: z.string(),
    seq: askStreamSeqSchema,
  }),
  z.object({
    kind: z.literal("ask-complete"),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    channel: streamChannelSchema,
    model: z.string().min(1),
    finalBody: z.string(),
    seq: askStreamSeqSchema,
  }),
  z.object({
    kind: z.literal("ask-interrupted"),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    channel: streamChannelSchema,
    reason: z.string().optional(),
    seq: askStreamSeqSchema,
  }),
]);
export type ReviewAskStreamEvent = z.infer<typeof reviewAskStreamEventSchema>;

/** The IPC representation of a conversation anchor. The UI `ConversationAnchor` lives in
 *  `@rennet/app-ui`, which protocol cannot import; the renderer maps to and from this shape. */
export const conversationAnchorSchema = z.object({
  kind: z.enum(["line", "range", "chunk", "fragment"]),
  label: z.string().min(1),
  key: z.string().min(1),
  side: anchorSideSchema.optional(),
  context: z.string().optional(),
  // The file this anchor hangs on (#251 slice 3), for orphan resolution on re-attach.
  // Absent for a conversation fragment (anchors to a message, not code).
  path: z.string().optional(),
});
export type ConversationAnchorWire = z.infer<typeof conversationAnchorSchema>;

/** A persisted thread message crossing IPC on re-attach. `status` absent = complete. */
export const persistedThreadMessageSchema = z.object({
  id: z.string().min(1),
  author: z.enum(["you", "harness"]),
  model: z.string().min(1).optional(),
  body: z.string(),
  status: turnStatusSchema.optional(),
});
export type PersistedThreadMessageWire = z.infer<typeof persistedThreadMessageSchema>;

// A persisted thread as it returns on re-attach: identity + content + the harness
// version that produced it. There is NO orphan flag here — orphan placement is resolved
// RENDERER-side against the current diff (main persists identity; the renderer, the only
// place holding both the thread and the live diff, decides placement and never re-anchors).
export const persistedThreadSchema = z.object({
  threadId: z.string().min(1),
  anchor: conversationAnchorSchema,
  harnessVersionAtCreation: z.string().optional(),
  messages: z.array(persistedThreadMessageSchema),
});
export type PersistedThreadWire = z.infer<typeof persistedThreadSchema>;

// An in-flight turn reported by re-attach (the main-alive live case): the renderer
// resumes this coalesced body and re-subscribes for the remaining deltas.
export const inFlightTurnSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  channel: streamChannelSchema,
  model: z.string().min(1),
  bodySoFar: z.string(),
});
export type InFlightTurn = z.infer<typeof inFlightTurnSchema>;

export const reattachResultSchema = z.object({
  threads: z.array(persistedThreadSchema),
  inFlight: z.array(inFlightTurnSchema),
});
export type ReattachResult = z.infer<typeof reattachResultSchema>;

// ── review.refine: the comment-refinement loop's result (issue #19) ───────────
// A rough review note refined into a clean comment by a real model turn. The
// producer guarantees `refined` carries a non-empty body that is NOT byte-
// identical to the raw (a byte-identical "improvement" is `no-change`); an empty
// or absent turn maps to `failed`/`unavailable`. The shape has NO field for the
// raw dressed as refined, so "a failed refine never posts as refined" holds by
// construction: the renderer keeps showing the raw until a `refined` result lands
// and the user keeps it.
export const refinementResultSchema: z.ZodType<RefinementResult> = z.discriminatedUnion("status", [
  z.object({ status: z.literal("refined"), refined: z.string().min(1), model: z.string().min(1) }),
  z.object({ status: z.literal("no-change"), model: z.string().min(1) }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
  z.object({ status: z.literal("failed"), reason: z.string() }),
]);

// ── review.draftPrBody: the PR title/body drafting result (issue #74, M26) ────
// A light-tier model turn drafts a PR title + body from the reviewed changeset so
// the own-branch submission preview (#22) opens with an honest account rather than
// a bare diffstat. The producer guarantees `drafted` carries a non-empty title AND
// body (an empty either way is `failed`); the shape has NO field for a fabricated
// draft, so a failed turn keeps the deterministic composed body — never a blank the
// human might sign unread. The draft is human-editable and posts NOTHING (R33).
export const prBodyDraftResultSchema: z.ZodType<PrBodyDraftResult> = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("drafted"),
      title: z.string().min(1),
      body: z.string().min(1),
      model: z.string().min(1),
    }),
    z.object({ status: z.literal("unavailable"), reason: z.string() }),
    z.object({ status: z.literal("failed"), reason: z.string() }),
  ],
);

// ── review.deltaDigest: the light-tier prose over the successor account (#73/M25) ──
// A light-tier model turn rephrases the DETERMINISTIC successor account (per-ask
// addressed/partially/untouched + beyond-asks) into a one/two-sentence TL;DR shown
// ON TOP of the facts. The producer guarantees `drafted` carries non-empty text (an
// empty turn is `failed`); the shape has NO field for a fabricated digest, so on
// anything but `drafted` the panel shows no headline and the facts are unchanged.
// The digest posts NOTHING and gates nothing.
export const deltaDigestResultSchema: z.ZodType<DeltaDigestResult> = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("drafted"), text: z.string().min(1), model: z.string().min(1) }),
    z.object({ status: z.literal("unavailable"), reason: z.string() }),
    z.object({ status: z.literal("failed"), reason: z.string() }),
  ],
);

// ── The Noise lens: grouped low-signal churn (issue #34) ──────────────────────
// The low-signal churn a changeset touches, grouped away from the code that needs
// eyes and tagged with how each group was judged (a deterministic mechanical RULE
// vs the LLM NOISE JOB), delivered behind the typed command boundary. A fixture
// stands behind it until the live noise-classification runner lands. The renderer
// folds this into the noise index; `status` keeps "ran clean" honestly apart from
// "the runner did not complete".
export const noiseCategorySchema = z.enum([
  "formatting",
  "lockfile",
  "import-order",
  "generated",
  "fixture-rename",
  "comment-typo",
  "other",
]);
export const noiseJudgedBySchema = z.union([
  z.object({ kind: z.literal("rule"), rule: z.string().min(1) }),
  z.object({ kind: z.literal("noise-job"), model: z.string().min(1) }),
]);
export const noiseItemSchema = z.object({
  anchor: z.string().min(1),
  detail: z.string(),
  deviates: z.boolean().optional(),
});
export const noiseGroupSchema = z.object({
  groupId: z.string().min(1),
  category: noiseCategorySchema,
  summary: z.string(),
  judgedBy: noiseJudgedBySchema,
  items: z.array(noiseItemSchema),
});
export const noiseReviewSchema: z.ZodType<NoiseReview> = z.union([
  z.object({ status: z.literal("ok"), groups: z.array(noiseGroupSchema) }),
  z.object({ status: z.literal("failed"), reason: z.string() }),
]);

// ── review.symbolLookup: the in-app symbol inspector's answer (Rai, wireframes #8)
// The wire shape the inspector renders: definition sites (go-to-definition) +
// reference sites (find-references) from Rennet's OWN model-free symbolic surface.
// Each section is gated so a snapshot that could not answer rides back as
// `unavailable` — never conflated with an empty `ok` ("nothing found"). NO model
// spend: this is deterministic index reads, not an LLM guess.
const symbolDefinitionRowSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  kind: z.string().min(1),
  scope: z.string().nullable(),
});
const symbolReferenceRowSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  scope: z.string().nullable(),
});
// The honest confidence tier (#11), a discriminated union so `exact` can only ever
// ride with `structural` — a textual result cannot carry `exact` across the wire.
// This MUST cross the boundary: without it the live tier chip never renders (the
// object schema below would otherwise strip the unknown `tier` key).
const symbolTierSchema = z.union([
  z.object({ kind: z.literal("exact"), method: z.literal("structural") }),
  z.object({
    kind: z.literal("guess"),
    method: z.literal("structural"),
    candidates: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("guess"), method: z.literal("textual") }),
]);
function symbolSectionSchema<T extends z.ZodTypeAny>(row: T) {
  return z.union([
    z.object({
      status: z.literal("ok"),
      sites: z.array(row),
      truncated: z.boolean().optional(),
      tier: symbolTierSchema.optional(),
    }),
    z.object({ status: z.literal("unavailable"), reason: z.string() }),
  ]);
}
// The definition file's sibling symbols (#11), the pinned mini-browser's clickable
// rungs — likewise must survive the boundary or in-app navigation never exists.
const symbolNeighborSchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  line: z.number().int().positive(),
});
const symbolNeighborsSchema = z.object({
  path: z.string().min(1),
  symbols: z.array(symbolNeighborSchema),
});
export const symbolInspectionSchema = z.object({
  name: z.string().min(1),
  definition: symbolSectionSchema(symbolDefinitionRowSchema),
  references: symbolSectionSchema(symbolReferenceRowSchema),
  neighbors: symbolNeighborsSchema.optional(),
});

// ── The Spec angle's OpenSpec change (wireframes #9) ─────────────────────────
// The structured model the parser emits, validated at the IPC boundary so the
// live parse-on-open crosses to the renderer as the exact `OpenSpecChange` shape.
// Every node's `source` (artifact + line) rides across — that is what makes a
// Spec-view disposition durable against the real artifact file.
const openSpecSourceSchema = z.object({
  artifact: z.enum(["proposal", "design", "tasks", "spec"]),
  capability: z.string().optional(),
  line: z.number(),
});
const openSpecListItemSchema = z.object({
  lead: z.string().optional(),
  text: z.string(),
  source: openSpecSourceSchema.optional(),
});
const openSpecBlockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("paragraph"),
    text: z.string(),
    source: openSpecSourceSchema.optional(),
  }),
  z.object({
    kind: z.literal("list"),
    ordered: z.boolean(),
    items: z.array(openSpecListItemSchema),
    source: openSpecSourceSchema.optional(),
  }),
  z.object({
    kind: z.literal("code"),
    language: z.string(),
    code: z.string(),
    source: openSpecSourceSchema.optional(),
  }),
  z.object({
    kind: z.literal("table"),
    headers: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    source: openSpecSourceSchema.optional(),
  }),
]);
const openSpecCapabilityNoteSchema = z.object({
  name: z.string(),
  summary: z.string(),
  source: openSpecSourceSchema.optional(),
});
const openSpecProposalSchema = z.object({
  why: z.array(openSpecBlockSchema),
  whatChanges: z.array(openSpecListItemSchema),
  newCapabilities: z.array(openSpecCapabilityNoteSchema),
  modifiedCapabilities: z.array(openSpecCapabilityNoteSchema),
  impact: z.array(z.object({ area: z.string(), detail: z.string() })),
});
const openSpecDesignSchema = z.object({
  sections: z.array(
    z.object({
      id: z.string(),
      level: z.union([z.literal(2), z.literal(3)]),
      heading: z.string(),
      blocks: z.array(openSpecBlockSchema),
      source: openSpecSourceSchema.optional(),
    }),
  ),
});
const openSpecTasksSchema = z.object({
  groups: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      items: z.array(
        z.object({
          text: z.string(),
          status: z.enum(["todo", "done"]),
          source: openSpecSourceSchema.optional(),
        }),
      ),
      total: z.number(),
      done: z.number(),
      source: openSpecSourceSchema.optional(),
    }),
  ),
  total: z.number(),
  done: z.number(),
});
const openSpecScenarioSchema = z.object({
  name: z.string(),
  steps: z.array(z.object({ keyword: z.enum(["given", "when", "then", "and"]), text: z.string() })),
  source: openSpecSourceSchema.optional(),
});
const openSpecSpecDeltaSchema = z.object({
  capability: z.string(),
  groups: z.array(
    z.object({
      operation: z.enum(["added", "modified", "removed", "renamed"]),
      requirements: z.array(
        z.object({
          name: z.string(),
          statement: z.string(),
          scenarios: z.array(openSpecScenarioSchema),
          source: openSpecSourceSchema.optional(),
        }),
      ),
    }),
  ),
  source: openSpecSourceSchema.optional(),
});
const openSpecChangeRawSchema = z.object({
  proposalMd: z.string().optional(),
  designMd: z.string().optional(),
  tasksMd: z.string().optional(),
  specDeltas: z.array(z.object({ capability: z.string(), md: z.string() })),
});
export const openSpecChangeSchema = z.object({
  name: z.string(),
  proposal: openSpecProposalSchema.optional(),
  design: openSpecDesignSchema.optional(),
  tasks: openSpecTasksSchema.optional(),
  specDeltas: z.array(openSpecSpecDeltaSchema),
  raw: openSpecChangeRawSchema.optional(),
});

// ── The Spec view's requirement→hunk coverage (wireframes #9 / R53) ────────────
const openSpecCoverageEdgeSchema = z.object({
  capability: z.string(),
  requirement: z.string(),
  hunks: z.array(z.string()),
  tests: z.number(),
});

export const openSpecCoverageSchema = z.object({
  status: z.enum(["ok", "failed"]),
  edges: z.array(openSpecCoverageEdgeSchema),
});

// ── Settings: the config ladder (wireframe #15, Settings and Setup Plan) ──────
// The settings surface edits a small, HONEST slice of the ladder the plan
// describes: what actually exists as consumed config today. Two axes the plan
// names — SCOPE (which layer a value applies to) and PROVENANCE (which layer it
// resolved from) — are preserved as first-class shapes here, so the surface can
// grow into the full ladder without re-keying. What ships:
//   • global scope: `appearance.scheme` — a personal, app-side preference the
//     renderer consumes as `data-scheme`. Side-effect-free, never a repo write.
//   • repo scope: `visibility` — per project, genuinely consumed by the map
//     visibility switch (writes the repo's Rennet-owned `.rennet/.gitignore`).
//   • repo scope: `promoted` — read-through (the real promotion state), shown with
//     provenance; changing it is the separate explicit promote act, not a toggle.
//   • per-repo guidance — the `.rennet/conventions.json` catalogue the review
//     runners read before every review, shown read-through (the wireframe panel).
// Deliberately NOT invented: execution-mode default, worktree location, and
// harness-selection preferences — none exist as stored/consumed config yet.

/** The appearance scheme: an explicit choice, or `system` (follow the OS). */
export const appearanceSchemeSchema = z.enum(["dark", "light", "system"]);
export type AppearanceScheme = z.infer<typeof appearanceSchemeSchema>;

export const themePackSchema = z.enum([
  "affineur",
  "github",
  "one-dark-pro",
  "dracula",
  "catppuccin-mocha",
]);
export type ThemePack = z.infer<typeof themePackSchema>;

/** How visible a project's derived map is to git (mirrors the adapter's union). */
export const projectVisibilitySchema = z.enum(["local", "git-visible"]);
export type ProjectVisibility = z.infer<typeof projectVisibilitySchema>;

/**
 * A project's execution locus on the wire (add-windows-support): the host OS, or a
 * named WSL distro. The wire form of the execution seam's `Locus`; protocol is
 * its source of truth and infers the `Locus` type from this schema below.
 */
export const locusSchema = z.union([
  z.object({ kind: z.literal("host") }),
  z.object({ kind: z.literal("wsl"), distro: z.string().min(1) }),
]);
export type Locus = z.infer<typeof locusSchema>;

/**
 * The LEGACY (pre-split) global config document, once stored at a single
 * `~/.rennet/config.json` (schema v1). It mixed viewer preferences (appearance,
 * keybindings) with the host's daemon rung (`daemon.listen`) in one blob. B10
 * (#476) split that blob into `client-settings.json` (viewer prefs) and
 * `daemon-settings.json` (the host rung); this schema now exists ONLY as the
 * migration SOURCE — `migrateLegacyGlobalConfig` parses a legacy file with it,
 * then writes the two split documents below. It is never written any more.
 *
 * Every field beyond `version` is optional so an untouched legacy install was a
 * trivially-valid (or absent) `{ version }`; defaults are read-through.
 */
export const globalConfigSchema = z.object({
  // The ONE supported schema version. A future (v2+) or below-current doc fails
  // this literal, so it reads as malformed rather than being silently accepted and
  // re-stamped to v1 — which would strip every field this version does not know
  // and destroy the newer doc's data (the "silent version downgrade" bug). Must
  // equal GLOBAL_CONFIG_VERSION in file-config-store.ts.
  version: z.literal(1),
  appearance: z.object({ scheme: appearanceSchemeSchema.optional() }).optional(),
  /**
   * User keybinding overrides for the command registry (#44), command id → chord
   * token (`mod+e`, `j`) or `null` for an explicit unbind; an absent id keeps the
   * command's catalogue default. Additive-optional: an untouched install stores
   * nothing, an old config parses unchanged, and a set override survives restart.
   * When the settings ladder lands it registers a `keybindings` global-layer key over
   * this same field with no migration.
   */
  keybindings: z.record(z.string(), z.string().nullable()).optional(),
  /**
   * Opt-in bind beyond loopback (issue #380). Absent ⇒ the daemon binds
   * `127.0.0.1` on an ephemeral port exactly as before. `host` names a specific
   * interface to bind (e.g. a Tailscale tailnet address); `port` optionally fixes
   * the port. Append-only and additive: an untouched install stores nothing, and a
   * daemon that predates this key reads its absence as loopback-default.
   */
  daemon: z
    .object({
      listen: z
        .object({
          host: z.string().min(1),
          port: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
  /**
   * The issue-tracker section's GLOBAL rung (#461, B7): the user's confirmed
   * answers on the settings ladder (`builtin < detected < global < repo`).
   * `tokenEnv` names the env var holding the tracker token — the token VALUE
   * itself never enters any store. Additive-optional like every sibling.
   */
  tracker: z
    .object({
      kind: z.enum(["none", "github", "jira", "linear"]).optional(),
      projectKey: z.string().optional(),
      baseUrl: z.string().optional(),
      tokenEnv: z.string().optional(),
    })
    .optional(),
});
export type GlobalConfig = z.infer<typeof globalConfigSchema>;

/**
 * The closed set of onboarding coach marks (C13 · INVENTORY §11 · R55). Nine ids
 * per #487 (`start-review` ruled in live, ahead of `new-chat`). Protocol owns this
 * union so the persisted `coachmarks.seen` slice and app-ui's `coach/marks.ts` share
 * ONE source of truth — protocol imports no Rennet package, app-ui imports protocol,
 * so the enum lives here and the mark model re-exports it. The election ORDER and the
 * teaching copy stay in app-ui; this schema is only the validation set.
 */
export const markIdSchema = z.enum([
  "start-review",
  "new-chat",
  "smart-list",
  "lenses",
  "highlight",
  "fab",
  "verdict",
  "draft",
  "dispatch",
]);
export type MarkId = z.infer<typeof markIdSchema>;

/**
 * The persisted coach-mark slice (C13): which marks the viewer has already seen and
 * whether they skipped the whole tour. Both default empty/false for a fresh install.
 * Written by `settings.setCoachmarks`, surfaced additively in `settings.get`, so the
 * client reads its initial `{ seen, skipAll }` in one call and the state survives reload.
 */
export const coachMarksSchema = z.object({
  seen: z.array(markIdSchema),
  skipAll: z.boolean(),
});
export type CoachMarks = z.infer<typeof coachMarksSchema>;

// ── Model-council review roles on the wire (C16, #485) ───────────────────────
//
// `app-ui` cannot import `@rennet/core`, so the council's role→model assignments
// reach the Review settings surface only through `settings.get` (read) and
// `settings.setRoleAssignment` (write). These schemas are that boundary: the
// wire mirror of core's `resolveReviewRoles` output, each scenario cell carrying
// `{ value, layer }` provenance — an honest-`null` value where a role does not
// run in that scenario (never a fabricated pick, Rule Zero).

/**
 * The council model set (domain `CouncilModel`). `as const satisfies` pins the
 * enum to the domain union, so a value the resolver can emit but the wire cannot
 * carry is a compile error — the wire never silently drops a valid pick.
 */
const COUNCIL_MODELS = [
  "haiku",
  "sonnet-5",
  "opus-4.8",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const satisfies readonly CouncilModel[];
export const councilModelSchema = z.enum(COUNCIL_MODELS);

/** The effort knob (domain `CouncilEffort`); pinned to the union like the models. */
const COUNCIL_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly CouncilEffort[];
export const councilEffortSchema = z.enum(COUNCIL_EFFORTS);

/** One model+effort pick (domain `CouncilPick`). Model + effort only — no harness (#89). */
export const councilPickSchema = z.object({
  model: councilModelSchema,
  effort: councilEffortSchema,
});
export type CouncilPickWire = z.infer<typeof councilPickSchema>;

/**
 * A per-field routing override (domain `CouncilOverridePick`): sets model and/or
 * effort only, harness always derives from the resolved model's provider (#89).
 */
export const councilOverridePickSchema = z.object({
  model: councilModelSchema.optional(),
  effort: councilEffortSchema.optional(),
});

/**
 * Which layer a resolved cell came from, collapsed to what the surface needs:
 * `default` — the council table stands; `override` — a `routing.task` entry won.
 * Maps from core's `ResolutionSource` (`task-override` → `override`, else
 * `default`); the surface derives "is this a default?" straight off this.
 */
export const reviewRoleLayerSchema = z.enum(["default", "override"]);
export type ReviewRoleLayer = z.infer<typeof reviewRoleLayerSchema>;

/**
 * One resolved scenario cell: the pick and its provenance, or an honest-`null`
 * value where the role does not run in this scenario (the Flagged Second Seat in
 * `claudeOnly`/`codexOnly`). `null` is the em-dash the surface renders — never a
 * guessed model.
 */
export const reviewRoleCellSchema = z.object({
  value: councilPickSchema.nullable(),
  layer: reviewRoleLayerSchema,
});
export type ReviewRoleCell = z.infer<typeof reviewRoleCellSchema>;

/**
 * One review role resolved across all three availability scenarios. `id`/`label`/
 * `hint` are the surface copy (from core's `REVIEW_ROLE_CATALOGUE`); `dual` is the
 * `both` scenario. An additive-optional `reviewRoles` on `settings.get` carries an
 * array of these; `settings.setRoleAssignment` returns the re-resolved array.
 */
export const reviewRoleMappingSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  hint: z.string(),
  dual: reviewRoleCellSchema,
  claudeOnly: reviewRoleCellSchema,
  codexOnly: reviewRoleCellSchema,
});
export type ReviewRoleMapping = z.infer<typeof reviewRoleMappingSchema>;

/**
 * The scenario a `settings.setRoleAssignment` edit targets — the wire's per-column
 * name (`dual` is the `both` table). The write maps this back to the core scenario.
 */
export const reviewRoleScenarioSchema = z.enum(["dual", "claudeOnly", "codexOnly"]);
export type ReviewRoleScenario = z.infer<typeof reviewRoleScenarioSchema>;

/**
 * One council job's routing overrides, keyed BY SCENARIO (Rai, 2026-08-28). Each
 * column owns its own cell: an edit in `codexOnly` moves the Codex-only column and
 * nothing else, and clearing it falls back to that scenario's council-table default
 * while the sibling columns keep whatever they hold. Every cell is optional — a job
 * with no override at all carries no entry.
 */
export const councilScenarioOverridesSchema = z.object({
  dual: councilOverridePickSchema.optional(),
  claudeOnly: councilOverridePickSchema.optional(),
  codexOnly: councilOverridePickSchema.optional(),
});
export type CouncilScenarioOverrides = z.infer<typeof councilScenarioOverridesSchema>;

/**
 * Client settings — viewer preferences, stored at `~/.rennet/client-settings.json`
 * (B10 #476). These are personal, app-side choices that live OUTSIDE the config
 * ladder: the appearance scheme the renderer consumes as `data-scheme`, and the
 * command-registry keybinding overrides (#44). Never a repo fact, never written
 * into a working tree. Every field beyond `version` is optional — an untouched
 * install is a trivially-valid (or absent) `{ version }`.
 */
export const clientSettingsSchema = z.object({
  // Supported version literal — a future/below doc reads as malformed, never
  // silently re-stamped (see globalConfigSchema). Must equal CLIENT_SETTINGS_VERSION.
  version: z.literal(1),
  appearance: z
    .object({
      scheme: appearanceSchemeSchema.optional(),
      themePack: themePackSchema.optional(),
    })
    .optional(),
  /** Command-registry keybinding overrides (#44): command id → chord token or `null` to unbind. */
  keybindings: z.record(z.string(), z.string().nullable()).optional(),
  /** Onboarding coach-mark state (C13): seen marks + skip-all. Additive-optional like the rest. */
  coachmarks: coachMarksSchema.optional(),
  /**
   * Model-council routing overrides (C16, #485). `task` keys by council job id →
   * that job's PER-SCENARIO override cells (Rai's 2026-08-28 ruling), each a
   * model+effort pick the resolver layers over that scenario's table default
   * (#89: no harness field). Additive-optional: an untouched install omits it,
   * clearing a job's last cell drops the job entry, and clearing the last job
   * drops the slice. Written by `settings.setRoleAssignment`, one cell per edit.
   */
  routing: z
    .object({ task: z.record(z.string(), councilScenarioOverridesSchema).optional() })
    .optional(),
  welcome: z.object({ completedAt: z.iso.datetime() }).optional(),
  navigation: z
    .object({ lastProjectBySource: z.record(z.string(), z.string().min(1)).optional() })
    .optional(),
});
export type ClientSettings = z.infer<typeof clientSettingsSchema>;

/**
 * Daemon settings — the global ladder rung as it exists ON ITS HOST, stored at
 * `~/.rennet/daemon-settings.json` (B10 #476). Today it carries only the opt-in
 * listener bind (#380); the settings surface lists every paired host's section.
 * Additive-optional exactly as the legacy blob was.
 */
export const daemonSettingsSchema = z.object({
  // Supported version literal — a future/below doc reads as malformed, never
  // silently re-stamped (see globalConfigSchema). Must equal DAEMON_SETTINGS_VERSION.
  version: z.literal(1),
  /**
   * Opt-in bind beyond loopback (#380). Absent ⇒ the daemon binds `127.0.0.1` on
   * an ephemeral port. `host` names an interface (e.g. a Tailscale address); `port`
   * optionally fixes the port.
   */
  daemon: z
    .object({
      listen: z
        .object({
          host: z.string().min(1),
          port: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
  /**
   * The issue-tracker section's GLOBAL rung (#461, B7). This is a host fact —
   * the global rung of the settings ladder lives on the daemon's host — so the
   * legacy blob's `tracker` migrates HERE, not into client settings. `tokenEnv`
   * names the env var holding the token; the token VALUE never enters any store.
   */
  tracker: z
    .object({
      kind: z.enum(["none", "github", "jira", "linear"]).optional(),
      projectKey: z.string().optional(),
      baseUrl: z.string().optional(),
      tokenEnv: z.string().optional(),
    })
    .optional(),
  /**
   * Per-host daemon memory (C17), keyed by the host's `source`. Two independent facts, each
   * additive-optional, so an entry may carry either or both:
   *
   *  • `lastSeenVersion` (reconciliation 4) — the version a host's daemon actually answered
   *    with, so a host that later goes dark reads "last seen running v…" instead of blank
   *    chrome. Written ONLY from a real answer; a host that has never answered has no entry.
   *  • `disabledHarnesses` (cluster 3.2) — the agents the viewer has RULED OUT of reviews on
   *    that host. A decision, not a detection: it survives reload, and it is scoped to the
   *    host, so ruling Codex out on this machine leaves it running on a WSL distro. Nothing
   *    here claims a harness exists — an id disabled on a host with no such harness simply
   *    matches no detected row.
   *  • `disabledForges` (amendment A) — the same decision for the host's forge CLIs, so the
   *    Source Control row's toggle keeps what it was told instead of resetting on reload.
   *    Same rules: a decision, host-scoped, and it claims nothing about what is installed.
   */
  hosts: z
    .record(
      z.string(),
      z.object({
        lastSeenVersion: z.string().min(1).optional(),
        disabledHarnesses: z.array(z.string().min(1)).optional(),
        disabledForges: z.array(z.string().min(1)).optional(),
      }),
    )
    .optional(),
});
export type DaemonSettings = z.infer<typeof daemonSettingsSchema>;

/**
 * Which ladder layer a resolved value came from. Precedence (lowest→highest):
 * `builtin` < `detected` < `global` < `repo`. `detected` is the environment-derived
 * rung (today: execution-locus auto-detection) — a machine guess any explicit user
 * choice beats. The single source of precedence is `LAYER_ORDER` in `@rennet/core`;
 * this enum only names the members, it does not order them.
 */
export const settingsLayerSchema = z.enum(["builtin", "detected", "global", "repo"]);
export type SettingsLayer = z.infer<typeof settingsLayerSchema>;

/**
 * A resolved setting carries WHERE it came from, not just the value — provenance
 * is the return type, not a feature (Settings and Setup Plan §1.4). `contributions`
 * lists every layer that offered a value, lowest-first, flagging the effective one.
 */
export const resolvedProvenanceSchema = z.object({
  layer: settingsLayerSchema,
  contributions: z.array(
    z.object({ layer: settingsLayerSchema, value: z.string(), effective: z.boolean() }),
  ),
});
export type ResolvedProvenance = z.infer<typeof resolvedProvenanceSchema>;

/** One resolved string setting: its effective value and the layer that supplied it.
 *  An empty `value` at the `builtin` layer is the honest "nobody has set this". */
const layeredStringSchema = z.object({ value: z.string(), layer: settingsLayerSchema });

/**
 * The per-project preferences the Projects surface reads and writes (C18 group A),
 * each resolved off the settings ladder. `tracker` is the issue-tracker section
 * (#461) at project scope — the one that reaches RETRIEVAL, since the same repo rung
 * is what `resolveTrackerConfig` folds over the host's global answer. `guidance` is
 * the repo's `.rennet/conventions.json` rules as the surface edits them: statement +
 * severity (the authored rationale stays in the file and is never rewritten here).
 */
export const settingsProjectPrefsSchema = z.object({
  glyph: layeredStringSchema,
  worktreeRoot: layeredStringSchema,
  worktreePattern: layeredStringSchema,
  tracker: z.object({
    kind: layeredStringSchema,
    projectKey: layeredStringSchema,
    baseUrl: layeredStringSchema,
    tokenEnv: layeredStringSchema,
  }),
  guidance: z.array(
    z.object({
      /** The catalogue's stable author-facing id, when the rule has one. Carried so an
       *  EDIT addresses the rule by identity — retyping its statement then keeps the
       *  rationale and anti-pattern the author wrote. Never model-facing. */
      id: z.string().min(1).optional(),
      rule: z.string().min(1),
      severity: findingSeveritySchema,
    }),
  ),
});
export type SettingsProjectPrefs = z.infer<typeof settingsProjectPrefsSchema>;

/**
 * One repo row on the settings ladder — its real, resolved repo-scope config. A
 * single-repo project contributes ONE row; a workspace contributes one row PER
 * included repo (each keyed by its own git top level), so a workspace's other
 * repos are reachable, not collapsed onto the first. `repoPath` is the canonical
 * git top-level path that addresses the row for reads and writes.
 */
export const settingsProjectSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    /** The canonical git top-level path of THIS repo — the row's stable address. */
    repoPath: z.string().min(1),
    /** The resolved effective visibility, with the layer it came from. */
    visibility: projectVisibilitySchema,
    visibilityProvenance: resolvedProvenanceSchema,
    /** The resolved effective promotion state, with the layer it came from. */
    promoted: z.boolean(),
    promotedProvenance: resolvedProvenanceSchema,
    /**
     * The project's execution locus — a DETECTED FACT, not a knob (#476). Auto-detected
     * from `repoPath` (a `\\wsl$` root ⇒ that distro, else host); Rennet SHOWS where the
     * harness runs, it does not offer to choose it. No repo-layer override exists.
     */
    locus: locusSchema,
    /**
     * The provenance for the locus — always the `detected` layer now that locus is a
     * detected fact (#476). Computed fresh per read, never persisted.
     */
    locusProvenance: resolvedProvenanceSchema.optional(),
    /**
     * The repo's `config.json` exists but is malformed (or carries an invalid
     * value). The row then shows builtin defaults and REFUSES edits, so a write can
     * never overwrite bytes we could not parse (Rule 75). Absent config ⇒ `false`.
     */
    configMalformed: z.boolean(),
    /**
     * The per-project preferences the Projects surface edits (C18 group A), each
     * RESOLVED off the settings ladder with the layer it came from — the same
     * `builtin < detected < global < repo` law as visibility, so a project's own
     * answer beats the host's and a `builtin` layer with an empty value means the
     * project has simply never set one (the client then shows ITS default).
     * Additive-optional: an engine that does not serve them omits the field, and
     * the client keeps its honest empty state rather than inventing values.
     */
    prefs: settingsProjectPrefsSchema.optional(),
  })
  .transform((project) => {
    const value = project.locus.kind === "host" ? "host" : `WSL · ${project.locus.distro}`;
    return {
      ...project,
      locusProvenance: project.locusProvenance ?? {
        layer: "detected" as const,
        contributions: [{ layer: "detected" as const, value, effective: true }],
      },
    };
  });
export type SettingsProject = z.infer<typeof settingsProjectSchema>;

/**
 * One daemon host's section on the settings surface (#476). Rennet runs a daemon per
 * host; the surface lists EVERY host a project routes to, not just the local one. The
 * `isLocal` host is the one this daemon runs on — its `listen` rung is read from this
 * host's `daemon-settings.json`. A remote or in-WSL host keeps its rung on THAT host, so
 * `listen` is populated only for the local section; a non-local host is listed by
 * `source`/`label` so it is visible even though its settings are not locally readable.
 */
export const daemonHostSectionSchema = z.object({
  /** `local`, `wsl:<distro>`, or `remote:<deviceId>` — the routing address of the host. */
  source: sourceSchema,
  /** Human label for the host (`This machine`, `WSL · Ubuntu`, `Remote · <id>`). */
  label: z.string().min(1),
  /** True for the host this daemon runs on — the only section whose `listen` is locally readable. */
  isLocal: z.boolean(),
  /**
   * The host's daemon-settings listener rung (#380), present only on the local section
   * (a remote/WSL host's rung lives on that host). Absent ⇒ loopback default there.
   */
  listen: z
    .object({ host: z.string().min(1), port: z.number().int().nonnegative().optional() })
    .optional(),
});
export type DaemonHostSection = z.infer<typeof daemonHostSectionSchema>;

/**
 * One session row in the sidebar (C18) — the wire shape `session.list` serves and every
 * session mutation echoes. Projected from the persisted `SessionModel`, so every field is
 * a FACT of that record: `title` is the reviewer's own rename or the claimed branch;
 * `target` is `your-pr` when the claim carries a PR number and `your-branch` otherwise
 * (a teammate's PR is not knowable from the session record, so it is never guessed);
 * `targetState` and unread activity are likewise absent rather than invented.
 */
export const sidebarSessionSchema = z.object({
  id: z.string().min(1),
  /** The project this session belongs to — the sidebar's grouping key. */
  projectId: z.string().min(1),
  /** The reviewer's chosen title, else the claimed branch, else "New review". */
  title: z.string().min(1),
  target: z.enum(["your-branch", "your-pr"]),
  /**
   * Where the target stands (needs-you / merged / reviewed) and whether the row carries
   * unread orchestrator activity. The session record proves NEITHER today, so the host
   * leaves both absent and the row renders without them — the shape carries them so the
   * surface stays structurally able to show them the moment a source exists, never so a
   * value can be guessed.
   */
  targetState: z.enum(["needs-you", "merged", "reviewed"]).optional(),
  unread: z.boolean().optional(),
  /** Pinned to the top of its project group; absent reads as unpinned. */
  pinned: z.boolean().optional(),
  /** Archived (soft-deleted, the only release); absent reads as live. */
  archived: z.boolean().optional(),
  /** When the session was minted (epoch ms) — the client renders the relative line. */
  createdAt: z.number(),
});
export type SidebarSession = z.infer<typeof sidebarSessionSchema>;

/**
 * One host's daemon status (C17, #485) — the wire shape `daemon.status` returns, which the
 * client folds into the host card's `DaemonInfo`. An UNREACHABLE host INVENTS NOTHING: it
 * carries `reachable: false` and NO `version`, only the `lastSeenVersion` it actually
 * answered with before (absent for a host that has never answered). `updateAvailable` is
 * present only when BOTH the running version and the latest known version are real, so a
 * host with no update mechanism withholds the flag rather than faking one.
 */
export const daemonHostStatusSchema = z.discriminatedUnion("reachable", [
  z.object({
    /** The host this status is for — the same `source` key `daemonHosts` enumerates. */
    source: sourceSchema,
    /** The host's daemon answered just now. */
    reachable: z.literal(true),
    /** The RUNNING daemon version — omitted when the host answered but could not name it. */
    version: z.string().optional(),
    /** The running version is older than the version this host could be updated TO. Absent ⇒
     *  not knowable, or this host has no update mechanism at all. */
    updateAvailable: z.boolean().optional(),
  }),
  z.object({
    source: sourceSchema,
    reachable: z.literal(false),
    /** The version this host was last seen running; present only when it answered before. */
    lastSeenVersion: z.string().optional(),
  }),
]);
export type DaemonHostStatus = z.infer<typeof daemonHostStatusSchema>;

/**
 * One host's detected coding agents (C17 cluster 3, #485) — the wire shape `harness.hosts`
 * returns, keyed by the same `source` `daemonHosts` enumerates. Detection is SERVER-side:
 * the daemon this is dispatched to asks each host the only way it CAN be asked, so the
 * client never fans out over connections it does not have.
 *
 * `asked` is the honesty flag and the whole point of the shape, so it DISCRIMINATES the union:
 * a host this daemon has no way to interrogate (a paired device that dials US; a distro
 * `wsl.exe` cannot enter) reads `asked: false` and structurally cannot carry rows — an HONEST
 * ABSENCE, distinct from `asked: true` with no rows, which is the real claim "that host has no
 * coding agents installed". The local set is never copied onto a host it was not observed on.
 */
export const hostHarnessSchema = detectedHarnessSchema.extend({
  /**
   * The viewer has NOT ruled this agent out of reviews on this host (C17 cluster 3.2). A
   * persisted per-host decision, so a ruled-out agent stays ruled out across reload, and
   * ruling it out here leaves it running everywhere else. Detection is unaffected: a
   * disabled agent is still detected and still shown, with its toggle off.
   */
  enabled: z.boolean(),
});
export type HostHarness = z.infer<typeof hostHarnessSchema>;

/**
 * The forge CLI ids the viewer has RULED OUT on this host (amendment A) — the served READ that
 * makes the Source Control row's toggle real. It rides this per-host entry because the ruling
 * lives on the same daemon-settings record as `disabledHarnesses` and the surface already makes
 * this one round trip; forge DETECTION is separate (`forge.hosts`), so this is a decision list,
 * never a claim that any of those CLIs are installed. It is valid on an UNASKED host too — a
 * decision survives a machine Rennet cannot currently reach. Additive-optional: an engine that
 * omits it has ruled nothing out.
 */
const disabledForgesField = z.array(z.string().min(1)).optional();

export const harnessHostDetectionSchema = z.discriminatedUnion("asked", [
  z.object({
    /** The host these harnesses were detected on — the `source` key `daemonHosts` enumerates. */
    source: sourceSchema,
    /** This daemon interrogated that host; `detected` is its real answer, empty or not. */
    asked: z.literal(true),
    /** Exactly the harnesses observed ON that host. Empty means "asked, none installed". */
    detected: z.array(hostHarnessSchema),
    disabledForges: disabledForgesField,
  }),
  z.object({
    source: sourceSchema,
    /** This daemon could NOT interrogate that host — so it reports no rows, and the empty
     *  tuple below is the only list it is allowed to carry. Nothing is claimed. */
    asked: z.literal(false),
    detected: z.tuple([]),
    disabledForges: disabledForgesField,
  }),
]);
export type HarnessHostDetection = z.infer<typeof harnessHostDetectionSchema>;

/**
 * One host's detected forge (source-control) CLIs (C17 amendment B) — the wire shape
 * `forge.hosts` returns, the exact mirror of `harness.hosts` for the Source Control section.
 * `forge.detect` answers for ONE daemon, so keying its rows anywhere else would copy this
 * machine's `gh` onto a host it was never observed on; this read asks each host the only way
 * it CAN be asked, so a WSL distro with its own `gh` shows its own.
 *
 * `asked` discriminates this union exactly as it does the harness read: a host this daemon
 * cannot interrogate reads `asked: false` and cannot carry rows at all — an honest absence,
 * distinct from `asked: true` with no rows ("that host has no forge CLI installed").
 */
export const forgeHostDetectionSchema = z.discriminatedUnion("asked", [
  z.object({
    /** The host these forge CLIs were detected on — the `source` key `daemonHosts` enumerates. */
    source: sourceSchema,
    /** This daemon interrogated that host; `detected` is its real answer, empty or not. */
    asked: z.literal(true),
    /** Exactly the forge CLIs observed ON that host. Empty means "asked, none installed". */
    detected: z.array(detectedForgeSchema),
  }),
  z.object({
    source: sourceSchema,
    /** Could NOT be interrogated — no rows are expressible, so none can be implied. */
    asked: z.literal(false),
    detected: z.tuple([]),
  }),
]);
export type ForgeHostDetection = z.infer<typeof forgeHostDetectionSchema>;

/** The whole settings view: the global layer plus every repo's repo layer. */
export const settingsViewSchema = z.object({
  /** The resolved effective scheme (builtin `system`, overridden by global). */
  scheme: appearanceSchemeSchema,
  schemeProvenance: resolvedProvenanceSchema,
  /**
   * The global `~/.rennet/config.json` exists but is malformed. Appearance then
   * shows the builtin default and the control REFUSES to write, so an edit can
   * never overwrite unparseable bytes (Rule 75).
   */
  appearanceMalformed: z.boolean(),
  themePack: themePackSchema.optional(),
  welcome: z.object({ completedAt: z.iso.datetime() }).optional(),
  navigation: z
    .object({ lastProjectBySource: z.record(z.string(), z.string().min(1)).optional() })
    .optional(),
  projects: z.array(settingsProjectSchema),
  /**
   * The stored keybinding-override map (#44), verbatim from the global config —
   * command id → chord token or `null` (explicit unbind). Additive: an untouched
   * install omits it, old `settings.get` callers ignore it. The renderer overlays
   * these on the catalogue defaults for dispatch, display, and conflict detection.
   */
  keybindings: z.record(z.string(), z.string().nullable()).optional(),
  /**
   * The persisted onboarding coach-mark state (C13), verbatim from client settings —
   * seen marks + skip-all. Additive-optional: an untouched install omits it (the client
   * reads it as empty/false), old callers ignore it. The coach provider seeds its store
   * from this in one `settings.get` call, so skip-all and seen survive a reload.
   */
  coachmarks: coachMarksSchema.optional(),
  /**
   * Every daemon host the surface covers (#476), local section FIRST. Each carries its
   * `daemon-settings` rung where locally readable (the local host); a remote or in-WSL
   * host is listed so it is visible even though its rung lives on that host. Enumerated
   * from the local host plus every distinct `source` the projects route to. Additive-
   * optional: an old `settings.get` caller ignores it, an untouched engine may omit it.
   */
  daemonHosts: z.array(daemonHostSectionSchema).optional(),
  /**
   * The model-council review-role mappings (C16, #485) — the eight roles, each
   * resolved across `dual`/`claudeOnly`/`codexOnly` with `{ value, layer }`
   * provenance. The READ rides `settings.get` (additive-optional, like `keybindings`/
   * `coachmarks`/`daemonHosts` — one fewer command). Honest-present: the council
   * tables are static, so this carries the eight roles at their defaults even with
   * no override set; a role that does not run in a scenario carries a `null` cell.
   */
  reviewRoles: z.array(reviewRoleMappingSchema).optional(),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

/** The outcome of a repo-visibility write — distinguishes a real apply from a no-op. */
export const setRepoVisibilityOutcomeSchema = z.object({
  /**
   * `applied` — the switch ran (`changed`/`gitignorePath` describe the repo write).
   * `unresolved` — the project/checkout could not be resolved; NOTHING was written.
   * `malformed` — the repo config is malformed; the edit was REFUSED to protect it.
   */
  status: z.enum(["applied", "unresolved", "malformed"]),
  visibility: projectVisibilitySchema,
  changed: z.boolean(),
  gitignorePath: z.string(),
});
export type SetRepoVisibilityOutcome = z.infer<typeof setRepoVisibilityOutcomeSchema>;

/**
 * The repo-scoped settings keys that can be reset-to-inherit and pinned-at-repo.
 * Only `visibility` (the gitignore switch) has a repo-layer write path now — execution
 * locus was demoted to a detected fact, not a stored/selectable ladder value (#476).
 * Promotion is read-through, and appearance is a global-layer key (reset via
 * `setAppearance` with a null scheme).
 */
export const settingsRepoValueKeySchema = z.enum(["visibility"]);
export type SettingsRepoValueKey = z.infer<typeof settingsRepoValueKeySchema>;

/**
 * The outcome of a Reset (clear the repo-layer entry, fall back down the ladder) or
 * Pin (write the current effective value at the repo layer). `applied` carries the
 * FRESHLY re-resolved row so the surface re-renders the resolver's own answer; a
 * `status` other than `applied` means NOTHING was written (an unresolved checkout or
 * a refused-because-malformed config, Rule 75) and `project` is null.
 */
export const settingsRepoWriteOutcomeSchema = z.object({
  status: z.enum(["applied", "unresolved", "malformed"]),
  key: settingsRepoValueKeySchema,
  project: settingsProjectSchema.nullable(),
});
export type SettingsRepoWriteOutcome = z.infer<typeof settingsRepoWriteOutcomeSchema>;

/**
 * The per-project preference a `settings.setProjectValue` write addresses (C18 group
 * A) — the repo-rung keys the Projects surface edits. `visibility` is NOT here: it
 * runs the gitignore switch and keeps its own command. Each key maps to one
 * `SETTINGS_REGISTRY` declaration, so the write validates on exactly the terms the
 * resolver reads by.
 */
export const settingsProjectValueKeySchema = z.enum([
  "glyph",
  "worktreeRoot",
  "worktreePattern",
  "trackerKind",
  "trackerProjectKey",
  "trackerBaseUrl",
  "trackerTokenEnv",
]);
export type SettingsProjectValueKey = z.infer<typeof settingsProjectValueKeySchema>;

/**
 * The outcome of a per-project preference write — the same three states, and the same
 * honesty, as {@link settingsRepoWriteOutcomeSchema}: `applied` carries the FRESHLY
 * re-resolved row (the resolver's own answer after the write), and any other status
 * means NOTHING was written and `project` is null.
 */
export const settingsProjectWriteOutcomeSchema = z.object({
  status: z.enum(["applied", "unresolved", "malformed"]),
  key: settingsProjectValueKeySchema,
  project: settingsProjectSchema.nullable(),
});
export type SettingsProjectWriteOutcome = z.infer<typeof settingsProjectWriteOutcomeSchema>;

/** One convention rule shown in the per-repo guidance panel (never model-facing). */
export const settingsConventionRuleSchema = z.object({
  convention: z.string().min(1),
  rationale: z.string().min(1),
  severity: findingSeveritySchema,
  antiPattern: z.string().optional(),
});

/** Why no guidance catalogue was produced, or `null` when one was. */
export const conventionLoadReasonSchema = z.enum([
  "absent",
  "unreadable",
  "empty",
  "no-valid-rules",
]);

/** The per-repo guidance catalogue (`.rennet/conventions.json`) for one project. */
export const settingsGuidanceSchema = z.object({
  rules: z.array(settingsConventionRuleSchema),
  /** The typed reason the catalogue is empty, or `null` when rules are present. */
  reason: conventionLoadReasonSchema.nullable(),
  /** How many rules were dropped as malformed (itemwise honest degradation). */
  dropped: z.number().int().nonnegative(),
});
export type SettingsGuidance = z.infer<typeof settingsGuidanceSchema>;

// ── The review→agent handoff loop schemas (issue #18) ──────────────────────────
// The review->agent handoff wire shapes. The OUTPUT schemas are annotated
// `z.ZodType<T>` so a field added to a type that is NOT added here fails the build
// (the IPC-strip guard: an optional field silently dropped at the boundary is the
// recurring #242 defect). The disposition INPUT schema is a plain object so its
// `z.input` type infers concretely (a `z.ZodType<T>` annotation defaults the Input
// param to `unknown`, which would type the command input's `dispositions` as
// `unknown[]`). The bundle's `z.ZodType<HandoffBundle>` annotation still catches a
// task-shape drift through `tasks: z.array(handoffTaskSchema)`.
export const handoffDispositionSchema = z.object({
  path: z.string().min(1),
  type: dispositionTypeSchema,
  body: z.string(),
  span: anchorSpanSchema.optional(),
  side: anchorSideSchema.optional(),
});

const handoffTaskSchema = z.object({
  path: z.string().min(1),
  type: dispositionTypeSchema,
  instruction: z.string(),
  span: anchorSpanSchema.optional(),
  side: anchorSideSchema.optional(),
  context: z.string(),
});

export const handoffBundleSchema = z.object({
  reviewId: z.string().min(1),
  patchsetId: z.string().min(1),
  tasks: z.array(handoffTaskSchema),
  prompt: z.string(),
  digest: z.string().min(1),
});

export const handoffDisclosureSchema = z.object({
  harness: z.string().min(1),
  model: z.string().optional(),
  taskCount: z.number().int().nonnegative(),
  writeEnabled: z.literal(true),
  editsWorkingTree: z.literal(true),
  summary: z.string(),
});

const handoffRunResultSchema = z.object({
  review: reviewSchema,
  turnDiff: z.string(),
  filesTouched: z.array(z.string()),
  carriedForward: z.number().int().nonnegative(),
  orphaned: z.number().int().nonnegative(),
});

/**
 * The `review.handoff.run` outcome. A discriminated union so every non-success is
 * an HONEST, distinct state the renderer can render, never a fabricated result:
 *   • `ran`         — the write turn completed and a new patchset was captured.
 *   • `refused`     — the composed bundle handed to the run did not match its own
 *                     digest/prompt or was composed against a different review/patchset
 *                     than is active now (issue #72). Integrity, not a consent gate: the
 *                     honest outcome is re-compose, never run an order nobody composed.
 *   • `unavailable` — no coding harness is installed to run the write session.
 *   • `failed`      — the write turn ran but did not complete.
 */
export const handoffRunOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ran"), result: handoffRunResultSchema }),
  z.object({ status: z.literal("refused"), reason: z.string() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
  // A failed turn carries the files the agent changed BEFORE erroring (Codex F4), so a
  // partial mutation on disk is surfaced to the reviewer rather than hidden.
  z.object({
    status: z.literal("failed"),
    reason: z.string(),
    filesTouched: z.array(z.string()),
  }),
]);
export type HandoffRunOutput = z.infer<typeof handoffRunOutputSchema>;

// ── Handoff-bundle composition schemas (issue #72, M24) ────────────────────────
// The output shapes are annotated `z.ZodType<T>` for the IPC-strip guard; the input
// (`handoffDispositionSchema`, reused from #18) is the plain-object one.
const composableAskSchema = z.object({
  path: z.string().min(1),
  type: dispositionTypeSchema,
  instruction: z.string(),
  span: anchorSpanSchema.optional(),
  side: anchorSideSchema.optional(),
  context: z.string(),
  id: z.string().min(1),
});

const composedTaskSchema = z.object({
  title: z.string(),
  sourceDispositions: z.array(z.string()),
  asks: z.array(composableAskSchema),
});

export const composedHandoffBundleSchema = z.object({
  reviewId: z.string().min(1),
  patchsetId: z.string().min(1),
  tasks: z.array(composedTaskSchema),
  prompt: z.string(),
  digest: z.string().min(1),
  composed: z.boolean(),
  traceMap: z.record(z.string(), z.number().int().nonnegative()),
});

/**
 * A paired remote device as the settings panel and `rennet devices` show it
 * (issue #380). The bearer token is NEVER on this shape — it lives only as a
 * SHA-256 hash in `~/.rennet/devices.json`, shown once at pairing time. This is
 * the safe, listable projection of a device row.
 */
export const pairedDeviceSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type PairedDevice = z.infer<typeof pairedDeviceSchema>;

// ── Wire-schema types (protocol is the source of truth) ────────────────────────
// Each type is INFERRED from its Zod schema above, so the schema cannot drift from
// the type it validates. JSDoc carried from the former hand-written declarations.
export type RepositoryProvenance = z.infer<typeof repositoryProvenanceSchema>;
/**
 * An immutable snapshot of one spec / openspec document relevant to the change,
 * frozen onto the patchset at capture time (#136). `digest` is a sha256 over the
 * FULL captured document; `content` is the document text INLINED when it is under
 * the inlining cap, and absent (digest-only) when it was too large. Captured from
 * the committed content at the reviewed head OID (or the working-tree content for
 * a local review), so the spec view renders what the change actually shipped
 * against rather than a later-edited version of the same file.
 */
export type PatchsetSpecSnapshot = z.infer<typeof patchsetSpecSnapshotSchema>;
/**
 * The change's stated intent, captured WITH the patchset and immutable for its
 * lifetime (#136). It is the raw material the Decisions lens, the hypothesis pass,
 * and the spec view reason over — widening the live `ReviewIntent` / `DecisionIntent`
 * seam the runners already consume with the additional surface provenance and the
 * frozen spec set. A remote head update mints a NEW patchset (R28); it never
 * rewrites the intent frozen on the prior one.
 *
 * Honest absence is first-class: `prBodyAbsent` marks "there was no PR body surface
 * at all" (a working-tree / no-PR review), so a consumer never mistakes an empty
 * string for the stated intent. A no-PR review captures the available surface
 * (`commitSubjects`) instead of fabricating a body.
 */
export type PatchsetIntent = z.infer<typeof patchsetIntentSchema>;
export type Patchset = z.infer<typeof patchsetSchema>;
/**
 * A reviewer action taken against an anchor. In this model a file/chunk is
 * "read" iff it carries a disposition: reading is an action, never scroll/dwell.
 */
export type Disposition = z.infer<typeof dispositionSchema>;
/** One staged ask and what the returned patchset did to it (issue #73). */
export type DeltaAskAccount = z.infer<typeof deltaAskAccountSchema>;
/**
 * One change the successor made BEYOND every ask, at HUNK grain (issue #73 wave 3). A
 * new hunk (its changed-line content appears in no prior hunk for the file or its rename
 * source) that no ask covers. `span` is the hunk's file line range — the new-file range,
 * or the OLD-file range for a pure-deletion hunk (with `side: "deletions"`). `bucket`
 * separates a hunk in a file NO ask targeted (`"unasked-file"`, the loud scope-creep) from
 * one inside an asked file but outside every asked span (`"asked-file"`). BOTH are honest
 * narration of work the agent was allowed to do — never a violation, warning, or gate.
 * `excerpt` is the first changed line, bounded — the human hook to the change.
 */
export type DeltaBeyondHunk = z.infer<typeof deltaBeyondHunkSchema>;
/**
 * The delta re-review account (issue #73): a deterministic, model-free record of what
 * a returned patchset did relative to the staged asks. `asks` classifies every staged
 * ask (addressed / partially-addressed / untouched); `beyondAsks` lists the paths the
 * successor changed that NO ask targeted — the scope-creep the reviewer must see. The
 * partition is total by construction: every changed path is either an ask's path or a
 * beyond-asks path, never silently dropped. This structured account is complete on its
 * own; optional light-tier prose (M25) only rephrases it and adds no fact.
 *
 * `beyondAskHunks` (issue #73 wave 3) is the HUNK-grain detail layered on top: the exact
 * beyond-ask hunks, including one inside an asked file that path grain cannot see. It is
 * ABSENT on a legacy account computed before hunk grain existed (⇒ render path grain
 * only) and an EMPTY ARRAY when hunk grain WAS computed and found nothing beyond — the
 * two are distinct, so the panel never shows precision it did not compute.
 */
export type SuccessorAccount = z.infer<typeof successorAccountSchema>;
export type Review = z.infer<typeof reviewSchema>;
/**
 * One evidence chip a decision is drawn from (issue #137). The Decisions lens
 * shows the raw material a decision was discerned from — a spec line, a passage of
 * the PR body, or a hunk of the diff — so a reviewer can judge the decision at its
 * source. `kind` is the source class; `label` is the short chip caption (e.g.
 * "spec §3.2", "PR body", "store.ts +12"); `detail` is the quoted material.
 *
 * NOTE (issue #137, load-bearing): these three kinds name the SOURCE of evidence,
 * never a verdict about the decision. There is deliberately no evidenced /
 * mechanical / contestable triage bucket here — judging a decision is the
 * reviewer's job, not a pre-chewed classification's.
 */
export type DecisionEvidence = {
  kind: "spec" | "pr-body" | "hunk";
  label: string;
  detail: string;
};
/**
 * A decision's reconstructed rationale (issue #137). `reconstructed` is a literal
 * `true`: the TYPE SYSTEM enforces that every `why` is marked reconstructed, so an
 * inferred rationale can never be presented as a stated fact. A decision with no
 * discernible rationale simply has no `why` (it still renders — title + evidence —
 * rather than inventing one).
 */
export type DecisionWhy = { reconstructed: true; text: string };
export type ElementDiff = {
  path: string;
  paths: string[];
  diff: string;
  hunkOccurrences: RenderedHunkOccurrence[][];
};
/**
 * An optional code citation on a narration entry: a `rennet:` code anchor plus the
 * byte-exact quote it stands on. The generic validator walk (V006) byte-verifies
 * every `{anchor, quote}` pair against the resolved span, so a fabricated quote is
 * rejected. Absent when a narration cites no specific code.
 */
export type NarrationEvidence = { anchor: string; quote: string };
/** One model's answer in a disagreement, labelled by the model that gave it. */
export type FindingModelAnswer = z.infer<typeof findingModelAnswerSchema>;
/**
 * The adjudication chip on a `disagree` agreement (issue #41). `verdict` is the
 * three-way judgement; `evidence` is the one-line reason (the code that supports or
 * contradicts, or WHY it was insufficient); `adjudicatedBy` is the resolved seat's
 * honest label (the model/harness the council routed the adjudication job to), so
 * provenance cannot lie. Additive-optional on the disagree arm — an old `finding`
 * doc without it validates unchanged and an old renderer ignores it.
 */
export type FindingAdjudication = z.infer<typeof findingAdjudicationSchema>;
/**
 * The verification chip attached to a surfaced finding (issue #179). ADDITIVE and
 * OPTIONAL on `FindingElement`: a finding without it validates and renders exactly
 * as before this change, and existing `finding` documents remain admissible
 * unchanged. `evidence` is the one-line "we dug into it and found Y" for a
 * `reproduced` finding, and the honest caveat for an `inconclusive` one — which
 * also carries WHY it was not established (genuine verifier uncertainty, the
 * per-review verification cap, an exhausted budget, or unreadable code). A
 * `refuted` finding never carries this, because it never surfaces.
 */
export type FindingVerification = z.infer<typeof findingVerificationSchema>;
/**
 * The canvas-facing shape of one finding: an id, the anchor it is about, a short
 * summary, its severity, and its agreement state. The `finding` doc body (issue
 * #32) is an ADDITIVE superset — the lens placement only needs these fields.
 */
export type FindingElement = z.infer<typeof findingElementSchema>;
/**
 * How the flagged review was produced (issue #41, dual-model). It rides the
 * `ok` variant as an ADDITIVE optional field, so a single-seat review (today's
 * default) omits it and nothing downstream changes. When two provider seats run,
 * `seats` names both labels in order; `secondSeatUnavailable` is the HONEST
 * degradation marker — set only when a second seat was requested (deep review,
 * two providers installed) but was unavailable or errored, so the lens can show a
 * "single provider — no second opinion" badge rather than fabricate a concurrence.
 * It NEVER carries a merged verdict — disagreement lives in each finding's
 * `agreement`, this only records WHO ran.
 */
export type DualReviewNote = z.infer<typeof dualReviewNoteSchema>;
/**
 * The deterministic predicted-risk cross-check (issue #181): each hypothesised
 * risk is `confirmed` (a finding addresses it — a predicted-and-found signal) or
 * `open` (no finding addresses it — surfaced to the human as a manual check they
 * must make themselves, NEVER silently dropped). Runs no model turn.
 */
export type RiskCrossCheck = z.infer<typeof riskCrossCheckSchema>;
/** One failing CI check classified against the reviewed changeset. */
export type CiFailure = z.infer<typeof ciFailureSchema>;
/**
 * The pass's extracted, ready-to-inject hypothesis: the committed body plus
 * whether the repo context was present when it was formed (an honest degradation
 * marker, never a fabricated snapshot). This is what the lens runners consume as
 * disconfirmation criteria and what the reading-frame derivation renders.
 */
export type ReviewHypothesis = z.infer<typeof reviewHypothesisSchema>;
/**
 * One screenshot the verify-ui turn captured (issue #183). `path` is RELATIVE to
 * the review's evidence directory and includes the completed patchset/run namespace;
 * `label` is the human caption ("mobile viewport",
 * "focus ring"). The bytes never ride this shape — the renderer reads them on
 * demand via the `review.uiEvidence` command, so the review snapshot and IPC
 * payload stay small.
 */
export type UiScreenshot = z.infer<typeof uiScreenshotSchema>;
/**
 * One model's answer to a review question, labelled by the model that gave it
 * (e.g. "Orchestrator · Claude", "codex"). The label is what the side-by-side
 * cards show, so the reviewer always knows WHO said WHAT.
 */
export type AskAnswer = z.infer<typeof askAnswerSchema>;
/**
 * The result of one review question. `primary` is ALWAYS the orchestrator's
 * answer; `secondOpinion` is Codex's answer and is present ONLY in "both" mode.
 * There is deliberately NO third field: the shape cannot express a synthesized or
 * merged answer, so "no synthesis, ever" holds by construction rather than by
 * discipline. When both are present they render side by side, labelled, and the
 * reviewer reconciles any disagreement themselves.
 */
export type AskReviewResult = z.infer<typeof askReviewResultSchema>;
/**
 * One churn item inside a noise group: the anchor it lives at and a short plain
 * detail. `deviates` marks a line that BREAKS its group's pattern — the totality
 * floor's deviating-line ejection: it is never suppressed inside the group, it
 * ejects into normal review (the derivation lifts it out; nothing is dropped).
 */
export type NoiseItem = z.infer<typeof noiseItemSchema>;
/**
 * The canvas-facing shape of one noise group: an id, its category, the plain-speech
 * one-line summary the collapsed row shows, how it was judged (rule vs noise job),
 * and the churn items it collects (kept INSPECTABLE — the group is collapsed, never
 * dropped). The live `noise` doc body (a follow-up) is an ADDITIVE superset.
 */
export type NoiseGroup = z.infer<typeof noiseGroupSchema>;
/**
 * One neighbouring top-level symbol declared in a definition's file — the real
 * `context.overview` symbols (name, kind, line), NOT fabricated code text. These
 * are the clickable rungs of the pinned mini-browser: clicking one re-runs the
 * lookup for that name, so a reviewer walks declaration→declaration in the rail
 * while the diff stays put (Rai, wireframes #11).
 */
export type SymbolNeighbor = z.infer<typeof symbolNeighborSchema>;
/** The sibling symbols of a definition's file, for the pinned mini-browser preview. */
export type SymbolNeighbors = z.infer<typeof symbolNeighborsSchema>;
/** The whole answer for one inspected name: its definition sites and its references. */
export type SymbolInspection = z.infer<typeof symbolInspectionSchema>;
/**
 * Where a reviewable node lives in its source artifact — the file it came from and
 * its 1-based start line. This is what turns a Spec-view review affordance into a
 * DURABLE disposition: the disposition is written against the REAL artifact file
 * path (`openspec/changes/<name>/<artifact>`) at this line span, so the engine (a
 * patchset-file-scoped store) accepts it, and distinct nodes on the same file carry
 * distinct line spans rather than colliding. Absent only on hand-built fixtures.
 */
export type OpenSpecSource = z.infer<typeof openSpecSourceSchema>;
/**
 * One list item. `lead` is a bolded lead-in phrase pulled out for emphasis
 * (the `**Storage.** the rest…` idiom the artifacts use heavily); `text` is the
 * remainder. When there is no bold lead, `lead` is absent and `text` is the whole
 * item.
 */
export type OpenSpecListItem = z.infer<typeof openSpecListItemSchema>;
/** A named capability noted in a proposal's Capabilities section. */
export type OpenSpecCapabilityNote = z.infer<typeof openSpecCapabilityNoteSchema>;
/** The structured proposal: why, the changes, the capabilities, and the impact. */
export type OpenSpecProposal = z.infer<typeof openSpecProposalSchema>;
/** The design doc, as an ordered section list (a table of contents is derivable from it). */
export type OpenSpecDesign = z.infer<typeof openSpecDesignSchema>;
/** The tasks doc: the grouped checklists plus an honest whole-change roll-up. */
export type OpenSpecTasks = z.infer<typeof openSpecTasksSchema>;
/** One scenario under a requirement (`#### Scenario: …`). */
export type OpenSpecScenario = z.infer<typeof openSpecScenarioSchema>;
/** One capability's spec delta (`specs/<capability>/spec.md`). */
export type OpenSpecSpecDelta = z.infer<typeof openSpecSpecDeltaSchema>;
/**
 * The raw markdown of an OpenSpec change's artifacts, verbatim as read from disk —
 * never a re-serialization of the parsed model (issue #239). `specDeltas` is empty
 * rather than absent when there are no spec files.
 */
export type OpenSpecChangeRaw = z.infer<typeof openSpecChangeRawSchema>;
/**
 * A whole parsed OpenSpec change. Any artifact may be absent (a change need not
 * ship a design doc); `specDeltas` is empty rather than absent when there are no
 * spec files. The `name` is the change directory name.
 */
export type OpenSpecChange = z.infer<typeof openSpecChangeSchema>;
/**
 * One produced coverage edge: a requirement (identified by its capability + exact
 * name, so a consumer can key it without the ui's anchor-slug logic) mapped to the
 * grounded hunks that implement it and the count of tests that exercise it. `hunks`
 * are `rennet:hunk/<id>` anchors already grounded against the offered manifest (the
 * producer dropped any the model hallucinated); an empty `hunks` is a computed zero
 * (`unimplemented`), never a fabrication.
 */
export type OpenSpecCoverageEdge = z.infer<typeof openSpecCoverageEdgeSchema>;
/**
 * The coverage producer's result over a whole change. `status: "ok"` means the
 * mapping RAN — every requirement has an edge (covered or an honest zero), so the
 * Spec view can render every chip. `status: "failed"` means the runner did not
 * complete (no model available, budget refused, every turn failed): `edges` is empty
 * and the Spec view renders NO chips, keeping "not computed" distinct from a real
 * zero. Never a fabricated edge on failure.
 */
export type OpenSpecCoverage = z.infer<typeof openSpecCoverageSchema>;
// ─────────────────────────────────────────────────────────────────────────────
// The review→agent handoff loop (issue #18, Contracts §2.1 destination B). The
// wire shapes only; the composer, disclosure, and orchestrator live in
// `@rennet/core` (`handoff-loop.ts`), and the command schemas mirror these in
// `@rennet/protocol`. Appended at the file END so it does not collide with the
// concurrent lineage-matcher work above.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One disposition addressed to the coding agent — the effective (refined-if-kept,
 * else raw) body the reviewer staged, plus its anchor. Path-grained ⟺ `span`/`side`
 * both absent; span-grained ⟺ both present (the #78 all-or-none rule). The renderer
 * supplies these from the SAME collation draft it would publish, so the agent
 * addresses exactly what the reviewer wrote, in its cleaned form.
 */
export type HandoffDisposition = z.infer<typeof handoffDispositionSchema>;
/**
 * One resolved task in the bundle: a disposition whose anchor has been resolved to
 * the concrete diff context (the anchored hunk, or the file section) it refers to.
 * `context` is bounded and honestly marked when cut; "" when the file is not in the
 * active patchset's diff (the agent then works from the instruction alone).
 */
export type HandoffTask = z.infer<typeof handoffTaskSchema>;
/**
 * The task bundle handed to the coding harness. The `prompt` IS the contract: it
 * enumerates the tasks and instructs the agent to address them AND NOTHING ELSE
 * (the human still disposes; the agent addresses dispositions, §2.1). `digest` is a
 * content hash over the ordered tasks, so the spend disclosure the user approved and
 * the bundle the write session runs are provably the same bundle (the consent token
 * binds to it).
 */
export type HandoffBundle = z.infer<typeof handoffBundleSchema>;
/**
 * The spend disclosure surfaced BEFORE a write-enabled session runs (issue #18's
 * "spend is disclosed" invariant). A handoff spends the user's own harness quota AND
 * edits their working tree, so the disclosure names both. `model` is the harness's
 * resolved model when known (absent ⇒ the harness runs its own default). This is the
 * surface the user acts on, stated plainly before the run — not a dialog to clear.
 */
export type HandoffDisclosure = z.infer<typeof handoffDisclosureSchema>;
/**
 * The result of a completed handoff run. `review` carries the NEW patchset (the
 * delta re-review's successor canvas opens on it) with the prior patchset preserved
 * byte-identical (R28). `turnDiff` is the exact diff the agent's turn produced
 * (bracketed by workspace checkpoints); `filesTouched` is every path the turn
 * changed — including edits unrelated to any disposition (the totality guarantee).
 */
export type HandoffRunResult = z.infer<typeof handoffRunResultSchema>;
// ─────────────────────────────────────────────────────────────────────────────
// Handoff-bundle COMPOSITION (issue #72, Model Council job M24). The light-tier
// authoring step OVER the mechanical `HandoffBundle`: order the asks for execution
// sense, merge overlapping asks into coherent tasks, and write a connective
// narrative — WITHOUT altering what was asked. Appended after the #18 handoff block
// so it does not collide with that work.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One addressable ask in a bundle — a `HandoffTask` given a stable `id` the
 * composition trace cites (issue #73 maps delta-review results back through it).
 * The id is the ask's ordinal in the mechanical bundle's DETERMINISTIC order, so
 * the same disposition set always yields the same ids; the ask itself rides
 * alongside, so an id always resolves to concrete path/anchor/body.
 */
export type ComposableAsk = z.infer<typeof composableAskSchema>;
/**
 * One composed task: a group of asks the model judged should be executed as one
 * coherent unit, with a model-authored connective `title`. ⭐ The member `asks` are
 * carried VERBATIM from the trusted input — the model chooses order+grouping and
 * cites ids, it NEVER rewrites a body — so a composition can neither drop nor alter
 * what was asked (only how it reads). `title` is PREVIEW-ONLY metadata (shown to the
 * human on the paper); it is NEVER inserted into the executable handoff prompt, whose
 * per-task heading is derived mechanically from the trusted ask paths. `title` is ""
 * in the mechanical floor.
 */
export type ComposedTask = z.infer<typeof composedTaskSchema>;
/**
 * The composed bundle handed toward the coding harness (previewed on the paper at
 * journey stage 6). `composed` is TRUE when a validated model authoring was adopted
 * and FALSE when the deterministic FLOOR ran (the model was unavailable, failed, or
 * returned an incomplete/invalid partition — fail-closed to the pass-through list).
 * `traceMap` maps every input ask id to its index in `tasks`; the invariant, asserted
 * by the composer, is that EVERY id appears exactly once (no ask dropped, none
 * invented) — the round-trip guarantee #72's acceptance names.
 */
export type ComposedHandoffBundle = z.infer<typeof composedHandoffBundleSchema>;

export interface RennetBridge {
  invoke<K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>>;
  /**
   * The host OS platform (`process.platform`), so the renderer can gate
   * platform-specific chrome — e.g. reserving the macOS traffic-light inset only on
   * `"darwin"`. Optional: a non-Electron host (tests) omits it and the renderer skips
   * platform gating (default, un-inset chrome).
   */
  platform?: string;
  /**
   * The host app's own version (`app.getVersion()`), for the chrome menu's footer
   * line. Optional and host-provided, mirroring {@link platform}: a non-Electron host
   * (browser shell, tests) omits it and the version line is simply not shown.
   */
  version?: string;
  /** Opens the host operating system's Full Disk Access settings, when supported. */
  openFullDiskAccessSettings?(): Promise<boolean>;
  /**
   * Subscribe to live progress events pushed by a long-running command, keyed by
   * the `commandId` the caller passes to `invoke`. Returns an unsubscribe. Today
   * this carries `project.process`'s snapshot-build narration. Optional: a bridge
   * without a push channel simply omits it, and a subscriber degrades to the
   * command's final resolved value with no live narration.
   */
  onProgress?(commandId: string, listener: (event: ProjectProcessEvent) => void): () => void;
  /**
   * Subscribe to a `project.detail` fetch's per-repo PR-fetch narration, keyed by
   * the `commandId` the caller passes in that command's input. A sibling of
   * `onProgress` (distinct event shape), routed over the same commandId-keyed
   * push channel. Returns an unsubscribe. Optional: a bridge without a push
   * channel omits it and the subscriber degrades to the final resolved detail.
   */
  onProjectDetailProgress?(
    commandId: string,
    listener: (event: ProjectDetailProgressEvent) => void,
  ): () => void;
  /**
   * Subscribe to a conversation's token STREAM (issue #251), keyed by `reviewId` rather
   * than a commandId — a stream must survive a renderer reload while its turn keeps
   * running in main, so the subscription outlives any single `invoke`. Each event carries
   * its own `turnId` + `channel`, so a "both" ask's two channels route independently and a
   * stray delta from a superseded turn is ignorable. Optional: a bridge without a push
   * channel omits it, and a subscriber degrades to the command's final resolved value.
   */
  onAskStream?(reviewId: string, listener: (event: ReviewAskStreamEvent) => void): () => void;
  /**
   * Subscribe to a review's live ROUND progress (C15 3.1), keyed by `reviewId` — a slug
   * IS a review id, so the run route subscribes with the id it already holds, and the
   * subscription outlives any single `invoke` (a round runs long past the dispatch that
   * started it). Each event is a folded snapshot the run machine's `advance` consumes.
   * Optional: a bridge without a push channel omits it, and a subscriber degrades to the
   * `session.roundEvents` read alone — the round still resolves, just not live.
   */
  onRoundProgress?(reviewId: string, listener: (event: RoundEvent) => void): () => void;
  /**
   * Subscribe to daemon attention events (#383): `raised` / `cleared` frames that keep a
   * client's needs-you set live. Daemon-wide (not keyed by review). Returns an unsubscribe.
   * Optional: a bridge to a daemon that does not advertise `attention` omits it, and a
   * subscriber falls back to deriving needs-you from the projected review + flagged queue.
   */
  onAttention?(listener: (event: AttentionEventFrame) => void): () => void;
  /**
   * Subscribe to host-app update readiness: fires when a newer Rennet release has
   * been downloaded and is ready to apply (badge on the chrome logo). The host
   * replays its cached state to a late subscriber, so a renderer that mounts after
   * the download still learns of it. Returns an unsubscribe. Optional: a host
   * without an updater (browser shell, tests, unsigned macOS) omits it and the
   * feature is inert.
   */
  onUpdateReady?(listener: (info: UpdateReadyInfo) => void): () => void;
  /**
   * The user confirmed the restart-into-update prompt; the host quits and installs
   * the downloaded release. Optional, mirroring `onUpdateReady`. Never called
   * without an explicit user confirmation.
   */
  applyUpdate?(): void;
}

/** A downloaded-and-ready host-app update, as reported by the host's updater. */
export interface UpdateReadyInfo {
  /** Release name when the platform updater supplied one; absent otherwise. */
  version?: string;
}

// ── R19 public projection (issue #380) — the recipient-specific public contract ──
//
// A token-bearing REMOTE connection never sees a host-absolute path. These are the
// PROJECTED shapes it sees instead: every structural host-path field is replaced by
// a `repoReference` (`{repoKey, displayName, relativePath?}`) — a machine-local,
// off-machine-meaningless key plus a human label. Built by `.extend()` over the
// private schemas so they cannot silently drift from the real contract, and emitted
// as checked-in JSON-Schema fixtures under `public-schema/` (the R19 deliverable a
// future mobile client builds against). The runtime codec that maps private↔projected
// instances lives in `@rennet/server` (it needs the project store to resolve keys).
//
// Loopback connections keep the PRIVATE contract byte-for-byte — these shapes never
// touch them.

/** A remote client's reference to a repository: a local key it echoes back inbound, plus a label. */
export const repoReferenceSchema = z.object({
  /** The snapshot-store repo key (`escapePath(realpath(top-level))`); stable + reverse-resolvable server-side. */
  repoKey: z.string().min(1),
  /** A human label (repo basename, disambiguated) — display only, never accepted inbound. */
  displayName: z.string().min(1),
  /** Optional repo-relative path when the field named a location inside the repo, not its root. */
  relativePath: z.string().optional(),
});
export type RepoReference = z.infer<typeof repoReferenceSchema>;

/** Projected `repositoryProvenance`: `root`/`commonDir` become repo references. */
export const projectedRepositoryProvenanceSchema = patchsetSchema.shape.repository.extend({
  root: repoReferenceSchema,
  commonDir: repoReferenceSchema,
});

/** Projected `patchset`: its `repository` provenance is projected. */
export const projectedPatchsetSchema = patchsetSchema.extend({
  repository: projectedRepositoryProvenanceSchema,
});

/**
 * COMPAT (attention, additive): a per-review attention summary sourced from the
 * daemon's attention system (not the review pipeline). `needsYou` is true when an
 * attention family is active for the review (e.g. a pending ask); `running` is true
 * while a turn/handoff is live. Optional: absent means the daemon predates the
 * attention capability, and a client falls back to deriving these from the flagged
 * queue plus live session events. Never accepted inbound.
 */
export const projectedReviewAttentionSchema = z.object({
  needsYou: z.boolean(),
  running: z.boolean(),
});
export type ProjectedReviewAttention = z.infer<typeof projectedReviewAttentionSchema>;

/** Projected `review`: `repositoryRoot` becomes a reference and patchsets are projected. */
export const projectedReviewSchema = reviewSchema.extend({
  repositoryRoot: repoReferenceSchema,
  patchsets: z.array(projectedPatchsetSchema).min(1),
  attention: projectedReviewAttentionSchema.optional(),
});

/** Projected `project`: `path`/`openPath`/`includedRepoPaths` become references. */
export const projectedProjectSchema = projectSchema.extend({
  path: repoReferenceSchema,
  openPath: repoReferenceSchema,
  includedRepoPaths: z.array(repoReferenceSchema).optional(),
});

/** Projected `discoveredRepo`: `path` becomes a reference. */
export const projectedDiscoveredRepoSchema = discoveredRepoSchema.extend({
  path: repoReferenceSchema,
});

/** Projected `discoveryResult`: `path` and each repo `path` become references. */
export const projectedDiscoveryResultSchema = discoveryResultSchema.extend({
  path: repoReferenceSchema,
  repos: z.array(projectedDiscoveredRepoSchema),
});

/** Projected `processedRepoSummary`: `path` becomes a reference. */
export const projectedProcessedRepoSummarySchema = processedRepoSummarySchema.extend({
  path: repoReferenceSchema,
});

/** Projected `repository.choose` output: the chosen `path` becomes a reference (nullable). */
export const projectedRepositoryChooseOutputSchema = z.object({
  path: repoReferenceSchema.nullable(),
});

/**
 * The named public-projection schema set, keyed by fixture name. The fixtures
 * generator and its drift test iterate this map, so adding a projected shape here
 * is the ONLY edit needed to grow the checked-in public contract.
 */
export const publicProjectionSchemas = {
  "repo-reference": repoReferenceSchema,
  "projected-review": projectedReviewSchema,
  "projected-patchset": projectedPatchsetSchema,
  "projected-project": projectedProjectSchema,
  "projected-discovery-result": projectedDiscoveryResultSchema,
  "projected-processed-repo-summary": projectedProcessedRepoSummarySchema,
  "projected-repository-choose-output": projectedRepositoryChooseOutputSchema,
} as const;
export type PublicProjectionName = keyof typeof publicProjectionSchemas;
