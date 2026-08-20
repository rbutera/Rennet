import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  canonicalPathForProjection,
  discoverWorkspaceProjects,
  validateCanonicalInventory,
  validateLinks,
  validateMonorepoMap,
  validatePlannedPages,
  validateProjectionParity,
} from "./check-docs.mjs";

const temporaryRoots = [];

async function fixture() {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "rennet-docs-check-"));
  temporaryRoots.push(workspaceRoot);
  const docsRoot = path.join(workspaceRoot, "docs");
  const projectionRoot = path.join(workspaceRoot, "apps/docs/src/content/docs");
  await mkdir(docsRoot, { recursive: true });
  return { workspaceRoot, docsRoot, projectionRoot };
}

async function put(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

function codes(issues) {
  return issues.map((issue) => issue.code);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("canonical documentation inventory", () => {
  it("requires docs/README.md to link every canonical Markdown and MDX page", async () => {
    const { docsRoot } = await fixture();
    await put(
      docsRoot,
      "README.md",
      [
        "# Documentation",
        "",
        "[Guide](using/guides/review.md)",
        "",
        "[ADR](adr/0001-docs.md)",
      ].join("\n"),
    );
    await put(docsRoot, "using/guides/review.md", "# Review\n");
    await put(docsRoot, "adr/0001-docs.md", "# Docs ADR\n");
    await put(docsRoot, "developing/concepts/canvas.mdx", "# Canvas\n");

    const issues = await validateCanonicalInventory({ docsRoot });

    assert.deepEqual(codes(issues), ["inventory.missing-page"]);
    assert.match(issues[0].message, /developing\/concepts\/canvas\.mdx/);
  });

  it("does not mistake repository authority links for canonical inventory entries", async () => {
    const { docsRoot } = await fixture();
    await put(docsRoot, "README.md", "# Documentation\n\n[Product authority](../PRODUCT.md)\n");

    const issues = await validateCanonicalInventory({ docsRoot });

    assert.deepEqual(issues, []);
  });

  it("rejects reader pages outside using, developing, and adr", async () => {
    const { docsRoot } = await fixture();
    await put(docsRoot, "README.md", "# Documentation\n\n[Loose page](loose.md)\n");
    await put(docsRoot, "loose.md", "# Loose page\n");

    const issues = await validateCanonicalInventory({ docsRoot });

    assert.deepEqual(codes(issues), ["inventory.invalid-location"]);
  });
});

describe("source-relative documentation links", () => {
  it("resolves canonical files and GitHub heading anchors", async () => {
    const { workspaceRoot, docsRoot } = await fixture();
    await put(
      docsRoot,
      "README.md",
      "# Documentation\n\n[Guide](using/guide.md)\n[Concept](using/concept.md)\n",
    );
    await put(
      docsRoot,
      "using/guide.md",
      [
        "# Guide",
        "",
        "[Second duplicate](concept.md#same-heading-1)",
        "",
        "[Source](../../packages/core/src/index.ts)",
      ].join("\n"),
    );
    await put(docsRoot, "using/concept.md", "# Concept\n\n## Same heading\n\n## Same heading\n");
    await put(workspaceRoot, "packages/core/src/index.ts", "export {};\n");
    await put(workspaceRoot, "openspec/specs/canvas/spec.md", "# Canvas contract\n");
    await put(
      docsRoot,
      "using/guide.md",
      [
        "# Guide",
        "",
        "[Second duplicate](concept.md#same-heading-1)",
        "",
        "[Source](../../packages/core/src/index.ts)",
        "",
        "[Specs](../../openspec/specs/)",
      ].join("\n"),
    );

    assert.deepEqual(await validateLinks({ workspaceRoot, docsRoot }), []);
  });

  it("names root-absolute links, missing files, and missing headings", async () => {
    const { workspaceRoot, docsRoot } = await fixture();
    await put(docsRoot, "README.md", "# Documentation\n\n[Guide](using/guide.md)\n");
    await put(
      docsRoot,
      "using/guide.md",
      [
        "# Guide",
        "",
        "[Site-only](/using/concept/)",
        "[Gone](missing.md)",
        "[Wrong heading](guide.md#absent)",
      ].join("\n"),
    );

    const issues = await validateLinks({ workspaceRoot, docsRoot });

    assert.deepEqual(codes(issues), [
      "link.not-source-relative",
      "link.missing-target",
      "link.missing-heading",
    ]);
  });
});

describe("planned-page metadata", () => {
  it("requires an HTTPS tracking URL on every planned page", async () => {
    const { docsRoot } = await fixture();
    await put(docsRoot, "README.md", "# Documentation\n");
    await put(
      docsRoot,
      "developing/plans/no-tracker.md",
      "---\ntitle: No tracker\nstatus: planned\n---\n# No tracker\n",
    );
    await put(
      docsRoot,
      "developing/plans/not-planned.md",
      "---\ntitle: Wrong status\nstatus: current\ntracking: https://github.com/rbutera/rennet/issues/1\n---\n# Wrong\n",
    );
    await put(
      docsRoot,
      "using/guides/future.md",
      "---\ntitle: Future\nstatus: planned\ntracking: issue-2\n---\n# Future\n",
    );

    const issues = await validatePlannedPages({ docsRoot });

    assert.deepEqual(codes(issues), [
      "planned.invalid-tracking",
      "planned.invalid-status",
      "planned.invalid-tracking",
    ]);
  });
});

describe("canonical projection", () => {
  it("reports missing, stale, and byte-different projected pages", async () => {
    const { docsRoot, projectionRoot } = await fixture();
    await put(docsRoot, "README.md", "# Repository entry point\n");
    await put(docsRoot, "using/index.md", "# Using Rennet\n");
    await put(docsRoot, "developing/index.mdx", "# Developing Rennet\n");
    await put(projectionRoot, "using/index.md", "# Stale copy\n");
    await put(projectionRoot, "retired.md", "# Retired\n");
    await put(projectionRoot, "index.mdx", "# Site-only homepage\n");

    const issues = await validateProjectionParity({ docsRoot, projectionRoot });

    assert.deepEqual(codes(issues), [
      "projection.content-mismatch",
      "projection.missing-page",
      "projection.unexpected-page",
    ]);
  });

  it("maps a projected file to its canonical source and rejects escapes", async () => {
    const { docsRoot, projectionRoot } = await fixture();
    const projectedPath = path.join(projectionRoot, "using/index.md");

    assert.equal(
      canonicalPathForProjection({ docsRoot, projectionRoot, projectedPath }),
      path.join(docsRoot, "using/index.md"),
    );
    assert.throws(
      () =>
        canonicalPathForProjection({
          docsRoot,
          projectionRoot,
          projectedPath: path.join(projectionRoot, "../outside.md"),
        }),
      /outside the generated documentation projection/,
    );
    assert.throws(
      () =>
        canonicalPathForProjection({
          docsRoot,
          projectionRoot,
          projectedPath: path.join(projectionRoot, "index.mdx"),
        }),
      /site-only documentation homepage/,
    );
  });
});

describe("monorepo map", () => {
  it("discovers nested Nx projects by resolved project name and manifest", async () => {
    const { workspaceRoot } = await fixture();
    await put(
      workspaceRoot,
      "apps/desktop/project.json",
      JSON.stringify({ name: "rennet-desktop", projectType: "application" }),
    );
    await put(
      workspaceRoot,
      "apps/desktop/package.json",
      JSON.stringify({ name: "@rennet/desktop", private: true }),
    );
    await put(
      workspaceRoot,
      "packages/group/core/project.json",
      JSON.stringify({ name: "rennet-core", projectType: "library" }),
    );
    await put(
      workspaceRoot,
      "packages/group/core/package.json",
      JSON.stringify({ name: "@rennet/core", private: true }),
    );
    await put(
      workspaceRoot,
      "spikes/evidence/project.json",
      JSON.stringify({ name: "evidence-spike", projectType: "library" }),
    );

    const projects = await discoverWorkspaceProjects({ workspaceRoot });

    assert.deepEqual(projects, [
      {
        name: "rennet-desktop",
        packageName: "@rennet/desktop",
        root: "apps/desktop",
        type: "application",
      },
      {
        name: "rennet-core",
        packageName: "@rennet/core",
        root: "packages/group/core",
        type: "library",
      },
    ]);
  });

  it("reads separate application and package tables", async () => {
    const { workspaceRoot, docsRoot } = await fixture();
    await put(
      workspaceRoot,
      "apps/desktop/project.json",
      JSON.stringify({ name: "rennet-desktop", projectType: "application" }),
    );
    await put(
      workspaceRoot,
      "apps/desktop/package.json",
      JSON.stringify({ name: "@rennet/desktop", private: true }),
    );
    await put(
      workspaceRoot,
      "packages/core/project.json",
      JSON.stringify({ name: "rennet-core", projectType: "library" }),
    );
    await put(
      workspaceRoot,
      "packages/core/package.json",
      JSON.stringify({ name: "@rennet/core", private: true }),
    );
    const header = [
      "| Nx project | Package | Root | Responsibility | Allowed in-repository dependencies |",
      "| --- | --- | --- | --- | --- |",
    ];
    await put(
      docsRoot,
      "developing/reference/monorepo-map.md",
      [
        "# Monorepo map",
        "",
        "## Applications",
        "",
        ...header,
        "| `rennet-desktop` | `@rennet/desktop` | `apps/desktop` | Desktop app | Any package |",
        "",
        "## Packages",
        "",
        ...header,
        "| `rennet-core` | `@rennet/core` | `packages/core` | Review behavior | None |",
      ].join("\n"),
    );

    assert.deepEqual(await validateMonorepoMap({ workspaceRoot, docsRoot }), []);
  });

  it("fails when the monorepo map omits or misidentifies a project", async () => {
    const { workspaceRoot, docsRoot } = await fixture();
    await put(
      workspaceRoot,
      "apps/desktop/project.json",
      JSON.stringify({ name: "rennet-desktop", projectType: "application" }),
    );
    await put(
      workspaceRoot,
      "apps/desktop/package.json",
      JSON.stringify({ name: "@rennet/desktop", private: true }),
    );
    await put(
      workspaceRoot,
      "packages/core/project.json",
      JSON.stringify({ name: "rennet-core", projectType: "library" }),
    );
    await put(
      workspaceRoot,
      "packages/core/package.json",
      JSON.stringify({ name: "@rennet/core", private: true }),
    );
    await put(
      docsRoot,
      "developing/reference/monorepo-map.md",
      [
        "# Monorepo map",
        "",
        "| Nx project | Package | Root | Responsibility | Allowed in-repository dependencies |",
        "| --- | --- | --- | --- | --- |",
        "| `rennet-desktop` | `@rennet/wrong` | `apps/desktop` | Desktop app | Any package |",
      ].join("\n"),
    );

    const issues = await validateMonorepoMap({ workspaceRoot, docsRoot });

    assert.deepEqual(codes(issues), ["monorepo.package-mismatch", "monorepo.missing-project"]);
    assert.match(issues[1].message, /rennet-core/);
  });
});
