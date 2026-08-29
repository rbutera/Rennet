import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, posix, relative, sep } from "node:path";
import type { Patchset } from "@rennet/protocol";
import type { GitExec } from "./git-range-diff";
import { listTree, readBlobText } from "./project-snapshot-source";

export type DesignArtifactFormat = "openspec" | "kiro" | "bmad" | "superpowers" | "grill-with-docs";

export type DesignArtifactRole =
  | "proposal"
  | "design"
  | "spec-delta"
  | "requirements"
  | "bugfix"
  | "tasks"
  | "prd"
  | "architecture"
  | "epic"
  | "story"
  | "plan"
  | "progress"
  | "context-map"
  | "context"
  | "adr";

export interface DesignArtifact {
  readonly path: string;
  readonly role: DesignArtifactRole;
  readonly content: string;
  readonly sourceBytes: number;
  readonly truncated: boolean;
}

export type DesignCandidateRelevance =
  | {
      readonly kind: "changed-artifact";
      readonly paths: readonly string[];
      readonly omittedPathCount: number;
    }
  | {
      readonly kind: "references-changed-path";
      readonly paths: readonly string[];
      readonly omittedPathCount: number;
    }
  | { readonly kind: "repository-candidate" };

export interface DesignArtifactCandidate {
  readonly format: DesignArtifactFormat;
  readonly name: string;
  readonly nameSourceBytes: number;
  readonly nameTruncated: boolean;
  readonly relevance: DesignCandidateRelevance;
  readonly artifacts: readonly DesignArtifact[];
  readonly omittedArtifactCount: number;
}

export interface DesignArtifactLimits {
  readonly maxCandidates: number;
  readonly maxArtifactsPerCandidate: number;
  readonly maxChangedPaths: number;
  readonly maxRelevancePaths: number;
  readonly maxCandidateNameBytes: number;
  readonly baseContentBytesPerCandidate: number;
  readonly maxContentBytesPerCandidate: number;
  readonly maxTotalContentBytes: number;
  readonly maxSerializedBytes: number;
}

export interface DesignArtifactSet {
  readonly changedPaths: readonly string[];
  readonly omittedChangedPathCount: number;
  readonly candidates: readonly DesignArtifactCandidate[];
  readonly omittedCandidateCount: number;
  readonly limits: DesignArtifactLimits;
}

export interface DiscoverDesignArtifactsOptions {
  readonly patchset: Patchset;
  readonly git: GitExec;
}

interface ReviewedState {
  readonly paths: readonly string[];
  read(path: string): Promise<string | undefined>;
}

interface CandidateInput {
  readonly format: DesignArtifactFormat;
  readonly name: string;
  readonly artifacts: readonly DesignArtifact[];
}

interface BmadConfig {
  readonly prdFile?: string;
  readonly prdSharded?: boolean;
  readonly prdShardedLocation?: string;
  readonly epicFilePattern?: string;
  readonly architectureFile?: string;
  readonly architectureSharded?: boolean;
  readonly architectureShardedLocation?: string;
  readonly devStoryLocation?: string;
}

const BMAD_CONFIG_PATH = ".bmad-core/core-config.yaml";
export const DESIGN_ARTIFACT_LIMITS: DesignArtifactLimits = {
  maxCandidates: 48,
  maxArtifactsPerCandidate: 64,
  maxChangedPaths: 128,
  maxRelevancePaths: 8,
  maxCandidateNameBytes: 256,
  baseContentBytesPerCandidate: 2 * 1024,
  maxContentBytesPerCandidate: 64 * 1024,
  maxTotalContentBytes: 192 * 1024,
  maxSerializedBytes: 512 * 1024,
};
const byCodePoint = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const roleOrder: Readonly<Record<DesignArtifactRole, number>> = {
  proposal: 0,
  prd: 0,
  requirements: 1,
  bugfix: 1,
  design: 2,
  architecture: 2,
  "spec-delta": 3,
  epic: 3,
  story: 4,
  tasks: 5,
  plan: 5,
  progress: 6,
  "context-map": 0,
  context: 1,
  adr: 2,
};

