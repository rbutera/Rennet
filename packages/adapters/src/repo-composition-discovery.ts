import { dirname } from "node:path";
import type { GitlinkEntry, ScopeDeclaration } from "@rennet/core";
import type { GitExec } from "./git-range-diff";

export interface DiscoveredGitlink extends GitlinkEntry {
  readonly name: string;
  readonly url?: string;
}

async function show(git: GitExec, root: string, oid: string, path: string): Promise<string | null> {
  try {
    return await git(root, ["show", `${oid}:${path}`], { reject: true });
  } catch {
    return null;
  }
}

async function treePaths(git: GitExec, root: string, oid: string): Promise<string[]> {
  const raw = await git(root, ["ls-tree", "-r", "--name-only", "-z", oid], { reject: true });
  return raw.split("\0").filter(Boolean).sort();
}

function parseQuotedList(text: string): string[] {
  return [...text.matchAll(/["']([^"']+)["']/g)].map((match) => match[1] ?? "");
}

function globPattern(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else source += char?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}(?:/|$)`);
}

function rootsForPatterns(patterns: readonly string[], paths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const pattern of patterns.filter((value) => !value.startsWith("!"))) {
    const matcher = globPattern(pattern.replace(/^\.\//, "").replace(/\/$/, ""));
    for (const path of paths) {
      if (!matcher.test(path)) continue;
      const marker = dirname(path);
      roots.add(marker === "." ? "" : marker);
    }
  }
  return [...roots].filter(Boolean).sort();
}

export async function discoverWorkspaceScopes(
  git: GitExec,
  root: string,
  pinnedOid: string,
): Promise<ScopeDeclaration[]> {
  const paths = await treePaths(git, root, pinnedOid);
  const declarations: ScopeDeclaration[] = [];

  const pnpm = await show(git, root, pinnedOid, "pnpm-workspace.yaml");
  if (pnpm) {
    const patterns = pnpm
      .split("\n")
      .map((line) => line.match(/^\s*-\s*["']?([^"'#]+)["']?\s*$/)?.[1]?.trim())
      .filter((value): value is string => Boolean(value));
    for (const scopeRoot of rootsForPatterns(
      patterns,
      paths.filter((path) => path.endsWith("/package.json")),
    )) {
      declarations.push({ name: scopeRoot, root: scopeRoot, provenance: "pnpm" });
    }
  }

  for (const path of paths.filter((candidate) => candidate.endsWith("project.json"))) {
    const text = await show(git, root, pinnedOid, path);
    if (!text) continue;
    try {
      const project = JSON.parse(text) as {
        name?: string;
        root?: string;
        implicitDependencies?: string[];
      };
      const scopeRoot = project.root ?? dirname(path);
      declarations.push({
        name: project.name ?? scopeRoot,
        root: scopeRoot,
        provenance: "nx",
        dependencies: project.implicitDependencies ?? [],
      });
    } catch {
      // A malformed pinned project declaration is not a scope declaration.
    }
  }

  const cargo = await show(git, root, pinnedOid, "Cargo.toml");
  if (cargo) {
    const members = cargo.match(/\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/)?.[1];
    for (const scopeRoot of rootsForPatterns(
      members ? parseQuotedList(members) : [],
      paths.filter((path) => path.endsWith("/Cargo.toml")),
    )) {
      declarations.push({ name: scopeRoot, root: scopeRoot, provenance: "cargo" });
    }
  }

  const goWork = await show(git, root, pinnedOid, "go.work");
  if (goWork) {
    const useBlock = goWork.match(/use\s*\(([\s\S]*?)\)/)?.[1];
    const roots = useBlock
      ? useBlock
          .split("\n")
          .map((line) =>
            line
              .replace(/\/\/.*$/, "")
              .trim()
              .replace(/^\.\//, ""),
          )
          .filter(Boolean)
      : [...goWork.matchAll(/^\s*use\s+([^\s]+)\s*$/gm)].map((match) =>
          (match[1] ?? "").replace(/^\.\//, ""),
        );
    for (const scopeRoot of roots.sort()) {
      declarations.push({ name: scopeRoot, root: scopeRoot, provenance: "go-work" });
    }
  }
  return declarations;
}

function gitmoduleMetadata(text: string | null): Map<string, { name: string; url?: string }> {
  const metadata = new Map<string, { name: string; url?: string }>();
  if (!text) return metadata;
  let name = "";
  let path = "";
  let url: string | undefined;
  const flush = (): void => {
    if (path) metadata.set(path, { name: name || path, ...(url ? { url } : {}) });
  };
  for (const line of text.split("\n")) {
    const section = line.match(/^\s*\[submodule\s+"(.+)"\]\s*$/);
    if (section) {
      flush();
      name = section[1] ?? "";
      path = "";
      url = undefined;
      continue;
    }
    const field = line.match(/^\s*(path|url)\s*=\s*(.+?)\s*$/);
    if (field?.[1] === "path") path = field[2] ?? "";
    if (field?.[1] === "url") url = field[2];
  }
  flush();
  return metadata;
}

export async function discoverGitlinks(
  git: GitExec,
  root: string,
  parentRepoRecordId: string,
  pinnedOid: string,
): Promise<DiscoveredGitlink[]> {
  const raw = await git(root, ["ls-tree", "-r", "-z", pinnedOid], { reject: true });
  const metadata = gitmoduleMetadata(await show(git, root, pinnedOid, ".gitmodules"));
  return raw
    .split("\0")
    .flatMap((record): DiscoveredGitlink[] => {
      const match = record.match(/^160000\s+commit\s+([0-9a-f]+)\t(.+)$/);
      if (!match?.[1] || !match[2]) return [];
      const path = match[2];
      const detail = metadata.get(path);
      return [
        {
          path,
          oid: match[1],
          repoRecordId: `${parentRepoRecordId}:${path}`,
          name: detail?.name ?? path,
          ...(detail?.url ? { url: detail.url } : {}),
        },
      ];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
