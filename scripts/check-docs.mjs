import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createProjectGraphAsync } from "@nx/devkit";

const MARKDOWN_EXTENSION = /\.mdx?$/i;
const CANONICAL_SECTIONS = new Set(["adr", "developing", "using"]);
const SITE_ONLY_PROJECTED_PAGES = new Set(["index.mdx"]);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".nx",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

function issue(code, file, message, line = 1) {
  return { code, file, line, message };
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function existsAsFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function walkFiles(root, predicate = () => true) {
  const files = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(path.join(directory, entry.name));
        continue;
      }

      const filePath = path.join(directory, entry.name);
      if (entry.isFile() && predicate(filePath)) files.push(filePath);
    }
  }

  await visit(root);
  return files;
}

async function documentationPages(docsRoot) {
  const readmePath = path.join(docsRoot, "README.md");
  return (await walkFiles(docsRoot, (filePath) => MARKDOWN_EXTENSION.test(filePath)))
    .filter((filePath) => path.resolve(filePath) !== path.resolve(readmePath))
    .sort();
}

async function canonicalPages(docsRoot) {
  return (await documentationPages(docsRoot)).filter((filePath) => {
    const [section] = displayPath(docsRoot, filePath).split("/");
    return CANONICAL_SECTIONS.has(section);
  });
}

