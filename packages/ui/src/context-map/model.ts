import type { KnowledgeStatementPayload, ProjectMapPayload } from "@rennet/protocol";

/** A directory node in a scope's file tree, with rolled-up file counts. */
export type DirNode = {
  name: string;
  path: string;
  dirs: DirNode[];
  files: { path: string }[];
  fileCount: number;
};

/** One workspace scope plus its dependency neighbourhood and file tree. */
export type ScopeNode = {
  name: string;
  root: string;
  tree: DirNode;
  out: string[];
  in: string[];
  entry: ProjectMapPayload["entryPoints"][number] | undefined;
  testCount: number;
};

export type Selection =
  | { kind: "scope"; scope: string }
  | { kind: "file"; scope: string; path: string };

function makeDir(name: string, path: string): DirNode {
  return { name, path, dirs: [], files: [], fileCount: 0 };
}

function insertFile(root: DirNode, relPath: string, file: { path: string }): void {
  const parts = relPath.split("/");
  let node = root;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index] ?? "";
    let child = node.dirs.find((dir) => dir.name === part);
    if (!child) {
      child = makeDir(part, node.path ? `${node.path}/${part}` : part);
      node.dirs.push(child);
    }
    node = child;
  }
  node.files.push(file);
}

function rollUp(node: DirNode): number {
  let count = node.files.length;
  for (const dir of node.dirs) count += rollUp(dir);
  node.fileCount = count;
  node.dirs.sort((a, b) => a.name.localeCompare(b.name));
  node.files.sort((a, b) => a.path.localeCompare(b.path));
  return count;
}

/**
 * Build the tree-spine + neighbourhood model over the deterministic Repo Map. Every
 * file is placed under the deepest scope that owns its path; files owned by no scope
 * fall to a synthetic "(repo root)" node. Pure over the payload — no bridge, no state —
 * so the view and its tests share one derivation.
 */
export function buildScopes(map: ProjectMapPayload): ScopeNode[] {
  const scopes: ScopeNode[] = map.scopes.map((scope) => ({
    name: scope.name,
    root: scope.root,
    tree: makeDir(scope.name, scope.root),
    out: map.edges.filter((edge) => edge.from === scope.name).map((edge) => edge.to),
    in: map.edges.filter((edge) => edge.to === scope.name).map((edge) => edge.from),
    entry: map.entryPoints.find((entry) => entry.scope === scope.name),
    testCount: 0,
  }));
  const rootScope: ScopeNode = {
    name: "(repo root)",
    root: "",
    tree: makeDir("(repo root)", ""),
    out: [],
    in: [],
    entry: undefined,
    testCount: 0,
  };
  const byDepth = [...scopes].sort((a, b) => b.root.length - a.root.length);
  const owner = (path: string): ScopeNode =>
    byDepth.find((scope) => path === scope.root || path.startsWith(`${scope.root}/`)) ?? rootScope;
  for (const file of map.files) {
    const scope = owner(file.path);
    const rel = scope.root ? file.path.slice(scope.root.length + 1) : file.path;
    insertFile(scope.tree, rel, { path: file.path });
  }
  for (const test of map.tests) owner(test.path).testCount++;
  const all = [...scopes.sort((a, b) => a.name.localeCompare(b.name))];
  if (rootScope.tree.files.length > 0 || rootScope.tree.dirs.length > 0) all.push(rootScope);
  for (const scope of all) rollUp(scope.tree);
  return all;
}

/** The knowledge statements that describe the current selection. */
export function knowledgeForSelection(
  statements: readonly KnowledgeStatementPayload[],
  selection: Selection,
  scope: ScopeNode | undefined,
): KnowledgeStatementPayload[] {
  const subject = selection.kind === "file" ? selection.path : selection.scope;
  return statements.filter(
    (statement) =>
      statement.subject === subject ||
      (selection.kind === "scope" &&
        scope !== undefined &&
        scope.root !== "" &&
        statement.subject.startsWith(`${scope.root}/`)),
  );
}
