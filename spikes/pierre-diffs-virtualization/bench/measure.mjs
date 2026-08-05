/**
 * Playwright driver for the spike.
 *
 * Starts nothing: point it at an already-running dev server (npm run dev) or
 * a `vite preview` build. Runs each (mode, size, stall) cell, records initial
 * render, a fast programmatic scroll, DOM node counts and JS heap, and writes
 * results.json + a markdown table.
 *
 * Deliberately runs HEADED by default: headless Chromium's compositor is not
 * the thing we are shipping to, and frame timing is the whole question.
 * Pass --headless to compare.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SPIKE_URL ?? 'http://localhost:5199';
const HEADLESS = process.argv.includes('--headless');
const REPEATS = Number(process.env.SPIKE_REPEATS ?? '3');

// The matrix. Calibration cells run FIRST so a broken harness fails loudly
// before any clean number is produced.
const CELLS = [
  // --- instrument floor: no diff renderer at all. Establishes the machine's
  // frame ceiling so a clean library number can be told apart from a display
  // that simply cannot go faster. ---
  { mode: 'idle', size: 'small', stall: 0, tag: 'FLOOR-idle-scroller' },
  { mode: 'idle', size: 'small', stall: 50, tag: 'FLOOR-idle+50ms-stall' },

  // --- calibration: the instrument must detect deliberate jank ---
  { mode: 'pierre-virtual', size: 'medium', stall: 0, tag: 'calibration-baseline' },
  { mode: 'pierre-virtual', size: 'medium', stall: 8, tag: 'calibration-stall-8ms' },
  { mode: 'pierre-virtual', size: 'medium', stall: 50, tag: 'calibration-stall-50ms' },

  // --- Pierre, virtualized (Virtualizer in the tree) ---
  { mode: 'pierre-virtual', size: 'small', stall: 0 },
  { mode: 'pierre-virtual', size: 'medium', stall: 0 },
  { mode: 'pierre-virtual', size: 'large', stall: 0 },

  // --- Pierre, no Virtualizer (renders everything) ---
  { mode: 'pierre-plain', size: 'small', stall: 0 },
  { mode: 'pierre-plain', size: 'medium', stall: 0 },
  { mode: 'pierre-plain', size: 'large', stall: 0 },

  // --- THE crux cell: ONE 5,000-line file. Distinguishes line-level
  // windowing inside a file from mere file-level composition. ---
  { mode: 'pierre-virtual', size: 'mono', stall: 0, tag: 'CRUX pierre-virtual / 1 file x 5k' },
  { mode: 'pierre-plain', size: 'mono', stall: 0, tag: 'CRUX pierre-plain / 1 file x 5k' },
  { mode: 'tanstack', size: 'mono', stall: 0, tag: 'CRUX tanstack / 1 file x 5k' },

  // --- CodeView: the path Pierre's own docs call the more optimized one for
  // an all-code scroll region, which is what a review surface is. ---
  { mode: 'pierre-codeview', size: 'small', stall: 0 },
  { mode: 'pierre-codeview', size: 'medium', stall: 0 },
  { mode: 'pierre-codeview', size: 'large', stall: 0 },
  { mode: 'pierre-codeview', size: 'mono', stall: 0, tag: 'CRUX pierre-codeview / 1 file x 5k' },
  { mode: 'pierre-codeview', size: 'medium', stall: 50, tag: 'calibration-codeview-stall-50ms' },

  // --- fallback: @tanstack/react-virtual + shiki in a worker ---
  { mode: 'tanstack', size: 'small', stall: 0 },
  { mode: 'tanstack', size: 'medium', stall: 0 },
  { mode: 'tanstack', size: 'large', stall: 0 },
];

// SPIKE_ONLY=<substring> runs just the cells whose tag/mode/size matches.
// SPIKE_OUT=<name> writes results/<name>.json|.md instead of results/results.*
const ONLY = process.env.SPIKE_ONLY;
const OUT = process.env.SPIKE_OUT ?? 'results';
const SELECTED = ONLY
  ? CELLS.filter((c) => ONLY.split(',').some((t) => `${c.tag ?? ''} ${c.mode} ${c.size}`.includes(t.trim())))
  : CELLS;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function runCell(cell) {
  // A FRESH BROWSER PER RUN, deliberately. Reusing one browser across cells
  // accumulated GPU/renderer resources and eventually crashed the tab on the
  // 5k cell -- which would have read as "the library falls over at 5k". It
  // does not; the harness did. Isolation is cheap and the wrong conclusion
  // was not.
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const url = `${BASE}/?mode=${cell.mode}&size=${cell.size}&stall=${cell.stall}`;
  await page.goto(url, { waitUntil: 'load' });

  const ready = await page.waitForFunction(() => window.__spikeReady, null, { timeout: 180000 })
    .then((h) => h.jsonValue());

  // Let the worker pool and any deferred highlight settle before scrolling.
  await page.waitForTimeout(600);

  const scroll = await page.evaluate(() => window.__spikeScroll({ passes: 2, pxPerFrame: 200 }));
  const display = await page.evaluate(() => ({
    dpr: devicePixelRatio,
    screen: `${screen.width}x${screen.height}`,
    hw: navigator.hardwareConcurrency,
  }));

  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = Object.fromEntries(
    (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
  );

  await context.close();
  await browser.close();
  return { url, ...cell, ready, scroll, display, cdp: { Nodes: metrics.Nodes, JSHeapUsedSize: metrics.JSHeapUsedSize, LayoutCount: metrics.LayoutCount, RecalcStyleCount: metrics.RecalcStyleCount }, errors };
}

const results = [];

for (const cell of SELECTED) {
  const runs = [];
  for (let i = 0; i < REPEATS; i += 1) {
    process.stdout.write(`  ${cell.mode}/${cell.size}/stall=${cell.stall} run ${i + 1}/${REPEATS}\r`);
    runs.push(await runCell(cell));
  }
  const agg = {
    ...cell,
    url: runs[0].url,
    runs: runs.length,
    renderMs: median(runs.map((r) => r.ready.renderMs)),
    renderedLines: runs[0].ready.renderedLines,
    domNodesAfterRender: median(runs.map((r) => r.ready.domNodes)),
    domNodesAfterScroll: median(runs.map((r) => r.scroll.after.domNodes)),
    renderedLinesAfterScroll: median(runs.map((r) => r.scroll.after.renderedLines)),
    tokenSpansAfterRender: median(runs.map((r) => r.ready.tokenSpans)),
    tokenSpansAfterScroll: median(runs.map((r) => r.scroll.after.tokenSpans)),
    heapAfterRenderMB: round(median(runs.map((r) => r.ready.heapAfterRenderBytes ?? 0)) / 1048576),
    heapAfterScrollMB: round(median(runs.map((r) => r.scroll.after.heap ?? 0)) / 1048576),
    cdpNodes: median(runs.map((r) => r.cdp.Nodes ?? 0)),
    cdpHeapMB: round(median(runs.map((r) => r.cdp.JSHeapUsedSize ?? 0)) / 1048576),
    fps: round(median(runs.map((r) => r.scroll.fps))),
    frameP50: round(median(runs.map((r) => r.scroll.frameMs.p50))),
    frameP95: round(median(runs.map((r) => r.scroll.frameMs.p95))),
    frameP99: round(median(runs.map((r) => r.scroll.frameMs.p99))),
    frameMax: round(median(runs.map((r) => r.scroll.frameMs.max))),
    frames: median(runs.map((r) => r.scroll.frames)),
    over16_7ms: median(runs.map((r) => r.scroll.over16_7ms)),
    over50ms: median(runs.map((r) => r.scroll.over50ms)),
    longtaskCount: median(runs.map((r) => r.scroll.longtasks.count)),
    longtaskTotalMs: round(median(runs.map((r) => r.scroll.longtasks.totalMs))),
    longtaskMaxMs: round(median(runs.map((r) => r.scroll.longtasks.maxMs))),
    display: runs[0].display,
    errors: [...new Set(runs.flatMap((r) => r.errors))].slice(0, 5),
    raw: runs,
  };
  results.push(agg);
  console.log(
    `  ${pad(cell.tag ?? `${cell.mode}/${cell.size}`, 30)} render ${pad(agg.renderMs + 'ms', 10)} ` +
    `p50 ${pad(agg.frameP50 + 'ms', 8)} p95 ${pad(agg.frameP95 + 'ms', 9)} max ${pad(agg.frameMax + 'ms', 9)} ` +
    `nodes ${pad(agg.domNodesAfterScroll, 8)} heap ${agg.heapAfterScrollMB}MB` +
    (agg.errors.length ? `  ERRORS: ${agg.errors[0].slice(0, 80)}` : ''),
  );
}

mkdirSync(resolve(__dirname, '../results'), { recursive: true });
writeFileSync(
  resolve(__dirname, `../results/${OUT}.json`),
  JSON.stringify({ generatedAt: new Date().toISOString(), headless: HEADLESS, repeats: REPEATS, results }, null, 2),
);
writeFileSync(resolve(__dirname, `../results/${OUT}.md`), toMarkdown(results));
console.log(`\nWrote results/${OUT}.json and results/${OUT}.md`);

function toMarkdown(rows) {
  const head = '| cell | render ms | code rows mounted | token spans mounted | DOM nodes | heap MB | fps | p50 | p95 | p99 | max | >16.7ms | longtasks (n / max ms) |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const body = rows.map((r) => `| ${r.tag ?? `${r.mode} / ${r.size}`} | ${r.renderMs} | ${r.renderedLinesAfterScroll} | ${r.tokenSpansAfterScroll} | ${r.domNodesAfterScroll} | ${r.heapAfterScrollMB} | ${r.fps} | ${r.frameP50} | ${r.frameP95} | ${r.frameP99} | ${r.frameMax} | ${r.over16_7ms} | ${r.longtaskCount} / ${r.longtaskMaxMs} |`);
  return [head, sep, ...body].join('\n') + '\n';
}

function round(n) { return Math.round(n * 100) / 100; }
function pad(s, n) { return String(s).padEnd(n); }