function withoutMarkdownCode(markdown) {
  const lines = markdown.split(/\r?\n/);
  let fence = null;

  return lines.map((line) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === marker) fence = null;
      else if (fence === null) fence = marker;
      return "";
    }
    if (fence !== null) return "";
    return line.replace(/`[^`\n]*`/g, "");
  });
}

function destinationValue(rawDestination) {
  const trimmed = rawDestination.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  return trimmed.split(/\s+["'(]/, 1)[0];
}

function markdownLinks(markdown) {
  const links = [];
  const lines = withoutMarkdownCode(markdown);

  for (const [index, line] of lines.entries()) {
    const inlinePattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
    for (const match of line.matchAll(inlinePattern)) {
      links.push({ destination: destinationValue(match[1]), line: index + 1 });
    }

    const definition = line.match(/^\s*\[[^\]]+\]:\s*(\S+)/);
    if (definition) links.push({ destination: destinationValue(definition[1]), line: index + 1 });
  }

  return links;
}

function renderedAnchorLinks(html) {
  const links = [];
  const pattern = /<a\b[^>]*\bhref=(['"])(.*?)\1/gi;
  for (const match of html.matchAll(pattern)) {
    links.push(
      match[2].replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'"),
    );
  }
  return links;
}

function renderedIds(html) {
  return new Set([...html.matchAll(/\bid=(['"])(.*?)\1/gi)].map((match) => match[2]));
}

function splitDestination(destination) {
  const hashIndex = destination.indexOf("#");
  const beforeHash = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const pathname = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const rawHeading = hashIndex === -1 ? "" : destination.slice(hashIndex + 1);

  try {
    return { pathname: decodeURIComponent(pathname), heading: decodeURIComponent(rawHeading) };
  } catch {
    return { pathname, heading: rawHeading };
  }
}

function isExternal(destination) {
  return /^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith("//");
}

function headingText(markdownHeading) {
  return markdownHeading
    .replace(/\s+#+\s*$/, "")
    .replace(/<[^>]+>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

function githubSlug(value) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Emoji_Presentation}\p{Extended_Pictographic} _-]/gu, "")
    .replace(/ /g, "-");
}

function markdownHeadingIds(markdown) {
  const seen = new Map();
  const headings = new Set();

  for (const line of withoutMarkdownCode(markdown)) {
    const match = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*$/);
    if (!match) continue;
    const base = githubSlug(headingText(match[1]));
    const count = seen.get(base) ?? 0;
    headings.add(count === 0 ? base : `${base}-${count}`);
    seen.set(base, count + 1);
  }

  return headings;
}

function parseFrontmatter(markdown) {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return new Map();
  const fields = new Map();

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") break;
    const match = lines[index].match(/^([A-Za-z][\w-]*):\s*(.*?)\s*$/);
    if (!match) continue;
    const value = match[2].replace(
      /^(?:"([\s\S]*)"|'([\s\S]*)')$/,
      (_, double, single) => double ?? single,
    );
    fields.set(match[1], { line: index + 1, value });
  }

  return fields;
}

function validHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.length > 0 &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function displayPath(base, filePath) {
  return toPosix(path.relative(base, filePath));
}

export async function validateCanonicalInventory({ docsRoot }) {
  const readmePath = path.join(docsRoot, "README.md");
  if (!(await existsAsFile(readmePath))) {
    return [
      issue(
        "inventory.missing-readme",
        "docs/README.md",
        "docs/README.md is the canonical inventory but does not exist",
      ),
    ];
  }

  const readme = await readFile(readmePath, "utf8");
  const linkedPages = new Set();
  const issues = [];

  for (const filePath of await documentationPages(docsRoot)) {
    const relativePath = displayPath(docsRoot, filePath);
    const [section] = relativePath.split("/");
    if (!CANONICAL_SECTIONS.has(section)) {
      issues.push(
        issue(
          "inventory.invalid-location",
          `docs/${relativePath}`,
          "reader pages belong under docs/using, docs/developing, or docs/adr",
        ),
      );
    }
  }

  for (const link of markdownLinks(readme)) {
    if (isExternal(link.destination) || link.destination.startsWith("#")) continue;
    const { pathname } = splitDestination(link.destination);
    if (!MARKDOWN_EXTENSION.test(pathname)) continue;
    const target = path.resolve(path.dirname(readmePath), pathname);
    if (!isInside(docsRoot, target)) continue;
    if (path.resolve(target) !== path.resolve(readmePath)) linkedPages.add(path.resolve(target));
  }

  for (const filePath of await canonicalPages(docsRoot)) {
    if (!linkedPages.has(path.resolve(filePath))) {
      issues.push(
        issue(
          "inventory.missing-page",
          "docs/README.md",
          `canonical page is absent from the inventory: ${displayPath(docsRoot, filePath)}`,
        ),
      );
    }
  }

  return issues;
}

export async function validateLinks({ workspaceRoot, docsRoot }) {
  const sources = [path.join(docsRoot, "README.md"), ...(await canonicalPages(docsRoot))];
  const issues = [];
  const headingCache = new Map();

  for (const sourcePath of sources.sort()) {
    if (!(await existsAsFile(sourcePath))) continue;
    const markdown = await readFile(sourcePath, "utf8");
    for (const link of markdownLinks(markdown)) {
      if (isExternal(link.destination)) continue;
      const sourceDisplay = displayPath(workspaceRoot, sourcePath);
      if (link.destination.startsWith("/")) {
        issues.push(
          issue(
            "link.not-source-relative",
            sourceDisplay,
            `internal link must be source-relative: ${link.destination}`,
            link.line,
          ),
        );
        continue;
      }

      const { pathname, heading } = splitDestination(link.destination);
      const targetPath =
        pathname.length === 0 ? sourcePath : path.resolve(path.dirname(sourcePath), pathname);
      if (!isInside(workspaceRoot, targetPath) || !(await exists(targetPath))) {
        issues.push(
          issue(
            "link.missing-target",
            sourceDisplay,
            `link target does not exist: ${link.destination}`,
            link.line,
          ),
        );
        continue;
      }

      if (
        path.resolve(sourcePath) !== path.resolve(sources[0]) &&
        !isInside(docsRoot, targetPath)
      ) {
        issues.push(
          issue(
            "link.not-site-safe",
            sourceDisplay,
            `reader-page repository links must use a full GitHub URL: ${link.destination}`,
            link.line,
          ),
        );
        continue;
      }

      if (heading && MARKDOWN_EXTENSION.test(targetPath)) {
        let headings = headingCache.get(targetPath);
        if (!headings) {
          headings = markdownHeadingIds(await readFile(targetPath, "utf8"));
          headingCache.set(targetPath, headings);
        }
        if (!headings.has(heading)) {
          issues.push(
            issue(
              "link.missing-heading",
              sourceDisplay,
              `heading #${heading} does not exist in ${displayPath(workspaceRoot, targetPath)}`,
              link.line,
            ),
          );
        }
      }
    }
  }

  return issues.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  );
}

