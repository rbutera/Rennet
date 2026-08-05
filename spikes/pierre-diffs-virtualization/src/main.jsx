import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CodeView,
  PatchDiff,
  Virtualizer,
  WorkerPoolContextProvider,
} from '@pierre/diffs/react';
import { getSingularPatch } from '@pierre/diffs';
import PierreWorker from '@pierre/diffs/worker/worker.js?worker';
import { generateDiff, SIZES } from './fixtures/generate.js';
import { TanstackDiff } from './fallback/TanstackDiff.jsx';
import {
  countAllNodes,
  countRenderedLines,
  countTokenSpans,
  heapBytes,
  longtaskSupported,
  runScroll,
  startLongtaskObserver,
  waitForStableRender,
} from './harness.js';

startLongtaskObserver();

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') ?? 'pierre-virtual';
const SIZE = params.get('size') ?? 'large';
const STALL = Number(params.get('stall') ?? '0');

const spec = SIZES[SIZE] ?? SIZES.large;

/**
 * CALIBRATION CONTROL.
 *
 * A deliberate synchronous main-thread stall, once per animation frame. If the
 * harness cannot see this, the harness cannot see anything, and every clean
 * number it ever produced is worthless.
 */
function installStall(ms) {
  if (!ms) return;
  const burn = () => {
    const end = performance.now() + ms;
    // Busy-wait. Not a sleep: this must occupy the main thread.
    while (performance.now() < end) { /* burn */ }
    requestAnimationFrame(burn);
  };
  requestAnimationFrame(burn);
}

// Pierre's own worker pool: highlighting off the main thread, its shipped
// worker entry, JS regex engine (no Oniguruma WASM fetch).
const POOL_OPTIONS = {
  workerFactory: () => new PierreWorker(),
  poolSize: 4,
};
const HIGHLIGHTER_OPTIONS = {
  langs: ['typescript'],
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  preferredHighlighter: 'shiki-js',
};

const DIFF_OPTIONS = {
  diffStyle: 'unified',
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  themeType: 'dark',
  overflow: 'scroll',
  stickyHeader: true,
};

const CODE_VIEW_OPTIONS = {
  diffStyle: 'unified',
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  themeType: 'dark',
  overflow: 'scroll',
  stickyHeaders: true,
};

/**
 * The path Pierre's own docs call the optimized one:
 *
 *   "If your scrollable region is only code, start with CodeView instead. It
 *    is the more optimized path: it owns the entire code surface, only renders
 *    what you can actually see, and is generally more performant and less
 *    prone to blanking."
 *
 * That describes Wingman's review surface exactly, so it has to be measured.
 * CodeView takes items rather than children, and owns its own scroll node.
 */
function PierreCodeView({ files, scrollerRef }) {
  const items = useMemo(
    () => files.map((f, i) => ({
      id: `${i}-${f.path}`,
      type: 'diff',
      fileDiff: getSingularPatch(f.patch),
    })),
    [files],
  );
  return (
    <CodeView
      items={items}
      className="scroller"
      containerRef={scrollerRef}
      options={CODE_VIEW_OPTIONS}
    />
  );
}

function PierreView({ files, virtualized, scrollerRef }) {
  const body = files.map((f) => (
    <div className="filewrap" key={f.path}>
      <PatchDiff patch={f.patch} options={DIFF_OPTIONS} />
    </div>
  ));

  if (virtualized) {
    // Pierre swaps FileDiff -> VirtualizedFileDiff purely by the presence of
    // this context in the tree (see useFileDiffInstance). The <Virtualizer>
    // element IS the scroll container, so the harness finds it by class.
    return (
      <Virtualizer className="scroller" style={{ flex: '1 1 auto' }}>
        {body}
      </Virtualizer>
    );
  }
  return (
    <div className="scroller" ref={scrollerRef}>
      {body}
    </div>
  );
}

function App() {
  const scrollerRef = useRef(null);
  const [status, setStatus] = useState('generating…');
  const t0 = useRef(performance.now());

  const diff = useMemo(() => {
    const g = generateDiff(spec);
    return g;
  }, []);

  useEffect(() => {
    installStall(STALL);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const settle = MODE === 'idle'
        ? { renderMs: 0, renderedLines: 0, timedOut: false }
        : await waitForStableRender(t0.current);
      if (cancelled) return;
      const stats = {
        mode: MODE,
        size: SIZE,
        stallMs: STALL,
        spec: { changedLines: spec.changedLines, files: spec.files },
        actual: { totalChanged: diff.totalChanged, files: diff.files.length, patchBytes: diff.patch.length },
        renderMs: settle.renderMs,
        renderedLines: settle.renderedLines,
        timedOut: settle.timedOut,
        domNodes: countAllNodes(),
        tokenSpans: countTokenSpans(),
        heapAfterRenderBytes: heapBytes(),
        longtaskSupported: longtaskSupported(),
      };
      window.__spikeReady = stats;
      setStatus(`ready — ${settle.renderedLines} rendered rows, ${settle.renderMs}ms`);
    })();
    return () => { cancelled = true; };
  }, [diff]);

  // Exposed to Playwright.
  useEffect(() => {
    window.__spikeScroll = async (opts) => {
      // Every mode puts `.scroller` on its real scroll node, including the
      // two Pierre paths that construct that node themselves.
      const el = document.querySelector('.scroller') ?? scrollerRef.current;
      const before = { domNodes: countAllNodes(), renderedLines: countRenderedLines(), tokenSpans: countTokenSpans(), heap: heapBytes() };
      const result = await runScroll(el, opts);
      const after = { domNodes: countAllNodes(), renderedLines: countRenderedLines(), tokenSpans: countTokenSpans(), heap: heapBytes() };
      return { ...result, before, after };
    };
    window.__spikeSnapshot = () => ({
      domNodes: countAllNodes(),
      renderedLines: countRenderedLines(),
      tokenSpans: countTokenSpans(),
      heap: heapBytes(),
    });
  }, []);

  return (
    <>
      <div className="bar">
        mode=<b>{MODE}</b> size=<b>{SIZE}</b> stall=<b>{STALL}ms</b>{' '}
        files=<b>{diff.files.length}</b> changed=<b>{diff.totalChanged}</b> — {status}
      </div>
      {MODE === 'idle' ? (
        // Instrument floor: a scroller with no diff renderer at all. Whatever
        // frame times this cell produces are the machine's ceiling, not the
        // library's. Any comparison that ignores this floor is unreadable.
        <div className="scroller" ref={scrollerRef}>
          <div style={{ height: 40000 }} />
        </div>
      ) : MODE === 'tanstack' ? (
        <TanstackDiff patch={diff.patch} scrollerRef={scrollerRef} />
      ) : (
        <WorkerPoolContextProvider
          poolOptions={POOL_OPTIONS}
          highlighterOptions={HIGHLIGHTER_OPTIONS}
        >
          {MODE === 'pierre-codeview' ? (
            <PierreCodeView files={diff.files} scrollerRef={scrollerRef} />
          ) : (
            <PierreView
              files={diff.files}
              virtualized={MODE === 'pierre-virtual'}
              scrollerRef={scrollerRef}
            />
          )}
        </WorkerPoolContextProvider>
      )}
    </>
  );
}

// StrictMode double-mounts, which double-instantiates Pierre's imperative
// components and would corrupt the render-time measurement. Off on purpose.
createRoot(document.getElementById('root')).render(<App />);
void StrictMode;