const formatOrder: Readonly<Record<DesignArtifactFormat, number>> = {
  openspec: 0,
  kiro: 1,
  bmad: 2,
  superpowers: 3,
  "grill-with-docs": 4,
};

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byCodePoint);
}

function toRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function safeRepoPath(path: string): string | undefined {
  const repoPath = toRepoPath(path.trim());
  if (repoPath.length === 0 || isAbsolute(repoPath)) return undefined;
  const normalized = posix.normalize(repoPath);
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

function isWorkingTreeReview(patchset: Patchset): boolean {
  return (patchset.source ?? "local") === "local";
}

async function readDiskFile(root: string, repoPath: string): Promise<string | undefined> {
  const normalized = safeRepoPath(repoPath);
  if (normalized === undefined) return undefined;
  const absolutePath = join(root, ...normalized.split("/"));
  const relativePath = relative(root, absolutePath);
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    normalize(relativePath).split(sep).includes("..")
  ) {
    return undefined;
  }
  try {
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "EISDIR") return undefined;
    throw error;
  }
}

async function reviewedState(options: DiscoverDesignArtifactsOptions): Promise<ReviewedState> {
  const { patchset, git } = options;
  const root = patchset.repository.root;
  const tree = await listTree(root, patchset.repository.headOid, git);
  const blobs = new Map(tree.map((entry) => [toRepoPath(entry.path), entry.blobOid]));
  const paths = isWorkingTreeReview(patchset)
    ? uniqueSorted([
        ...blobs.keys(),
        ...patchset.files.flatMap((file) =>
          file.previousPath === undefined
            ? [toRepoPath(file.path)]
            : [toRepoPath(file.path), toRepoPath(file.previousPath)],
        ),
      ])
    : uniqueSorted(blobs.keys());
  const pending = new Map<string, Promise<string | undefined>>();

  return {
    paths,
    read(path: string): Promise<string | undefined> {
      const repoPath = safeRepoPath(path);
      if (repoPath === undefined) return Promise.resolve(undefined);
      const cached = pending.get(repoPath);
      if (cached !== undefined) return cached;
      let operation: Promise<string | undefined>;
      if (isWorkingTreeReview(patchset)) {
        operation = readDiskFile(root, repoPath);
      } else {
        const blobOid = blobs.get(repoPath);
        operation =
          blobOid === undefined
            ? Promise.resolve(undefined)
            : readBlobText(root, blobOid, git).then((content) => content);
      }
      pending.set(repoPath, operation);
      return operation;
    },
  };
}

async function artifact(
  state: ReviewedState,
  path: string,
  role: DesignArtifactRole,
): Promise<DesignArtifact | undefined> {
  const content = await state.read(path);
  if (content === undefined || content.trim().length === 0) return undefined;
  return artifactFromContent(path, role, content);
}

function artifactFromContent(
  path: string,
  role: DesignArtifactRole,
  content: string,
): DesignArtifact {
  return {
    path,
    role,
    content,
    sourceBytes: Buffer.byteLength(content),
    truncated: false,
  };
}

function sortArtifacts(artifacts: readonly DesignArtifact[]): DesignArtifact[] {
  return [...artifacts].sort(
    (left, right) =>
      roleOrder[left.role] - roleOrder[right.role] || byCodePoint(left.path, right.path),
  );
}

async function discoverOpenSpec(state: ReviewedState): Promise<CandidateInput[]> {
  const pathsByChange = new Map<string, { path: string; role: DesignArtifactRole }[]>();
  for (const path of state.paths) {
    const match = /^openspec\/changes\/([^/]+)\/(.+)$/.exec(path);
    if (match === null || match[1] === "archive") continue;
    const name = match[1];
    const artifactPath = match[2];
    if (name === undefined || artifactPath === undefined) continue;
    let role: DesignArtifactRole | undefined;
    if (artifactPath === "proposal.md") role = "proposal";
    else if (artifactPath === "design.md") role = "design";
    else if (artifactPath === "tasks.md") role = "tasks";
    else if (/^specs\/[^/]+\/spec\.md$/.test(artifactPath)) role = "spec-delta";
    if (role === undefined) continue;
    const current = pathsByChange.get(name) ?? [];
    current.push({ path, role });
    pathsByChange.set(name, current);
  }

  const candidates: CandidateInput[] = [];
  for (const [name, paths] of [...pathsByChange].sort(([left], [right]) =>
    byCodePoint(left, right),
  )) {
    const loaded = await Promise.all(paths.map((entry) => artifact(state, entry.path, entry.role)));
    const artifacts = sortArtifacts(loaded.filter((entry) => entry !== undefined));
    if (artifacts.length > 0) candidates.push({ format: "openspec", name, artifacts });
  }
  return candidates;
}