export async function validateRenderedSiteLinks({ workspaceRoot, distRoot }) {
  if (!(await exists(distRoot))) {
    return [
      issue(
        "rendered.missing-build",
        displayPath(workspaceRoot, distRoot),
        "rendered link validation requires a completed documentation build",
      ),
    ];
  }
  const issues = [];
  const htmlFiles = await walkFiles(distRoot, (filePath) => filePath.endsWith(".html"));
  if (htmlFiles.length === 0) {
    return [
      issue(
        "rendered.missing-build",
        displayPath(workspaceRoot, distRoot),
        "rendered link validation requires at least one built HTML page",
      ),
    ];
  }
  const idCache = new Map();

  for (const htmlPath of htmlFiles) {
    const relativeHtmlPath = displayPath(distRoot, htmlPath);
    const routePath = relativeHtmlPath.replace(/(?:^|\/)index\.html$/, "/");
    const baseUrl = new URL(routePath, "https://docs.rennet.dev/");
    const html = await readFile(htmlPath, "utf8");

    for (const destination of renderedAnchorLinks(html)) {
      let targetUrl;
      try {
        targetUrl = new URL(destination, baseUrl);
      } catch {
        issues.push(
          issue(
            "rendered.invalid-link",
            displayPath(workspaceRoot, htmlPath),
            `rendered link is not a valid URL: ${destination}`,
          ),
        );
        continue;
      }
      if (targetUrl.origin !== baseUrl.origin) continue;

      let pathname;
      try {
        pathname = decodeURIComponent(targetUrl.pathname);
      } catch {
        pathname = targetUrl.pathname;
      }
      if (MARKDOWN_EXTENSION.test(pathname)) {
        issues.push(
          issue(
            "rendered.markdown-source-link",
            displayPath(workspaceRoot, htmlPath),
            `rendered site links to a Markdown source path: ${destination}`,
          ),
        );
        continue;
      }

      const relativeTarget = pathname.replace(/^\/+/, "");
      const targetPath = pathname.endsWith("/")
        ? path.join(distRoot, relativeTarget, "index.html")
        : path.extname(pathname)
          ? path.join(distRoot, relativeTarget)
          : path.join(distRoot, relativeTarget, "index.html");
      if (!(await existsAsFile(targetPath))) {
        issues.push(
          issue(
            "rendered.missing-target",
            displayPath(workspaceRoot, htmlPath),
            `rendered site target does not exist: ${destination}`,
          ),
        );
        continue;
      }
      if (targetUrl.hash) {
        const targetId = decodeURIComponent(targetUrl.hash.slice(1));
        let ids = idCache.get(targetPath);
        if (!ids) {
          ids = renderedIds(await readFile(targetPath, "utf8"));
          idCache.set(targetPath, ids);
        }
        if (!ids.has(targetId)) {
          issues.push(
            issue(
              "rendered.missing-heading",
              displayPath(workspaceRoot, htmlPath),
              `rendered site heading does not exist: ${destination}`,
            ),
          );
        }
      }
    }
  }

  return issues.sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.message.localeCompare(right.message),
  );
}

