import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightSidebarTopics from "starlight-sidebar-topics";
import docsProjection from "./src/plugins/docs-projection-integration";
import remarkCanonicalLinks from "./src/plugins/remark-canonical-links.mjs";
import remarkMermaid from "./src/plugins/remark-mermaid.mjs";

// Cloudflare Pages serves the static output. Starlight Sidebar Topics separates
// reader and contributor navigation. The local Mermaid plugin renders diagrams
// during the build without a browser.
export default defineConfig({
  site: "https://docs.rennet.dev",
  markdown: {
    // The remark plugin replaces ```mermaid fences with inline SVG before Shiki
    // runs; excludeLangs is belt-and-suspenders so a stray fence is never sent
    // to the syntax highlighter.
    syntaxHighlight: { type: "shiki", excludeLangs: ["mermaid"] },
    remarkPlugins: [remarkCanonicalLinks, remarkMermaid],
  },
  integrations: [
    docsProjection(),
    starlight({
      title: "Rennet",
      description: "How to use and build the local-first Rennet review harness.",
      editLink: {
        baseUrl: "https://github.com/rbutera/rennet/edit/main/apps/docs/",
      },
      lastUpdated: true,
      routeMiddleware: "./src/plugins/canonical-route-data.ts",
      // This traced lockup is the product identity, not text in a matching font.
      logo: {
        light: "./src/assets/lockup-horizontal-black.svg",
        dark: "./src/assets/lockup-horizontal-white.svg",
        replacesTitle: true,
      },
      customCss: ["./src/styles/theme.css", "./src/styles/mermaid.css"],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/rbutera/rennet" }],
      plugins: [
        starlightSidebarTopics([
          {
            label: "Using Rennet",
            link: "/using/",
            icon: "open-book",
            items: [
              {
                label: "Guides",
                items: [
                  { label: "Getting started", link: "/using/guides/getting-started/" },
                  {
                    label: "Install a coding harness",
                    link: "/using/guides/install-a-coding-harness/",
                  },
                  { label: "The onboarding tour", link: "/using/guides/onboarding-tour/" },
                  { label: "Connect to GitHub", link: "/using/guides/github-auth/" },
                  { label: "Windows and WSL", link: "/using/guides/windows-and-wsl/" },
                  {
                    label: "Reviewing a GitHub PR",
                    link: "/using/guides/reviewing-a-github-pr/",
                  },
                  { label: "The Context Map", link: "/using/guides/context-map/" },
                  { label: "Remote access", link: "/using/guides/remote-access/" },
                  { label: "Rennet in a browser", link: "/using/guides/browser-rennet/" },
                  { label: "Rennet on your phone (planned)", link: "/using/guides/mobile/" },
                ],
              },
              {
                label: "Concepts",
                items: [
                  { label: "Product and vision", link: "/using/concepts/product-and-vision/" },
                  { label: "Common questions", link: "/using/concepts/common-questions/" },
                ],
              },
            ],
          },
          {
            label: "Developing Rennet",
            link: "/developing/",
            icon: "setting",
            items: [
              {
                label: "Concepts",
                items: [
                  {
                    label: "Architecture overview",
                    link: "/developing/concepts/architecture-overview/",
                  },
                  {
                    label: "Architecture contracts",
                    link: "/developing/concepts/architecture-contracts/",
                  },
                  {
                    label: "The lens pipeline",
                    link: "/developing/concepts/lens-pipeline/",
                  },
                  {
                    label: "Hand off and the exits",
                    link: "/developing/concepts/handoff-and-exits/",
                  },
                  { label: "Context assembly", link: "/developing/concepts/context-assembly/" },
                  {
                    label: "Code intelligence",
                    link: "/developing/concepts/code-intelligence/",
                  },
                  { label: "Model council", link: "/developing/concepts/model-council/" },
                  {
                    label: "Surfacing and routing",
                    link: "/developing/concepts/surfacing-and-routing/",
                  },
                  { label: "Harness adapters", link: "/developing/concepts/harness-adapters/" },
                  { label: "The WSL daemon", link: "/developing/concepts/wsl-daemon/" },
                  {
                    label: "Delta and generations",
                    link: "/developing/concepts/delta-rereview-and-lineage/",
                  },
                  { label: "Design doctrine", link: "/developing/concepts/design-doctrine/" },
                ],
              },
              {
                label: "Guides",
                items: [
                  {
                    label: "Repository bootstrap",
                    link: "/developing/guides/repository-bootstrap/",
                  },
                  {
                    label: "Settings and setup",
                    link: "/developing/guides/settings-and-setup/",
                  },
                ],
              },
              {
                label: "Plans",
                items: [
                  {
                    label: "Board rebuild plan",
                    link: "/developing/plans/board-rebuild-plan/",
                  },
                  {
                    label: "Context map rebuild plan",
                    link: "/developing/plans/context-map-rebuild-plan/",
                  },
                  {
                    label: "Performance audit (2026-08-31)",
                    link: "/developing/plans/perf-audit-2026-08-31/",
                  },
                ],
              },
              {
                label: "Decisions",
                items: [
                  {
                    label: "Contracts and rulings",
                    link: "/developing/decisions/contracts-and-rulings/",
                  },
                  {
                    label: "Tray quit owns the daemon",
                    link: "/adr/0001-tray-quit-owns-the-daemon/",
                  },
                  {
                    label: "Root docs own the library",
                    link: "/adr/0002-root-docs-own-the-library/",
                  },
                  {
                    label: "Browse WSL via its own daemon",
                    link: "/adr/0003-browse-wsl-via-in-distro-daemon/",
                  },
                ],
              },
              {
                label: "Reference",
                items: [
                  {
                    label: "Dependency standard",
                    link: "/developing/reference/dependency-standard/",
                  },
                  {
                    label: "Protocol compatibility",
                    link: "/developing/reference/protocol-compatibility/",
                  },
                  {
                    label: "Codex app-server integration",
                    link: "/developing/reference/codex-app-server/",
                  },
                  {
                    label: "Command menu exposure",
                    link: "/developing/reference/command-menu-exposure/",
                  },
                  {
                    label: "Streaming and durable state",
                    link: "/developing/reference/reactive-streams/",
                  },
                  {
                    label: "Documentation authority map",
                    link: "/developing/reference/doc-architecture/",
                  },
                  {
                    label: "Monorepo map",
                    link: "/developing/reference/monorepo-map/",
                  },
                  {
                    label: "How Rennet consumes @wboard/*",
                    link: "/developing/reference/whiteboard-consumption/",
                  },
                  {
                    label: "Spec formats",
                    items: [{ autogenerate: { directory: "developing/reference/spec-formats" } }],
                  },
                ],
              },
              {
                label: "Contributing",
                items: [{ autogenerate: { directory: "developing/contributing" } }],
              },
            ],
          },
        ]),
      ],
    }),
  ],
});
