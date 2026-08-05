/**
 * Deterministic synthetic diff generator.
 *
 * Produces realistic-looking unified patches over TypeScript source so Shiki
 * has genuine tokenizing work to do. Everything is seeded, so the same size
 * label always yields byte-identical patches and the benchmark numbers are
 * comparable across runs and across machines.
 *
 * The patch is constructed from an explicit op list (context / del / add) per
 * file, so the @@ hunk headers are correct by construction rather than by a
 * diff algorithm we would then have to trust.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOUNS = [
  'flight', 'crew', 'roster', 'sector', 'aircraft', 'disruption', 'mitigation',
  'passenger', 'airport', 'schedule', 'decision', 'snapshot', 'patchset',
  'hunk', 'changeset', 'reviewer', 'obligation', 'projection', 'anchor',
];
const VERBS = [
  'resolve', 'compute', 'normalize', 'hydrate', 'reconcile', 'derive',
  'project', 'collapse', 'expand', 'validate', 'serialize', 'apply',
];
const TYPES = [
  'string', 'number', 'boolean', 'Date', 'ReadonlyArray<string>',
  'Map<string, number>', 'Record<string, unknown>', 'Promise<void>',
];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function cap(s) {
  return s[0].toUpperCase() + s.slice(1);
}

/** One plausible TypeScript statement/line. Occasionally very long. */
function tsLine(rng, indent, longLineChance) {
  const pad = '  '.repeat(indent);
  const r = rng();

  if (rng() < longLineChance) {
    // Deliberately long line: the pathological case for horizontal layout and
    // for tokenizers. ~240-400 chars.
    const parts = [];
    const n = 8 + Math.floor(rng() * 10);
    for (let i = 0; i < n; i += 1) {
      parts.push(`${pick(rng, VERBS)}${cap(pick(rng, NOUNS))}(${pick(rng, NOUNS)}Id, { strict: true, includeArchived: false })`);
    }
    return `${pad}const ${pick(rng, NOUNS)}${cap(pick(rng, VERBS))}Result = await Promise.all([${parts.join(', ')}]);`;
  }

  if (r < 0.1) return `${pad}// ${cap(pick(rng, VERBS))} the ${pick(rng, NOUNS)} before the ${pick(rng, NOUNS)} is written back.`;
  if (r < 0.18) return `${pad}const ${pick(rng, NOUNS)}${cap(pick(rng, NOUNS))} = ${pick(rng, VERBS)}${cap(pick(rng, NOUNS))}(${pick(rng, NOUNS)});`;
  if (r < 0.26) return `${pad}if (${pick(rng, NOUNS)}.${pick(rng, VERBS)}ed === undefined) {`;
  if (r < 0.32) return `${pad}  throw new Error(\`Unresolved \${${pick(rng, NOUNS)}.id} for \${${pick(rng, NOUNS)}.key}\`);`;
  if (r < 0.38) return `${pad}}`;
  if (r < 0.46) return `${pad}return { ${pick(rng, NOUNS)}: ${pick(rng, NOUNS)}Value, ${pick(rng, NOUNS)}Count: total };`;
  if (r < 0.54) return `${pad}for (const ${pick(rng, NOUNS)} of ${pick(rng, NOUNS)}s) {`;
  if (r < 0.60) return `${pad}  total += ${pick(rng, NOUNS)}.${pick(rng, NOUNS)}Weight ?? 0;`;
  if (r < 0.68) return `${pad}export interface ${cap(pick(rng, NOUNS))}${cap(pick(rng, NOUNS))} {`;
  if (r < 0.76) return `${pad}  readonly ${pick(rng, NOUNS)}Id: ${pick(rng, TYPES)};`;
  if (r < 0.82) return `${pad}export async function ${pick(rng, VERBS)}${cap(pick(rng, NOUNS))}(input: ${cap(pick(rng, NOUNS))}Input): Promise<${cap(pick(rng, NOUNS))}Result> {`;
  if (r < 0.88) return `${pad}const { ${pick(rng, NOUNS)}, ${pick(rng, NOUNS)} } = await ${pick(rng, VERBS)}${cap(pick(rng, NOUNS))}(input);`;
  if (r < 0.93) return '';
  if (r < 0.97) return `${pad}type ${cap(pick(rng, NOUNS))}Key = \`\${string}:\${number}\`;`;
  return `${pad}import type { ${cap(pick(rng, NOUNS))} } from '../${pick(rng, NOUNS)}/${pick(rng, NOUNS)}.js';`;
}

