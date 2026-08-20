import { describe, expect, it } from "vitest";
import remarkCanonicalLinks, { siteRouteForMarkdownLink } from "./remark-canonical-links.mjs";

describe("canonical documentation links", () => {
  it("maps source-relative Markdown files to Starlight routes", () => {
    const source = "/repo/apps/docs/src/content/docs/using/index.md";

    expect(siteRouteForMarkdownLink(source, "./guides/getting-started.md")).toBe(
      "/using/guides/getting-started/",
    );
    expect(siteRouteForMarkdownLink(source, "../developing/index.mdx#setup")).toBe(
      "/developing/#setup",
    );
  });

  it("leaves external, site-absolute, and non-Markdown destinations alone", () => {
    const source = "/repo/apps/docs/src/content/docs/using/index.md";

    expect(siteRouteForMarkdownLink(source, "https://github.com/rbutera/rennet")).toBeUndefined();
    expect(siteRouteForMarkdownLink(source, "/developing/")).toBeUndefined();
    expect(siteRouteForMarkdownLink(source, "./image.png")).toBeUndefined();
    expect(siteRouteForMarkdownLink(source, "../../../README.md")).toBeUndefined();
  });

  it("rewrites link nodes in the Markdown tree", () => {
    const tree = {
      type: "root",
      children: [
        { type: "link", url: "./concept.md", children: [] },
        { type: "link", url: "https://example.com/readme.md", children: [] },
      ],
    };

    remarkCanonicalLinks()(tree, {
      path: "/repo/apps/docs/src/content/docs/using/index.md",
    });

    expect(tree.children.map((node) => node.url)).toEqual([
      "/using/concept/",
      "https://example.com/readme.md",
    ]);
  });
});