async function discoverKiro(state: ReviewedState): Promise<CandidateInput[]> {
  const pathsByFeature = new Map<string, { path: string; role: DesignArtifactRole }[]>();
  for (const path of state.paths) {
    const match = /^\.kiro\/specs\/([^/]+)\/(requirements|bugfix|design|tasks)\.md$/.exec(path);
    if (match === null) continue;
    const feature = match[1];
    const file = match[2];
    if (feature === undefined || file === undefined) continue;
    let role: DesignArtifactRole;
    if (file === "requirements") role = "requirements";
    else if (file === "bugfix") role = "bugfix";
    else if (file === "design") role = "design";
    else role = "tasks";
    const current = pathsByFeature.get(feature) ?? [];
    current.push({ path, role });
    pathsByFeature.set(feature, current);
  }

  const candidates: CandidateInput[] = [];
  for (const [name, paths] of [...pathsByFeature].sort(([left], [right]) =>
    byCodePoint(left, right),
  )) {
    const loaded = await Promise.all(paths.map((entry) => artifact(state, entry.path, entry.role)));
    const artifacts = sortArtifacts(loaded.filter((entry) => entry !== undefined));
    if (artifacts.length > 0) candidates.push({ format: "kiro", name, artifacts });
  }
  return candidates;
}

