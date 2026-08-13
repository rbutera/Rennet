import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightSidebarTopics from "starlight-sidebar-topics";
import remarkMermaid from "./src/plugins/remark-mermaid.mjs";

// Static, runtime-free docs site (`astro build` -> `dist/`) for free Cloudflare
// Pages. Two audiences via starlight-sidebar-topics; build-time themed mermaid
// via the local remark plugin (no headless browser). Framework rationale:
// docs/ + openspec/changes/rennet-docsite + ~/expedition/Rennet Docsite Framework.md
export default defineConfig({
  // Preview target; the docs.rennet.dev custom domain is wired once rennet.dev
  // is on Cloudflare (external setup, see the PR body).
  site: "https://rennet-docs.pages.dev",
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
      customCss: ["./src/styles/mermaid.css"],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/rbutera/rennet" },
      ],
      plugins: [
        starlightSidebarTopics([
          {
            label: "Using Rennet",
            link: "/using/",
            icon: "open-book",
            items: [
              { label: "Guide", items: [{ autogenerate: { directory: "using/guide" } }] },
              { label: "Concepts", items: [{ autogenerate: { directory: "using/concepts" } }] },
            ],
          },
          {
            label: "Developing Rennet",
            link: "/developing/",
            icon: "setting",
            items: [
              { label: "Guide", items: [{ autogenerate: { directory: "developing/guide" } }] },
              { label: "Concepts", items: [{ autogenerate: { directory: "developing/concepts" } }] },
              { label: "Reference", items: [{ autogenerate: { directory: "developing/reference" } }] },
              { label: "Contributing", items: [{ autogenerate: { directory: "developing/contributing" } }] },
            ],
          },
        ]),
      ],
    }),
  ],
});
