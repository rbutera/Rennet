/**
 * Minimal unified-patch -> flat row list.
 *
 * Both measured paths consume the SAME patch bytes: Pierre gets the text,
 * the fallback gets this parse of the same text. Nothing is generated twice.
 */
export function parsePatchToRows(patchText) {
  const rows = [];
  const hunks = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of patchText.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = raw.slice(raw.lastIndexOf(' b/') + 3);
      rows.push({ type: 'file', path: file });
      continue;
    }
    if (raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) continue;
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(raw);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[3]) : 0;
      hunk = { id: hunks.length, path: file, lines: [], rowStart: rows.length + 1 };
      hunks.push(hunk);
      rows.push({ type: 'sep', path: file, header: raw });
      continue;
    }
    if (!hunk) continue;
    const marker = raw[0];
    if (marker !== ' ' && marker !== '+' && marker !== '-') continue;
    const text = raw.slice(1);
    const kind = marker === '+' ? 'add' : marker === '-' ? 'del' : 'ctx';
    const row = {
      type: 'line',
      kind,
      text,
      hunkId: hunk.id,
      lineInHunk: hunk.lines.length,
      oldNo: kind === 'add' ? null : oldNo,
      newNo: kind === 'del' ? null : newNo,
    };
    if (kind !== 'add') oldNo += 1;
    if (kind !== 'del') newNo += 1;
    hunk.lines.push(text);
    rows.push(row);
  }
  return { rows, hunks };
}
