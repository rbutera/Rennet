import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type DocsProjectionPaths = {
  canonicalRoot: string;
  projectionRoot: string;
};

export type DocsProjectionEvent = DocsProjectionPaths & {
  kind: "add" | "change" | "unlink";
  canonicalPath: string;
};

export type DocsProjectionWatcher = {
  add(path: string): unknown;
  on(
    event: DocsProjectionEvent["kind"],
    listener: (canonicalPath: string) => Promise<void>,
  ): unknown;
};

const canonicalSections = ["using", "developing", "adr"];
const canonicalSectionNames = new Set(canonicalSections);
const appOwnedEntries = new Set(["index.mdx"]);

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function projectedPathForCanonical({
  canonicalPath,
  canonicalRoot,
  projectionRoot,
}: DocsProjectionEvent): string | undefined {
  const resolvedRoot = resolve(canonicalRoot);
  const resolvedPath = resolve(canonicalPath);
  const relativePath = relative(resolvedRoot, resolvedPath);
  if (relativePath === "" || isAbsolute(relativePath) || relativePath.startsWith(`..${sep}`)) {
    return undefined;
  }

  const [section] = relativePath.split(sep);
  return section && canonicalSectionNames.has(section)
    ? join(resolve(projectionRoot), relativePath)
    : undefined;
}

export async function syncDocsProjection({
  canonicalRoot,
  projectionRoot,
}: DocsProjectionPaths): Promise<void> {
  await mkdir(projectionRoot, { recursive: true });
  for (const entry of await readdir(projectionRoot)) {
    if (!appOwnedEntries.has(entry)) {
      await rm(join(projectionRoot, entry), { force: true, recursive: true });
    }
  }
  for (const section of canonicalSections) {
    const canonicalSection = join(canonicalRoot, section);
    const projectedSection = join(projectionRoot, section);
    if (await pathExists(canonicalSection)) {
      await cp(canonicalSection, projectedSection, { force: true, recursive: true });
    }
  }
}

export async function applyProjectionEvent(event: DocsProjectionEvent): Promise<void> {
  const projectedPath = projectedPathForCanonical(event);
  if (!projectedPath) return;

  if (event.kind === "unlink") {
    await rm(projectedPath, { force: true, recursive: true });
    return;
  }

  await mkdir(dirname(projectedPath), { recursive: true });
  await cp(event.canonicalPath, projectedPath, { force: true, recursive: true });
}

export function watchDocsProjection({
  watcher,
  onProjected,
  onError,
  ...paths
}: DocsProjectionPaths & {
  watcher: DocsProjectionWatcher;
  onProjected: () => void | Promise<void>;
  onError: (error: unknown, canonicalPath: string) => void;
}): void {
  watcher.add(paths.canonicalRoot);
  for (const kind of ["add", "change", "unlink"] satisfies DocsProjectionEvent["kind"][]) {
    watcher.on(kind, async (canonicalPath) => {
      try {
        await applyProjectionEvent({ ...paths, kind, canonicalPath });
        await onProjected();
      } catch (error) {
        onError(error, canonicalPath);
      }
    });
  }
}

export function canonicalPathForProjected(projectedPath: string): string | undefined {
  const normalized = projectedPath.replaceAll("\\", "/").replace(/^\.\//, "");
  const projectionPrefix = "src/content/docs/";
  if (!normalized.startsWith(projectionPrefix)) return undefined;

  const relativePath = normalized.slice(projectionPrefix.length);
  const [section] = relativePath.split("/");
  if (!section || !canonicalSectionNames.has(section) || relativePath.includes("../")) {
    return undefined;
  }

  return `docs/${relativePath}`;
}