function yamlScalar(content: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m");
  const match = pattern.exec(content);
  if (match === null) return undefined;
  const withoutComment = match[1]?.replace(/\s+#.*$/, "").trim();
  if (withoutComment === undefined || withoutComment.length === 0) return undefined;
  const unquoted =
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
      ? withoutComment.slice(1, -1)
      : withoutComment;
  return safeRepoPath(unquoted);
}

function yamlBoolean(content: string, key: string): boolean | undefined {
  const pattern = new RegExp(`^\\s*${key}:\\s*(true|false)\\s*(?:#.*)?$`, "m");
  const value = pattern.exec(content)?.[1];
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseBmadConfig(content: string): BmadConfig {
  const config = {
    prdFile: yamlScalar(content, "prdFile"),
    prdSharded: yamlBoolean(content, "prdSharded"),
    prdShardedLocation: yamlScalar(content, "prdShardedLocation"),
    epicFilePattern: yamlScalar(content, "epicFilePattern"),
    architectureFile: yamlScalar(content, "architectureFile"),
    architectureSharded: yamlBoolean(content, "architectureSharded"),
    architectureShardedLocation: yamlScalar(content, "architectureShardedLocation"),
    devStoryLocation: yamlScalar(content, "devStoryLocation"),
  };
  return {
    ...(config.prdFile === undefined ? {} : { prdFile: config.prdFile }),
    ...(config.prdSharded === undefined ? {} : { prdSharded: config.prdSharded }),
    ...(config.prdShardedLocation === undefined
      ? {}
      : { prdShardedLocation: config.prdShardedLocation }),
    ...(config.epicFilePattern === undefined ? {} : { epicFilePattern: config.epicFilePattern }),
    ...(config.architectureFile === undefined ? {} : { architectureFile: config.architectureFile }),
    ...(config.architectureSharded === undefined
      ? {}
      : { architectureSharded: config.architectureSharded }),
    ...(config.architectureShardedLocation === undefined
      ? {}
      : { architectureShardedLocation: config.architectureShardedLocation }),
    ...(config.devStoryLocation === undefined ? {} : { devStoryLocation: config.devStoryLocation }),
  };
}

function pathUnder(path: string, directory: string | undefined): boolean {
  return directory !== undefined && path.startsWith(`${directory.replace(/\/$/, "")}/`);
}

function wildcardPattern(pattern: string | undefined): RegExp {
  if (pattern === undefined) return /^epic-\d+.*\.md$/;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern.startsWith("{n}", index)) {
      source += "\\d+";
      index += 2;
      continue;
    }
    const character = pattern[index] ?? "";
    if (character === "*") source += ".*";
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function firstHeading(content: string): string | undefined {
  const match = /^#\s+(.+?)\s*$/m.exec(content);
  return match?.[1];
}

async function discoverBmad(state: ReviewedState): Promise<CandidateInput[]> {
  const configContent = await state.read(BMAD_CONFIG_PATH);
  if (configContent === undefined || configContent.trim().length === 0) return [];
  const config = parseBmadConfig(configContent);
  const epicPattern = wildcardPattern(config.epicFilePattern);
  const planned = new Map<string, DesignArtifactRole>();
  if (config.prdFile !== undefined) planned.set(config.prdFile, "prd");
  if (config.architectureFile !== undefined) planned.set(config.architectureFile, "architecture");

  for (const path of state.paths) {
    if (!path.endsWith(".md")) continue;
    if (config.prdSharded === true && pathUnder(path, config.prdShardedLocation)) {
      planned.set(path, epicPattern.test(basename(path)) ? "epic" : "prd");
    }
    if (
      config.architectureSharded === true &&
      pathUnder(path, config.architectureShardedLocation)
    ) {
      planned.set(path, "architecture");
    }
    if (pathUnder(path, config.devStoryLocation)) planned.set(path, "story");
  }

  const loaded = await Promise.all([...planned].map(([path, role]) => artifact(state, path, role)));
  const artifacts = sortArtifacts(loaded.filter((entry) => entry !== undefined));
  if (artifacts.length === 0) return [];
  const primaryPrd = artifacts.find((entry) => entry.path === config.prdFile);
  const name =
    (primaryPrd === undefined ? undefined : firstHeading(primaryPrd.content)) ??
    artifacts.map((entry) => firstHeading(entry.content)).find((value) => value !== undefined);
  return [{ format: "bmad", name: name ?? "BMAD project", artifacts }];
}

function isDatedMarkdown(path: string): boolean {
  return /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(basename(path));
}

function isSuperpowersPlan(content: string): boolean {
  return (
    /^#\s+.+ Implementation Plan\s*$/m.test(content) &&
    /^\*\*Goal:\*\*/m.test(content) &&
    /^\*\*Spec:\*\*/m.test(content) &&
    /^### Task \d+:/m.test(content)
  );
}

function isSuperpowersDesign(content: string): boolean {
  const topicPatterns = [
    /\barchitecture\b|\boverall approach\b/,
    /\bcomponents?\b|\bboundar(?:y|ies)\b/,
    /\bdata flow\b|\bdata movement\b/,
    /\berror(?: handling|s)?\b|\bfailures?\b/,
    /\btesting\b|\btests?\b|\bverification\b/,
  ];
  const headings = [...content.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) =>
    (match[1] ?? "").toLowerCase(),
  );
  return (
    topicPatterns.filter((pattern) => headings.some((heading) => pattern.test(heading))).length >= 3
  );
}

function superpowersSpecPath(content: string): string | undefined {
  const value = /^\*\*Spec:\*\*\s+(.+?)\s*$/m.exec(content)?.[1]?.trim();
  if (value === undefined) return undefined;
  const markdownTarget = /^\[[^\]]+\]\(([^)]+)\)$/.exec(value)?.[1];
  const raw = (markdownTarget ?? value).replace(/^`|`$/g, "");
  return safeRepoPath(raw);
}

function superpowersName(path: string, content: string): string {
  const heading = firstHeading(content)?.replace(/\s+Implementation Plan$/, "");
  if (heading !== undefined && heading.length > 0) return heading;
  return basename(path, ".md")
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .replace(/-design$/, "");
}

