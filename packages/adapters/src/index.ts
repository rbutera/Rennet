export {
  CLAUDE_TESTED_RANGE,
  ClaudeAdapter,
  type ClaudeAdapterConfig,
  type ClaudeQueryArgs,
  type ClaudeQueryFn,
  type ClaudeQueryOptions,
  classifyToolKind,
  mapClaudeError,
  normalizeClaudeFrame,
} from "./claude-adapter";
export { GitCaptureAdapter } from "./git-capture";
export {
  compareVersions,
  type DiscoveredCandidate,
  type DiscoveryDeps,
  type DiscoveryResult,
  defaultDiscoveryDeps,
  discoverClaude,
  type VersionRange,
} from "./harness-discovery";
export { RepoWatcher } from "./repo-watcher";
export { SqliteReviewStore } from "./sqlite-review-store";