/**
 * Build the op list for one file.
 * Returns { ops, added, removed } where ops is [{ kind: 'ctx'|'del'|'add', text }]
 */
function buildFileOps(rng, targetChanged, longLineChance) {
  const ops = [];
  let added = 0;
  let removed = 0;
  let indent = 1;

  // Leading untouched region so the first hunk isn't at line 1.
  const lead = 12 + Math.floor(rng() * 40);
  for (let i = 0; i < lead; i += 1) ops.push({ kind: 'ctx', text: tsLine(rng, indent, longLineChance) });

  while (added + removed < targetChanged) {
    const remaining = targetChanged - (added + removed);
    // Cluster shape: mix of pure-add (new code), pure-delete (subtraction),
    // and modify (delete run followed by add run) — the realistic mix.
    const shape = rng();
    const size = Math.max(1, Math.min(remaining, 1 + Math.floor(rng() * 14)));

    if (shape < 0.42) {
      // modify: delete k, add k' (usually similar sizes)
      const dels = Math.max(1, Math.min(remaining, size));
      const adds = Math.max(1, Math.min(remaining - dels + 1, Math.max(1, size + Math.floor(rng() * 5) - 2)));
      for (let i = 0; i < dels; i += 1) { ops.push({ kind: 'del', text: tsLine(rng, indent, longLineChance) }); removed += 1; }
      for (let i = 0; i < adds; i += 1) { ops.push({ kind: 'add', text: tsLine(rng, indent, longLineChance) }); added += 1; }
    } else if (shape < 0.78) {
      // pure addition
      for (let i = 0; i < size; i += 1) { ops.push({ kind: 'add', text: tsLine(rng, indent, longLineChance) }); added += 1; }
    } else {
      // pure deletion
      for (let i = 0; i < size; i += 1) { ops.push({ kind: 'del', text: tsLine(rng, indent, longLineChance) }); removed += 1; }
    }

    // Untouched run between clusters. Sometimes small (adjacent hunks merge),
    // sometimes large (separate hunks with a collapsed gap).
    const gap = rng() < 0.45
      ? 2 + Math.floor(rng() * 4)      // tight: hunks will merge
      : 14 + Math.floor(rng() * 90);   // wide: separate hunks
    for (let i = 0; i < gap; i += 1) ops.push({ kind: 'ctx', text: tsLine(rng, indent, longLineChance) });

    indent = 1 + Math.floor(rng() * 3);
  }

  // Trailing untouched region.
  const tail = 10 + Math.floor(rng() * 30);
  for (let i = 0; i < tail; i += 1) ops.push({ kind: 'ctx', text: tsLine(rng, indent, longLineChance) });

  return { ops, added, removed };
}

const CONTEXT = 3;

