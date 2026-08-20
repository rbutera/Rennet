import path from "node:path";

const MARKDOWN_EXTENSION = /\.mdx?$/i;
const PROJECTION_MARKER = "/src/content/docs/";

function visit(node, transform) {
  if (!node || typeof node !== "object") return;
  transform(node);
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) visit(child, transform);
}

export function siteRouteForMarkdownLink(sourcePath, destination) {
  if (
    typeof sourcePath !== "string" ||
    typeof destination !== "string" ||
    destination.startsWith("#") ||
    destination.startsWith("/") ||
    /^[a-z][a-z\d+.-]*:/i.test(destination) ||
    destination.startsWith("//")
  ) {
    return undefined;
  }

  const hashIndex = destination.indexOf("#");
  const pathname = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : destination.slice(hashIndex);
  if (!MARKDOWN_EXTENSION.test(pathname)) return undefined;

  const normalizedSource = sourcePath.replaceAll("\\", "/");
  const markerIndex = normalizedSource.lastIndexOf(PROJECTION_MARKER);
  if (markerIndex === -1) return undefined;

  const contentRoot = normalizedSource.slice(0, markerIndex + PROJECTION_MARKER.length - 1);
  const target = path.posix.resolve(path.posix.dirname(normalizedSource), pathname);
  const relativeTarget = path.posix.relative(contentRoot, target);
  if (relativeTarget === "" || relativeTarget === ".." || relativeTarget.startsWith("../")) {
    return undefined;
  }

  const route = relativeTarget.replace(MARKDOWN_EXTENSION, "");
  const sitePath = route.endsWith("/index") ? route.slice(0, -"index".length) : `${route}/`;
  return `/${sitePath}${fragment}`;
}

export default function remarkCanonicalLinks() {
  return (tree, file) => {
    visit(tree, (node) => {
      if (node.type !== "link" || typeof node.url !== "string") return;
      const route = siteRouteForMarkdownLink(file.path, node.url);
      if (route) node.url = route;
    });
  };
}