async function discoverSuperpowers(state: ReviewedState): Promise<CandidateInput[]> {
  const markdownPaths = state.paths.filter((path) => path.endsWith(".md"));
  const possiblePaths = markdownPaths.filter(
    (path) => path.startsWith("docs/superpowers/") || isDatedMarkdown(path),
  );
  const possible = await Promise.all(
    possiblePaths.map(async (path) => ({ path, content: await state.read(path) })),
  );
  const plans = possible.filter(
    (entry) => entry.content !== undefined && isSuperpowersPlan(entry.content),
  );
  const conventionalSpecs = possible.filter(
    (entry) =>
      entry.content !== undefined &&
      (entry.path.startsWith("docs/superpowers/specs/") || isSuperpowersDesign(entry.content)),
  );
  const linkedSpecs = new Set<string>();
  const candidates: CandidateInput[] = [];

  for (const plan of plans) {
    if (plan.content === undefined) continue;
    const artifacts: DesignArtifact[] = [artifactFromContent(plan.path, "plan", plan.content)];
    const specPath = superpowersSpecPath(plan.content);
    if (specPath !== undefined) {
      const spec = await artifact(state, specPath, "design");
      if (spec !== undefined) {
        artifacts.push(spec);
        linkedSpecs.add(specPath);
      }
    }
    const planBase = basename(plan.path, ".md");
    const progressPaths = [
      `.superpowers/sdd/${planBase}/progress.md`,
      `.superpowers/sdd/${basename(plan.path)}/progress.md`,
    ];
    for (const progressPath of progressPaths) {
      const progress = await artifact(state, progressPath, "progress");
      if (progress !== undefined) {
        artifacts.push(progress);
        break;
      }
    }
    candidates.push({
      format: "superpowers",
      name: superpowersName(plan.path, plan.content),
      artifacts: sortArtifacts(artifacts),
    });
  }

  for (const spec of conventionalSpecs) {
    if (spec.content === undefined || linkedSpecs.has(spec.path)) continue;
    candidates.push({
      format: "superpowers",
      name: superpowersName(spec.path, spec.content),
      artifacts: [artifactFromContent(spec.path, "design", spec.content)],
    });
  }
  return candidates;
}

function contextPathsFromMap(content: string): string[] {
  const paths: string[] = [];
  let inContexts = false;
  for (const line of content.split("\n")) {
    if (/^## Contexts\s*$/.test(line)) {
      inContexts = true;
      continue;
    }
    if (inContexts && /^##\s+/.test(line)) break;
    if (!inContexts) continue;
    for (const match of line.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]?.replace(/^<|>$/g, "");
      const path = target === undefined ? undefined : safeRepoPath(target);
      if (path !== undefined && basename(path) === "CONTEXT.md") paths.push(path);
    }
  }
  return uniqueSorted(paths);
}

function isAdrUnder(path: string, root: string): boolean {
  const prefix = root.length === 0 ? "docs/adr/" : `${root}/docs/adr/`;
  return path.startsWith(prefix) && /^\d{4}[^/]*\.md$/.test(path.slice(prefix.length));
}

async function discoverGrillWithDocs(state: ReviewedState): Promise<CandidateInput[]> {
  const mapContent = await state.read("CONTEXT-MAP.md");
  const paths: { path: string; role: DesignArtifactRole }[] = [];
  if (mapContent !== undefined && mapContent.trim().length > 0) {
    paths.push({ path: "CONTEXT-MAP.md", role: "context-map" });
    const contextPaths = contextPathsFromMap(mapContent);
    for (const path of contextPaths) paths.push({ path, role: "context" });
    const contextRoots = contextPaths
      .map((path) => posix.dirname(path))
      .filter((path) => path !== ".");
    for (const path of state.paths) {
      if (isAdrUnder(path, "") || contextRoots.some((root) => isAdrUnder(path, root))) {
        paths.push({ path, role: "adr" });
      }
    }
  } else {
    if (state.paths.includes("CONTEXT.md")) paths.push({ path: "CONTEXT.md", role: "context" });
    for (const path of state.paths) {
      if (isAdrUnder(path, "")) paths.push({ path, role: "adr" });
    }
  }
  const loaded = await Promise.all(paths.map((entry) => artifact(state, entry.path, entry.role)));
  const artifacts = sortArtifacts(loaded.filter((entry) => entry !== undefined));
  if (artifacts.length === 0) return [];
  const rootContext = artifacts.find(
    (entry) => entry.path === "CONTEXT-MAP.md" || entry.path === "CONTEXT.md",
  );
  return [
    {
      format: "grill-with-docs",
      name:
        rootContext === undefined
          ? "Project context"
          : (firstHeading(rootContext.content) ?? "Project context"),
      artifacts,
    },
  ];
}

