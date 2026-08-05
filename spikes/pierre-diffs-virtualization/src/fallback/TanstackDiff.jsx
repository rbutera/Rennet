/**
 * The fallback prototype: @tanstack/react-virtual with per-hunk windowing and
 * Shiki highlighting in a worker. This is the design the stack note sketched
 * as the plan-B if Pierre could not virtualize.
 *
 * Rows are a flat list (file header / hunk separator / code line). Highlight
 * is requested per HUNK, lazily, only when a row from that hunk is windowed
 * in, and arrives as token arrays over postMessage.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { parsePatchToRows } from './parsePatch.js';

const ROW_H = 19;

function useShikiWorker() {
  const workerRef = useRef(null);
  const pending = useRef(new Map());
  const [, force] = useState(0);
  const cache = useRef(new Map());
  const requested = useRef(new Set());

  useEffect(() => {
    const w = new Worker(new URL('./shiki.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const { id, tokens } = e.data;
      cache.current.set(id, tokens);
      pending.current.delete(id);
      force((n) => n + 1);
    };
    workerRef.current = w;
    return () => w.terminate();
  }, []);

  const request = useCallback((hunk) => {
    if (requested.current.has(hunk.id)) return;
    requested.current.add(hunk.id);
    pending.current.set(hunk.id, true);
    workerRef.current?.postMessage({ id: hunk.id, lines: hunk.lines });
  }, []);

  return { cache: cache.current, request, highlightedCount: cache.current.size };
}

const KIND_BG = { add: 'rgba(46,160,67,0.15)', del: 'rgba(248,81,73,0.15)', ctx: 'transparent' };
const KIND_MARK = { add: '+', del: '-', ctx: ' ' };

export function TanstackDiff({ patch, scrollerRef, onStats }) {
  const { rows, hunks } = useMemo(() => parsePatchToRows(patch), [patch]);
  const { cache, request } = useShikiWorker();

  // The scroll element must exist BEFORE the virtualizer's layout effect runs.
  // A parent ref does not: React attaches parent refs after child layout
  // effects, so the virtualizer would measure null and render zero rows.
  // Holding it in state forces a re-render once the node is real.
  const [scrollEl, setScrollEl] = useState(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_H,
    overscan: 40,
  });

  const items = virtualizer.getVirtualItems();

  // Per-hunk windowing: ask the worker for exactly the hunks currently in view.
  useEffect(() => {
    const seen = new Set();
    for (const item of items) {
      const row = rows[item.index];
      if (row?.type === 'line' && !seen.has(row.hunkId)) {
        seen.add(row.hunkId);
        request(hunks[row.hunkId]);
      }
    }
  }, [items, rows, hunks, request]);

  useEffect(() => { onStats?.({ totalRows: rows.length, hunks: hunks.length }); }, [rows.length, hunks.length, onStats]);

  const attach = useCallback((node) => {
    setScrollEl(node);
    if (scrollerRef) scrollerRef.current = node;
  }, [scrollerRef]);

  return (
    <div className="scroller" ref={attach}>
    <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
      {items.map((item) => {
        const row = rows[item.index];
        const style = {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: ROW_H,
          transform: `translateY(${item.start}px)`,
          whiteSpace: 'pre',
          overflow: 'hidden',
        };
        if (row.type === 'file') {
          return (
            <div key={item.key} data-index={item.index} style={{ ...style, background: '#1d1d22', color: '#9ad', padding: '0 8px', fontWeight: 600 }}>
              {row.path}
            </div>
          );
        }
        if (row.type === 'sep') {
          return (
            <div key={item.key} data-index={item.index} style={{ ...style, background: '#141419', color: '#556', padding: '0 8px' }}>
              {row.header}
            </div>
          );
        }
        const toks = cache.get(row.hunkId)?.[row.lineInHunk];
        return (
          <div
            key={item.key}
            data-index={item.index}
            data-line={row.newNo ?? row.oldNo ?? item.index}
            style={{ ...style, background: KIND_BG[row.kind], display: 'flex' }}
          >
            <span style={{ color: '#4a4a55', width: 48, textAlign: 'right', flex: '0 0 auto', paddingRight: 6 }}>{row.oldNo ?? ''}</span>
            <span style={{ color: '#4a4a55', width: 48, textAlign: 'right', flex: '0 0 auto', paddingRight: 6 }}>{row.newNo ?? ''}</span>
            <span style={{ color: '#777', flex: '0 0 auto', width: 12 }}>{KIND_MARK[row.kind]}</span>
            <span style={{ flex: '1 1 auto' }}>
              {toks
                ? toks.map((t, i) => <span key={i} style={{ color: t[1] || undefined }}>{t[0]}</span>)
                : row.text}
            </span>
          </div>
        );
      })}
    </div>
    </div>
  );
}
