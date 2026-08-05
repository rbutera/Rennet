/**
 * Turns results/results.json into the tables used in the vault write-up.
 * Grouped by the question each table answers, not by cell order.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(resolve(__dirname, '../results/results.json'), 'utf8'));
const by = (tagOrMode, size) => data.results.find(
  (r) => (r.tag === tagOrMode || (r.mode === tagOrMode && r.size === size)) && (size === undefined || r.size === size),
);

const fmt = (n) => (n === undefined || n === null ? '—' : typeof n === 'number' ? String(n) : n);
const N = (n) => (n === undefined || n === null ? '—' : n.toLocaleString('en-GB'));

function table(header, rows) {
  const sep = header.map(() => '---');
  return [`| ${header.join(' | ')} |`, `|${sep.join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

const perf = (r) => [fmt(r.fps), `${fmt(r.frameP50)}`, `${fmt(r.frameP95)}`, `${fmt(r.frameP99)}`, `${fmt(r.frameMax)}`, fmt(r.over16_7ms), `${fmt(r.longtaskCount)} / ${fmt(r.longtaskMaxMs)}`];

console.log('### Calibration: does the instrument detect jank?\n');
console.log(table(
  ['cell', 'what it is', 'fps', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'frames >16.7ms', 'longtasks n / max ms'],
  [
    ['`FLOOR-idle-scroller`', 'empty scroller, no renderer', ...perf(by('FLOOR-idle-scroller'))],
    ['`FLOOR-idle+50ms-stall`', 'same, 50ms stall per frame', ...perf(by('FLOOR-idle+50ms-stall'))],
    ['`calibration-baseline`', 'Pierre virtualized, 2k, no stall', ...perf(by('calibration-baseline'))],
    ['`calibration-stall-8ms`', 'same + 8ms stall per frame', ...perf(by('calibration-stall-8ms'))],
    ['`calibration-stall-50ms`', 'same + 50ms stall per frame', ...perf(by('calibration-stall-50ms'))],
  ].filter((r) => r[2] !== undefined),
));

console.log('\n### Scroll performance by size\n');
console.log(table(
  ['path', 'diff size', 'fps', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'frames >16.7ms', 'longtasks n / max ms'],
  [
    ['Pierre + `<Virtualizer>`', '~500 / 6 files', ...perf(by('pierre-virtual', 'small'))],
    ['Pierre + `<Virtualizer>`', '~2,000 / 18 files', ...perf(by('pierre-virtual', 'medium'))],
    ['Pierre + `<Virtualizer>`', '~5,000 / 34 files', ...perf(by('pierre-virtual', 'large'))],
    ['Pierre, no Virtualizer', '~500 / 6 files', ...perf(by('pierre-plain', 'small'))],
    ['Pierre, no Virtualizer', '~2,000 / 18 files', ...perf(by('pierre-plain', 'medium'))],
    ['Pierre, no Virtualizer', '~5,000 / 34 files', ...perf(by('pierre-plain', 'large'))],
    ['react-virtual + worker', '~500 / 6 files', ...perf(by('tanstack', 'small'))],
    ['react-virtual + worker', '~2,000 / 18 files', ...perf(by('tanstack', 'medium'))],
    ['react-virtual + worker', '~5,000 / 34 files', ...perf(by('tanstack', 'large'))],
  ].filter((r) => r[2] !== undefined),
));

console.log('\n### Cost: render time, mounted DOM, memory\n');
const cost = (r) => [fmt(r.renderMs), N(r.renderedLinesAfterScroll), N(r.tokenSpansAfterScroll), N(r.domNodesAfterScroll), fmt(r.heapAfterRenderMB), fmt(r.heapAfterScrollMB)];
console.log(table(
  ['path', 'diff size', 'render ms', 'code rows mounted', 'token spans mounted', 'DOM nodes', 'heap MB (render)', 'heap MB (after scroll)'],
  [
    ['Pierre + `<Virtualizer>`', '~500', ...cost(by('pierre-virtual', 'small'))],
    ['Pierre + `<Virtualizer>`', '~2,000', ...cost(by('pierre-virtual', 'medium'))],
    ['Pierre + `<Virtualizer>`', '~5,000', ...cost(by('pierre-virtual', 'large'))],
    ['Pierre, no Virtualizer', '~500', ...cost(by('pierre-plain', 'small'))],
    ['Pierre, no Virtualizer', '~2,000', ...cost(by('pierre-plain', 'medium'))],
    ['Pierre, no Virtualizer', '~5,000', ...cost(by('pierre-plain', 'large'))],
    ['react-virtual + worker', '~500', ...cost(by('tanstack', 'small'))],
    ['react-virtual + worker', '~2,000', ...cost(by('tanstack', 'medium'))],
    ['react-virtual + worker', '~5,000', ...cost(by('tanstack', 'large'))],
  ].filter((r) => r[2] !== undefined),
));

console.log('\n### The crux: ONE file of 5,000 changed lines\n');
const crux = ['CRUX pierre-virtual / 1 file x 5k', 'CRUX pierre-plain / 1 file x 5k', 'CRUX tanstack / 1 file x 5k'];
console.log(table(
  ['path', 'render ms', 'code rows mounted', 'token spans', 'DOM nodes', 'heap MB', 'fps', 'p50 ms', 'p95 ms', 'max ms', 'longtasks n / max ms'],
  crux.map((t) => {
    const r = by(t);
    if (!r) return null;
    return [t.replace('CRUX ', '').replace(' / 1 file x 5k', ''), fmt(r.renderMs), N(r.renderedLinesAfterScroll), N(r.tokenSpansAfterScroll), N(r.domNodesAfterScroll), fmt(r.heapAfterScrollMB), fmt(r.fps), fmt(r.frameP50), fmt(r.frameP95), fmt(r.frameMax), `${fmt(r.longtaskCount)} / ${fmt(r.longtaskMaxMs)}`];
  }).filter(Boolean),
));

// --- CodeView pass (separate file, run on a later build with anchor cells
// re-run to prove the two datasets are comparable) ---
let cv = null;
try { cv = JSON.parse(readFileSync(resolve(__dirname, '../results/results-codeview.json'), 'utf8')); } catch { /* not run */ }
if (cv) {
  const cvBy = (mode, size, tag) => cv.results.find((r) => (tag ? r.tag === tag : r.mode === mode && r.size === size));
  console.log('\n### CodeView (the path Pierre recommends for an all-code scroll region)\n');
  console.log(table(
    ['cell', 'render ms', 'code rows mounted', 'token spans', 'DOM nodes', 'heap MB', 'fps', 'p50 ms', 'p95 ms', 'max ms', 'longtasks n / max ms'],
    [
      ['CodeView / ~500', cvBy('pierre-codeview', 'small')],
      ['CodeView / ~2,000', cvBy('pierre-codeview', 'medium')],
      ['CodeView / ~5,000', cvBy('pierre-codeview', 'large')],
      ['CodeView / 1 file x 5k', cvBy(null, null, 'CRUX pierre-codeview / 1 file x 5k')],
      ['CodeView / 2k + 50ms stall', cvBy(null, null, 'calibration-codeview-stall-50ms')],
    ].filter(([, r]) => r).map(([label, r]) => [label, fmt(r.renderMs), N(r.renderedLinesAfterScroll), N(r.tokenSpansAfterScroll), N(r.domNodesAfterScroll), fmt(r.heapAfterScrollMB), fmt(r.fps), fmt(r.frameP50), fmt(r.frameP95), fmt(r.frameMax), `${fmt(r.longtaskCount)} / ${fmt(r.longtaskMaxMs)}`]),
  ));

  console.log('\n#### Cross-build anchors (same cells, both datasets) — proves the two runs are comparable\n');
  const anchors = ['calibration-baseline', 'CRUX pierre-virtual / 1 file x 5k'];
  console.log(table(
    ['anchor cell', 'dataset', 'render ms', 'DOM nodes', 'p50 ms', 'p95 ms', 'max ms'],
    anchors.flatMap((t) => {
      const a = data.results.find((r) => r.tag === t);
      const b = cv.results.find((r) => r.tag === t);
      const row = (lbl, r) => (r ? [t, lbl, fmt(r.renderMs), N(r.domNodesAfterScroll), fmt(r.frameP50), fmt(r.frameP95), fmt(r.frameMax)] : null);
      return [row('main matrix', a), row('CodeView pass', b)].filter(Boolean);
    }),
  ));
}

console.log('\n### Errors seen\n');
for (const r of data.results) {
  if (r.errors?.length) console.log(`- ${r.tag ?? `${r.mode}/${r.size}`}: ${r.errors.join(' | ').slice(0, 200)}`);
}
console.log(`\n(generated ${data.generatedAt}, ${data.repeats} repeats/cell, headless=${data.headless}, ${data.results.length} cells)`);