function relevanceFor(
  artifacts: readonly DesignArtifact[],
  changedPaths: readonly string[],
): DesignCandidateRelevance {
  const artifactPaths = new Set(artifacts.map((entry) => entry.path));
  const changedArtifacts = changedPaths.filter((path) => artifactPaths.has(path));
  if (changedArtifacts.length > 0) {
    return {
      kind: "changed-artifact",
      paths: changedArtifacts.slice(0, DESIGN_ARTIFACT_LIMITS.maxRelevancePaths),
      omittedPathCount: Math.max(
        0,
        changedArtifacts.length - DESIGN_ARTIFACT_LIMITS.maxRelevancePaths,
      ),
    };
  }
  const referenced = changedPaths.filter((path) =>
    artifacts.some((entry) => contentReferencesPath(entry.content, path)),
  );
  if (referenced.length > 0) {
    return {
      kind: "references-changed-path",
      paths: referenced.slice(0, DESIGN_ARTIFACT_LIMITS.maxRelevancePaths),
      omittedPathCount: Math.max(0, referenced.length - DESIGN_ARTIFACT_LIMITS.maxRelevancePaths),
    };
  }
  return { kind: "repository-candidate" };
}

function isPathCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_./-]/.test(character);
}

function isPathReferenceStart(content: string, index: number): boolean {
  const before = index === 0 ? undefined : content[index - 1];
  if (!isPathCharacter(before)) return true;
  if (before !== "/" || content[index - 2] !== ".") return false;
  return !isPathCharacter(index < 3 ? undefined : content[index - 3]);
}

function contentReferencesPath(content: string, path: string): boolean {
  let offset = 0;
  while (offset < content.length) {
    const index = content.indexOf(path, offset);
    if (index === -1) return false;
    const afterIndex = index + path.length;
    const after = afterIndex >= content.length ? undefined : content[afterIndex];
    if (isPathReferenceStart(content, index) && !isPathCharacter(after)) return true;
    offset = index + 1;
  }
  return false;
}

function relevanceOrder(relevance: DesignCandidateRelevance): number {
  switch (relevance.kind) {
    case "changed-artifact":
      return 0;
    case "references-changed-path":
      return 1;
    case "repository-candidate":
      return 2;
    default: {
      const exhaustive: never = relevance;
      return exhaustive;
    }
  }
}

function compareCandidateInputs(
  left: CandidateInput & { readonly relevance: DesignCandidateRelevance },
  right: CandidateInput & { readonly relevance: DesignCandidateRelevance },
): number {
  return (
    relevanceOrder(left.relevance) - relevanceOrder(right.relevance) ||
    formatOrder[left.format] - formatOrder[right.format] ||
    byCodePoint(left.name, right.name) ||
    byCodePoint(left.artifacts[0]?.path ?? "", right.artifacts[0]?.path ?? "")
  );
}

function artifactRelevanceOrder(artifact: DesignArtifact, changedPaths: readonly string[]): number {
  if (changedPaths.includes(artifact.path)) return 0;
  if (changedPaths.some((path) => contentReferencesPath(artifact.content, path))) return 1;
  return 2;
}

function utf8Prefix(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content) <= maxBytes) return content;
  const characters: string[] = [];
  let bytes = 0;
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  return characters.join("");
}

