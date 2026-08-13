import { renderMermaidSVG } from "beautiful-mermaid";

/**
 * Build-time mermaid rendering, no headless browser.
 *
 * `beautiful-mermaid` (lukilabs) is a clean-room, synchronous, zero-DOM mermaid
 * renderer. This remark plugin walks the Markdown AST, finds every ```mermaid
 * fence, and replaces it in place with an inline `<svg>` produced at build time.
 * Nothing ships to the browser but static SVG markup — no `mermaid` runtime, no
 * Playwright/Puppeteer.
 *
 * Theming is a single SVG for both colour schemes: the SVG derives every colour
 * from a handful of CSS custom properties on the `<svg>` element
 * (`--bg`, `--fg`, and optional `--line`/`--accent`/`--muted`/`--surface`/
 * `--border`). `src/styles/mermaid.css` binds those variables to Starlight's
 * theme-flipping `--sl-color-*` tokens, so the same SVG follows
 * the site's light/dark toggle with no client JS.
 *
 * The renderer inlines a Google Fonts `@import` for Inter; we strip it so the
 * build stays fully self-contained and makes no external network request, and
 * let the diagram inherit the site font stack.
 */
function cleanSvg(svg) {
  return (
    svg
      // Drop the external Google Fonts import — keep the site self-contained.
      .replace(/@import\s+url\(['"]https:\/\/fonts\.googleapis\.com[^)]*\);?/g, "")
      // Remove root inline theme defaults so the site can switch them in CSS.
      .replace(/(<svg\b[^>]*?)\sstyle="--bg:[^"]*"([^>]*>)/, "$1$2")
      // Let the diagram text inherit the site font instead of hard-coding Inter.
      .replace(
        /font-family:\s*'Inter',\s*system-ui,\s*sans-serif;/g,
        "font-family: var(--sl-font, system-ui, sans-serif);",
      )
  );
}

async function renderFence(source) {
  // renderMermaidSVG is synchronous for the diagram types we use (flowchart,
  // sequence, state, class, ER). Awaiting a string is harmless, and if a future
  // diagram type returns a promise this still resolves it.
  const svg = await renderMermaidSVG(source, {});
  return cleanSvg(String(svg));
}

export default function remarkMermaid() {
  return async function transformer(tree) {
    const targets = [];
    const nodeText = (node) => {
      if (!node || typeof node !== "object") return "";
      if (typeof node.value === "string") return node.value;
      if (!Array.isArray(node.children)) return "";
      return node.children.map(nodeText).join("");
    };
    const walk = (node, inheritedHeading = "Rennet documentation") => {
      if (!node || typeof node !== "object") return;
      let heading = inheritedHeading;
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          if (child.type === "heading") heading = nodeText(child) || heading;
          if (child.type === "code" && child.lang === "mermaid") {
            targets.push({ node: child, label: `Diagram for ${heading}` });
          } else {
            walk(child, heading);
          }
        }
      }
    };
    walk(tree);

    for (const target of targets) {
      const { node, label } = target;
      let svg;
      try {
        svg = await renderFence(node.value);
      } catch (error) {
        // Fail loud at build time rather than silently shipping a broken fence.
        throw new Error(
          `remark-mermaid: failed to render a mermaid diagram: ${error?.message ?? error}`,
        );
      }
      node.type = "html";
      const escapedLabel = label
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      node.value = `<figure class="mermaid-diagram" role="img" aria-label="${escapedLabel}">${svg}</figure>`;
      delete node.lang;
      delete node.meta;
    }
  };
}