export async function validatePlannedPages({ docsRoot }) {
  const issues = [];

  for (const filePath of await canonicalPages(docsRoot)) {
    const relativePath = displayPath(docsRoot, filePath);
    const fields = parseFrontmatter(await readFile(filePath, "utf8"));
    const status = fields.get("status");
    const tracking = fields.get("tracking");
    const isPlanDirectory = relativePath.startsWith("developing/plans/");

    if (isPlanDirectory && status?.value !== "planned") {
      issues.push(
        issue(
          "planned.invalid-status",
          `docs/${relativePath}`,
          "pages under docs/developing/plans must declare status: planned",
          status?.line,
        ),
      );
    } else if (status && status.value !== "planned") {
      issues.push(
        issue(
          "planned.invalid-status",
          `docs/${relativePath}`,
          "current pages omit status; the only supported value is planned",
          status.line,
        ),
      );
    }

    if (status?.value === "planned" && !validHttpsUrl(tracking?.value ?? "")) {
      issues.push(
        issue(
          "planned.invalid-tracking",
          `docs/${relativePath}`,
          "planned pages must declare tracking with a live HTTPS URL",
          tracking?.line ?? status.line,
        ),
      );
    } else if (tracking && !status) {
      issues.push(
        issue(
          "planned.unexpected-tracking",
          `docs/${relativePath}`,
          "tracking metadata belongs only on pages with status: planned",
          tracking.line,
        ),
      );
    }
  }

  return issues.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  );
}

export function canonicalPathForProjection({ docsRoot, projectionRoot, projectedPath }) {
  if (!isInside(projectionRoot, projectedPath)) {
    throw new Error(`${projectedPath} is outside the generated documentation projection`);
  }
  const relativePath = toPosix(
    path.relative(path.resolve(projectionRoot), path.resolve(projectedPath)),
  );
  if (SITE_ONLY_PROJECTED_PAGES.has(relativePath)) {
    throw new Error(
      `${projectedPath} is the site-only documentation homepage, not a canonical projection`,
    );
  }
  return path.join(path.resolve(docsRoot), relativePath);
}

