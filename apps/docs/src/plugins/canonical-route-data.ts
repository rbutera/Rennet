import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import { canonicalPathForProjected } from "./docs-projection";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const editBaseUrl = "https://github.com/rbutera/rennet/edit/main/";

function newestCommitDate(path: string): Date | undefined {
  try {
    const timestamp = execFileSync(
      "git",
      ["log", "--format=%ct", "--max-count=1", "--", basename(path)],
      { cwd: dirname(path), encoding: "utf8" },
    ).trim();
    return /^\d+$/.test(timestamp) ? new Date(Number(timestamp) * 1000) : undefined;
  } catch {
    return undefined;
  }
}

export const onRequest = defineRouteMiddleware((context, next) => {
  const route = context.locals.starlightRoute;
  const canonicalPath = canonicalPathForProjected(route.entry.filePath);
  if (!canonicalPath) return next();

  route.entry.filePath = canonicalPath;
  if (route.entry.data.editUrl !== false && typeof route.entry.data.editUrl !== "string") {
    route.editUrl = new URL(canonicalPath, editBaseUrl);
  }
  if (route.entry.data.lastUpdated !== false && !(route.entry.data.lastUpdated instanceof Date)) {
    route.lastUpdated = newestCommitDate(join(repositoryRoot, canonicalPath));
  }
  return next();
});