function boundCandidateContent(
  candidate: CandidateInput & { readonly relevance: DesignCandidateRelevance },
  contentBudget: number,
  changedPaths: readonly string[],
): DesignArtifactCandidate {
  const selected = [...candidate.artifacts]
    .sort(
      (left, right) =>
        artifactRelevanceOrder(left, changedPaths) - artifactRelevanceOrder(right, changedPaths) ||
        roleOrder[left.role] - roleOrder[right.role] ||
        byCodePoint(left.path, right.path),
    )
    .slice(0, DESIGN_ARTIFACT_LIMITS.maxArtifactsPerCandidate);
  const artifactBudget = selected.length === 0 ? 0 : Math.floor(contentBudget / selected.length);
  let remainder = selected.length === 0 ? 0 : contentBudget % selected.length;
  const name = utf8Prefix(candidate.name, DESIGN_ARTIFACT_LIMITS.maxCandidateNameBytes);
  return {
    format: candidate.format,
    name,
    nameSourceBytes: Buffer.byteLength(candidate.name),
    nameTruncated: Buffer.byteLength(name) < Buffer.byteLength(candidate.name),
    relevance: candidate.relevance,
    omittedArtifactCount: candidate.artifacts.length - selected.length,
    artifacts: sortArtifacts(selected).map((entry) => {
      const maxBytes = artifactBudget + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      const content = utf8Prefix(entry.content, maxBytes);
      return {
        ...entry,
        content,
        truncated: Buffer.byteLength(content) < entry.sourceBytes,
      };
    }),
  };
}

function boundCandidates(
  inputs: readonly (CandidateInput & { readonly relevance: DesignCandidateRelevance })[],
  changedPaths: readonly string[],
): {
  readonly candidates: DesignArtifactCandidate[];
  readonly omittedCandidateCount: number;
} {
  const selected = inputs.slice(0, DESIGN_ARTIFACT_LIMITS.maxCandidates);
  const budgets = selected.map(() => DESIGN_ARTIFACT_LIMITS.baseContentBytesPerCandidate);
  let remaining =
    DESIGN_ARTIFACT_LIMITS.maxTotalContentBytes -
    DESIGN_ARTIFACT_LIMITS.baseContentBytesPerCandidate * selected.length;
  for (let index = 0; index < selected.length && remaining > 0; index += 1) {
    const candidate = selected[index];
    if (candidate === undefined || candidate.relevance.kind === "repository-candidate") continue;
    const current = budgets[index] ?? 0;
    const extra = Math.min(DESIGN_ARTIFACT_LIMITS.maxContentBytesPerCandidate - current, remaining);
    budgets[index] = current + extra;
    remaining -= extra;
  }
  while (remaining > 0) {
    const eligible = budgets
      .map((budget, index) => ({ budget, index }))
      .filter((entry) => entry.budget < DESIGN_ARTIFACT_LIMITS.maxContentBytesPerCandidate);
    if (eligible.length === 0) break;
    const share = Math.max(1, Math.floor(remaining / eligible.length));
    for (const entry of eligible) {
      const extra = Math.min(
        share,
        DESIGN_ARTIFACT_LIMITS.maxContentBytesPerCandidate - entry.budget,
        remaining,
      );
      budgets[entry.index] = entry.budget + extra;
      remaining -= extra;
      if (remaining === 0) break;
    }
  }
  return {
    candidates: selected.map((candidate, index) =>
      boundCandidateContent(candidate, budgets[index] ?? 0, changedPaths),
    ),
    omittedCandidateCount: inputs.length - selected.length,
  };
}

function cloneRelevance(relevance: DesignCandidateRelevance): DesignCandidateRelevance {
  switch (relevance.kind) {
    case "changed-artifact":
      return { ...relevance, paths: [...relevance.paths] };
    case "references-changed-path":
      return { ...relevance, paths: [...relevance.paths] };
    case "repository-candidate":
      return relevance;
    default: {
      const exhaustive: never = relevance;
      return exhaustive;
    }
  }
}