export async function validateProjectionParity({ docsRoot, projectionRoot }) {
  const canonical = new Map(
    (await canonicalPages(docsRoot)).map((filePath) => [displayPath(docsRoot, filePath), filePath]),
  );
  const projected = new Map(
    (await walkFiles(projectionRoot, (filePath) => MARKDOWN_EXTENSION.test(filePath))).map(
      (filePath) => [displayPath(projectionRoot, filePath), filePath],
    ),
  );
  for (const relativePath of SITE_ONLY_PROJECTED_PAGES) projected.delete(relativePath);
  const issues = [];

  for (const [relativePath, canonicalPath] of canonical) {
    const projectedPath = projected.get(relativePath);
    if (!projectedPath) {
      issues.push(
        issue(
          "projection.missing-page",
          `apps/docs/src/content/docs/${relativePath}`,
          `projection is missing canonical page docs/${relativePath}`,
        ),
      );
      continue;
    }
    const [canonicalContents, projectedContents] = await Promise.all([
      readFile(canonicalPath),
      readFile(projectedPath),
    ]);
    if (!canonicalContents.equals(projectedContents)) {
      issues.push(
        issue(
          "projection.content-mismatch",
          `apps/docs/src/content/docs/${relativePath}`,
          `projected bytes differ from docs/${relativePath}`,
        ),
      );
    }
  }

  for (const relativePath of projected.keys()) {
    if (!canonical.has(relativePath)) {
      issues.push(
        issue(
          "projection.unexpected-page",
          `apps/docs/src/content/docs/${relativePath}`,
          `projection contains stale page with no canonical source: ${relativePath}`,
        ),
      );
    }
  }

  const priority = new Map([
    ["projection.content-mismatch", 0],
    ["projection.missing-page", 1],
    ["projection.unexpected-page", 2],
  ]);
  return issues.sort(
    (left, right) =>
      priority.get(left.code) - priority.get(right.code) || left.file.localeCompare(right.file),
  );
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${filePath}: ${error.message}`, { cause: error });
  }
}

export async function discoverWorkspaceProjects({ workspaceRoot, projectGraph }) {
  const graph = projectGraph ?? (await createProjectGraphAsync({ exitOnError: false }));
  const projects = [];

  for (const node of Object.values(graph.nodes)) {
    const projectType = node.data.projectType;
    if (projectType !== "application" && projectType !== "library") continue;
    const projectRoot = path.resolve(workspaceRoot, node.data.root);
    const relativeRoot = displayPath(workspaceRoot, projectRoot);
    if (!relativeRoot.startsWith("apps/") && !relativeRoot.startsWith("packages/")) continue;
    const manifestPath = path.join(projectRoot, "package.json");
    const manifest = (await existsAsFile(manifestPath)) ? await readJson(manifestPath) : null;
    projects.push({
      name: node.name,
      packageName: typeof manifest?.name === "string" ? manifest.name : null,
      root: relativeRoot,
      type: projectType,
      dependencies: (graph.dependencies[node.name] ?? [])
        .map((dependency) => dependency.target)
        .filter((name) => name !== node.name && name.startsWith("rennet-"))
        .map((name) => name.slice("rennet-".length))
        .sort(),
    });
  }

  const names = new Set();
  for (const project of projects) {
    if (names.has(project.name))
      throw new Error(`duplicate resolved Nx project name: ${project.name}`);
    names.add(project.name);
  }
  return projects.sort((left, right) => left.root.localeCompare(right.root));
}

function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim().replace(/^`|`$/g, ""));
}

function parseMonorepoRows(markdown) {
  const lines = markdown.split(/\r?\n/);
  const expectedHeader = [
    "Nx project",
    "Package",
    "Root",
    "Responsibility",
    "Allowed in-repository dependencies",
  ];

  const rows = [];
  let foundTable = false;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = tableCells(lines[index]);
    const divider = tableCells(lines[index + 1]);
    if (!header || !divider || header.join("\0") !== expectedHeader.join("\0")) continue;
    if (!divider.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;

    foundTable = true;
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const cells = tableCells(lines[rowIndex]);
      if (!cells) break;
      if (cells.length === expectedHeader.length) rows.push({ cells, line: rowIndex + 1 });
    }
  }
  return foundTable ? rows : null;
}

export async function validateMonorepoMap({ workspaceRoot, docsRoot, projectGraph }) {
  const mapPath = path.join(docsRoot, "developing/reference/monorepo-map.md");
  if (!(await existsAsFile(mapPath))) {
    return [
      issue(
        "monorepo.missing-map",
        displayPath(workspaceRoot, mapPath),
        "monorepo map does not exist",
      ),
    ];
  }

  const rows = parseMonorepoRows(await readFile(mapPath, "utf8"));
  if (!rows) {
    return [
      issue(
        "monorepo.invalid-table",
        displayPath(workspaceRoot, mapPath),
        "monorepo map needs the Nx project, Package, Root, Responsibility, and Allowed in-repository dependencies table",
      ),
    ];
  }

  const issues = [];
  const projects = await discoverWorkspaceProjects({ workspaceRoot, projectGraph });
  const projectByName = new Map(projects.map((project) => [project.name, project]));
  const rowsByName = new Map();

  for (const row of rows) {
    const [name, packageName, root, responsibility, dependencies] = row.cells;
    if (!name || rowsByName.has(name)) {
      issues.push(
        issue(
          "monorepo.duplicate-project",
          displayPath(workspaceRoot, mapPath),
          `monorepo map repeats or omits an Nx project name: ${name || "<empty>"}`,
          row.line,
        ),
      );
      continue;
    }
    rowsByName.set(name, row);
    const project = projectByName.get(name);
    if (!project) {
      issues.push(
        issue(
          "monorepo.unexpected-project",
          displayPath(workspaceRoot, mapPath),
          `monorepo map names no resolved Nx project: ${name}`,
          row.line,
        ),
      );
      continue;
    }
    const expectedPackage = project.packageName ?? "None";
    if (packageName !== expectedPackage) {
      issues.push(
        issue(
          "monorepo.package-mismatch",
          displayPath(workspaceRoot, mapPath),
          `${name} package is ${expectedPackage}, not ${packageName || "<empty>"}`,
          row.line,
        ),
      );
    }
    if (root !== project.root) {
      issues.push(
        issue(
          "monorepo.root-mismatch",
          displayPath(workspaceRoot, mapPath),
          `${name} root is ${project.root}, not ${root || "<empty>"}`,
          row.line,
        ),
      );
    }
    if (!responsibility) {
      issues.push(
        issue(
          "monorepo.missing-responsibility",
          displayPath(workspaceRoot, mapPath),
          `${name} has no responsibility`,
          row.line,
        ),
      );
    }
    if (!dependencies) {
      issues.push(
        issue(
          "monorepo.missing-dependencies",
          displayPath(workspaceRoot, mapPath),
          `${name} has no allowed in-repository dependencies`,
          row.line,
        ),
      );
    } else {
      const documentedDependencies =
        dependencies === "None"
          ? []
          : dependencies
              .split(",")
              .map((dependency) => dependency.trim())
              .filter(Boolean)
              .sort();
      const undocumentedDependencies = project.dependencies.filter(
        (dependency) => !documentedDependencies.includes(dependency),
      );
      if (undocumentedDependencies.length > 0) {
        issues.push(
          issue(
            "monorepo.missing-declared-dependency",
            displayPath(workspaceRoot, mapPath),
            `${name} omits declared dependencies: ${undocumentedDependencies.join(", ")}`,
            row.line,
          ),
        );
      }
    }
  }

  for (const project of projects) {
    if (!rowsByName.has(project.name)) {
      issues.push(
        issue(
          "monorepo.missing-project",
          displayPath(workspaceRoot, mapPath),
          `resolved Nx project is absent from the monorepo map: ${project.name} (${project.root})`,
        ),
      );
    }
  }

  const priority = new Map([
    ["monorepo.package-mismatch", 0],
    ["monorepo.root-mismatch", 1],
    ["monorepo.missing-responsibility", 2],
    ["monorepo.missing-dependencies", 3],
    ["monorepo.missing-declared-dependency", 4],
    ["monorepo.duplicate-project", 5],
    ["monorepo.unexpected-project", 6],
    ["monorepo.missing-project", 7],
  ]);
  return issues.sort(
    (left, right) =>
      priority.get(left.code) - priority.get(right.code) ||
      left.message.localeCompare(right.message),
  );
}

export async function validateDocumentation({
  workspaceRoot,
  docsRoot = path.join(workspaceRoot, "docs"),
  projectionRoot = path.join(workspaceRoot, "apps/docs/src/content/docs"),
  distRoot = path.join(workspaceRoot, "apps/docs/dist"),
}) {
  const checks = await Promise.all([
    validateCanonicalInventory({ docsRoot }),
    validateLinks({ workspaceRoot, docsRoot }),
    validatePlannedPages({ docsRoot }),
    validateProjectionParity({ docsRoot, projectionRoot }),
    validateMonorepoMap({ workspaceRoot, docsRoot }),
    validateRenderedSiteLinks({ workspaceRoot, distRoot }),
  ]);
  return checks.flat();
}

async function main() {
  const workspaceRoot = path.resolve(process.argv[2] ?? ".");
  const issues = await validateDocumentation({ workspaceRoot });
  if (issues.length === 0) {
    console.log("Documentation structure is valid.");
    return;
  }

  for (const problem of issues) {
    console.error(`${problem.file}:${problem.line} [${problem.code}] ${problem.message}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