/** Turn an op list into unified-diff hunks with correct @@ headers. */
function opsToHunks(ops) {
  // Mark which op indices are "changed", then grow by CONTEXT on both sides
  // and merge overlapping windows — exactly what `git diff -U3` does.
  const changed = [];
  ops.forEach((op, i) => { if (op.kind !== 'ctx') changed.push(i); });
  if (changed.length === 0) return [];

  const windows = [];
  for (const i of changed) {
    const start = Math.max(0, i - CONTEXT);
    const end = Math.min(ops.length - 1, i + CONTEXT);
    const last = windows[windows.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
  }

  // Walk ops once, tracking old/new line numbers.
  const oldNo = new Array(ops.length);
  const newNo = new Array(ops.length);
  let o = 1;
  let n = 1;
  ops.forEach((op, i) => {
    oldNo[i] = o;
    newNo[i] = n;
    if (op.kind === 'ctx') { o += 1; n += 1; }
    else if (op.kind === 'del') { o += 1; }
    else { n += 1; }
  });

  return windows.map(({ start, end }) => {
    const lines = [];
    let oldCount = 0;
    let newCount = 0;
    for (let i = start; i <= end; i += 1) {
      const op = ops[i];
      if (op.kind === 'ctx') { lines.push(` ${op.text}`); oldCount += 1; newCount += 1; }
      else if (op.kind === 'del') { lines.push(`-${op.text}`); oldCount += 1; }
      else { lines.push(`+${op.text}`); newCount += 1; }
    }
    // Find first old/new line numbers present in the window.
    let oldStart = oldNo[start];
    let newStart = newNo[start];
    if (oldCount === 0) oldStart = Math.max(0, oldStart - 1);
    if (newCount === 0) newStart = Math.max(0, newStart - 1);
    return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines.join('\n')}`;
  });
}

const DIRS = ['core/diff', 'core/git', 'ui/review', 'ui/chunks', 'shell/ipc', 'core/state'];

function fakeSha(rng) {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 7; i += 1) s += hex[Math.floor(rng() * 16)];
  return s;
}

/**
 * @param {{ changedLines: number, files: number, seed: number, longLineChance?: number }} spec
 * @returns {{ files: Array<{ path: string, patch: string, changed: number, added: number, removed: number }>, totalChanged: number, patch: string }}
 */
export function generateDiff(spec) {
  const { changedLines, files: fileCount, seed, longLineChance = 0.012 } = spec;
  const rng = mulberry32(seed);
  const files = [];

  // Realistic distribution: a couple of big files, a long tail of small ones.
  const weights = [];
  for (let i = 0; i < fileCount; i += 1) weights.push(i < 2 ? 3 + rng() * 3 : 0.3 + rng() * 1.6);
  const weightSum = weights.reduce((a, b) => a + b, 0);

  let allocated = 0;
  for (let i = 0; i < fileCount; i += 1) {
    const isLast = i === fileCount - 1;
    const target = isLast
      ? Math.max(2, changedLines - allocated)
      : Math.max(2, Math.round((weights[i] / weightSum) * changedLines));
    allocated += target;

    const { ops, added, removed } = buildFileOps(rng, target, longLineChance);
    const hunks = opsToHunks(ops);
    const path = `${pick(rng, DIRS)}/${pick(rng, NOUNS)}-${pick(rng, VERBS)}-${i}.ts`;
    const header = [
      `diff --git a/${path} b/${path}`,
      `index ${fakeSha(rng)}..${fakeSha(rng)} 100644`,
      `--- a/${path}`,
      `+++ b/${path}`,
    ].join('\n');

    files.push({
      path,
      patch: `${header}\n${hunks.join('\n')}\n`,
      changed: added + removed,
      added,
      removed,
    });
  }

  const totalChanged = files.reduce((a, f) => a + f.changed, 0);
  return { files, totalChanged, patch: files.map((f) => f.patch).join('') };
}

/** The three spike sizes. */
export const SIZES = {
  small: { label: '~500 changed', changedLines: 500, files: 6, seed: 1001 },
  medium: { label: '~2,000 changed', changedLines: 2000, files: 18, seed: 2002 },
  large: { label: '~5,000 changed', changedLines: 5000, files: 34, seed: 3003 },
  // The actual open question from the stack note: does FileDiff window LINES
  // inside one file, or does it only compose at file granularity? A 34-file
  // diff cannot tell those apart. One 5,000-line file can.
  mono: { label: '~5,000 changed, ONE file', changedLines: 5000, files: 1, seed: 4004 },
};
