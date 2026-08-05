/**
 * Shiki-in-a-worker for the @tanstack/react-virtual fallback path.
 *
 * This is the design the stack note specifies: highlight off the main thread,
 * post token arrays back (never HTML strings for a whole file), and only for
 * the lines the virtualizer has actually windowed in.
 *
 * Uses the JS regex engine so there is no Oniguruma WASM fetch.
 */
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

let highlighterPromise = null;

async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import('@shikijs/themes/github-dark')],
      langs: [import('@shikijs/langs/typescript')],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

self.onmessage = async (e) => {
  const { id, lines } = e.data;
  const hl = await getHighlighter();

  // codeToTokens over the joined block keeps grammar state across lines, which
  // is what you want for multi-line constructs (template literals, comments).
  const code = lines.join('\n');
  const { tokens } = hl.codeToTokens(code, { lang: 'typescript', theme: 'github-dark' });

  // Flatten to a compact transferable-ish shape: per line, [text, color][]
  const out = tokens.map((line) => line.map((t) => [t.content, t.color || '']));
  self.postMessage({ id, tokens: out });
};
