import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightSidebarTopics from "starlight-sidebar-topics";
import remarkMermaid from "./src/plugins/remark-mermaid.mjs";

// Static, runtime-free docs site (`astro build` -> `dist/`) for Cloudflare
// Pages. Two audiences via starlight-sidebar-topics; build-time themed mermaid
// via the local remark plugin (no headless browser).
export default defineConfig({
  site: "https://docs.rennet.dev",
  markdown: {
    // The remark plugin replaces ```mermaid fences with inline SVG before Shiki
    // runs; excludeLangs is belt-and-suspenders so a stray fence is never sent
    // to the syntax highlighter.
    syntaxHighlight: { type: "shiki", excludeLangs: ["mermaid"] },
    remarkPlugins: [remarkMermaid],
  },
  integrations: [
    starlight({
      title: "Rennet",
      description: "A local-first code review harness — using it, and building it.",
      // Same lockup the marketing site mastheads: the traced wordmark IS the
      // identity (DESIGN.md: it is not a font), so it replaces the text title.
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
                label: "Guide",
                items: [
                  { label: "Getting started", link: "/using/guide/getting-started/" },
                  { label: "Windows and WSL", link: "/using/guide/windows-and-wsl/" },
                  {
                    label: "Reviewing a GitHub PR",
                    link: "/using/guide/reviewing-a-github-pr/",
                  },
                  { label: "User journey", link: "/using/guide/user-journey/" },
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
                label: "Architecture",
                items: [
                  {
                    label: "Architecture overview",
                    link: "/developing/concepts/architecture-overview/",
                  },
                  {
                    label: "Architecture contracts",
                    link: "/developing/concepts/architecture-contracts/",
                  },
                  { label: "Canvas model", link: "/developing/concepts/canvas-model/" },
                  { label: "Review lenses", link: "/developing/concepts/review-lenses/" },
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
                  { label: "Agent handoff", link: "/developing/concepts/agent-handoff/" },
                  {
                    label: "Delta re-review and lineage",
                    link: "/developing/concepts/delta-rereview-and-lineage/",
                  },
                  {
                    label: "Comment refinement",
                    link: "/developing/concepts/comment-refinement/",
                  },
                  {
                    label: "Collation and signing",
                    link: "/developing/concepts/collation-and-signing/",
                  },
                  { label: "Design doctrine", link: "/developing/concepts/design-doctrine/" },
                ],
              },
              {
                label: "Guides",
                items: [
                  {
                    label: "Repository bootstrap",
                    link: "/developing/guide/repository-bootstrap/",
                  },
                  {
                    label: "Settings and setup",
                    link: "/developing/guide/settings-and-setup/",
                  },
                ],
              },
              {
                label: "Reference",
                items: [
                  {
                    label: "Contracts and rulings",
                    link: "/developing/reference/contracts-and-rulings/",
                  },
                  {
                    label: "Dependency standard",
                    link: "/developing/reference/dependency-standard/",
                  },
                  { label: "Delivery order", link: "/developing/reference/delivery-order/" },
                  {
                    label: "Codex app-server integration",
                    link: "/developing/reference/codex-app-server/",
                  },
                  {
                    label: "Why not RxJS?",
                    link: "/developing/reference/reactive-streams/",
                  },
                  {
                    label: "Documentation authority map",
                    link: "/developing/reference/doc-architecture/",
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