function serializedBytes(value: DesignArtifactSet): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function fitSerializedLimit(
  input: DesignArtifactSet,
  allChangedPaths: readonly string[],
): DesignArtifactSet {
  const changedPaths = [...input.changedPaths];
  let omittedChangedPathCount = input.omittedChangedPathCount;
  let omittedCandidateCount = input.omittedCandidateCount;
  const candidates = input.candidates.map((candidate) => ({
    ...candidate,
    relevance: cloneRelevance(candidate.relevance),
    artifacts: [...candidate.artifacts],
  }));
  const current = (): DesignArtifactSet => ({
    changedPaths,
    omittedChangedPathCount,
    candidates,
    omittedCandidateCount,
    limits: input.limits,
  });

  while (serializedBytes(current()) > DESIGN_ARTIFACT_LIMITS.maxSerializedBytes) {
    if (changedPaths.length > 0) {
      changedPaths.pop();
      omittedChangedPathCount += 1;
      continue;
    }

    let trimmed = false;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (candidate === undefined || candidate.relevance.kind === "repository-candidate") continue;
      if (candidate.relevance.paths.length === 0) continue;
      candidates[index] = {
        ...candidate,
        relevance: {
          ...candidate.relevance,
          paths: candidate.relevance.paths.slice(0, -1),
          omittedPathCount: candidate.relevance.omittedPathCount + 1,
        },
      };
      trimmed = true;
      break;
    }
    if (trimmed) continue;

    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (candidate === undefined || candidate.artifacts.length <= 1) continue;
      const ordered = [...candidate.artifacts].sort(
        (left, right) =>
          artifactRelevanceOrder(left, allChangedPaths) -
            artifactRelevanceOrder(right, allChangedPaths) ||
          roleOrder[left.role] - roleOrder[right.role] ||
          byCodePoint(left.path, right.path),
      );
      const removed = ordered.pop();
      if (removed === undefined) continue;
      candidates[index] = {
        ...candidate,
        artifacts: candidate.artifacts.filter((entry) => entry.path !== removed.path),
        omittedArtifactCount: candidate.omittedArtifactCount + 1,
      };
      trimmed = true;
      break;
    }
    if (trimmed) continue;

    if (candidates.length > 1) {
      candidates.pop();
      omittedCandidateCount += 1;
      continue;
    }

    const candidate = candidates[0];
    const artifact = candidate?.artifacts[0];
    if (candidate === undefined || artifact === undefined || artifact.content.length === 0) break;
    const content = utf8Prefix(
      artifact.content,
      Math.floor(Buffer.byteLength(artifact.content) / 2),
    );
    candidates[0] = {
      ...candidate,
      artifacts: [{ ...artifact, content, truncated: true }],
    };
  }
  return current();
}

/**
 * Discover every structured design-artifact candidate at the immutable state under review.
 * Working-tree reviews read file bytes from disk; range and PR reviews read blobs from the
 * pinned head tree. Candidates remain separate and carry deterministic changed-path relevance
 * so a drafting agent can choose the semantic target without adapter code discarding decoys.
 */
export async function discoverDesignArtifacts(
  options: DiscoverDesignArtifactsOptions,
): Promise<DesignArtifactSet | null> {
  const state = await reviewedState(options);
  const changedPaths = uniqueSorted(
    options.patchset.files.flatMap((file) =>
      file.previousPath === undefined
        ? [toRepoPath(file.path)]
        : [toRepoPath(file.path), toRepoPath(file.previousPath)],
    ),
  );
  const groups = await Promise.all([
    discoverOpenSpec(state),
    discoverKiro(state),
    discoverBmad(state),
    discoverSuperpowers(state),
    discoverGrillWithDocs(state),
  ]);
  const discovered = groups
    .flat()
    .map((candidate) => ({
      ...candidate,
      relevance: relevanceFor(candidate.artifacts, changedPaths),
    }))
    .sort(compareCandidateInputs);
  if (discovered.length === 0) return null;
  const { candidates, omittedCandidateCount } = boundCandidates(discovered, changedPaths);
  const keptChangedPaths = changedPaths.slice(0, DESIGN_ARTIFACT_LIMITS.maxChangedPaths);
  return fitSerializedLimit(
    {
      changedPaths: keptChangedPaths,
      omittedChangedPathCount: changedPaths.length - keptChangedPaths.length,
      candidates,
      omittedCandidateCount,
      limits: DESIGN_ARTIFACT_LIMITS,
    },
    changedPaths,
  );
}
