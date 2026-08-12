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
 * from a handful of CSS custom properties set inline on the `<svg>` element
 * (`--bg`, `--fg`, and optional `--line`/`--accent`/`--muted`/`--surface`/
 * `--border`). `src/styles/mermaid.css` overrides those variables (with
 * `!important`, which beats the inline non-important declaration) and binds them
 * to Starlight's theme-flipping `--sl-color-*` tokens, so the same SVG follows
 * the site's light/dark toggle with no client JS.
 *
 * The renderer inlines a Google Fonts `@import` for Inter; we strip it so the
 * build stays fully self-contained and makes no external network request, and
 * let the diagram inherit the site font stack.
 */
function cleanSvg(svg) {
  return svg
    // Drop the external Google Fonts import — keep the site self-contained.
    .replace(/@import\s+url\(['"]https:\/\/fonts\.googleapis\.com[^)]*\);?/g, "")
    // Let the diagram text inherit the site font instead of hard-coding Inter.
    .replace(
      /font-family:\s*'Inter',\s*system-ui,\s*sans-serif;/g,
      "font-family: var(--sl-font, system-ui, sans-serif);",
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
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "code" && node.lang === "mermaid") targets.push(node);
      if (Array.isArray(node.children)) for (const child of node.children) walk(child);
    };
    walk(tree);

    for (const node of targets) {
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
      node.value = `<figure class="mermaid-diagram" role="img">${svg}</figure>`;
      delete node.lang;
      delete node.meta;
    }
  };
}
