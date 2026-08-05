/**
 * Measurement harness.
 *
 * Deliberately dumb and inspectable. Everything it reports is derived from
 * two primitives: rAF timestamps during a real programmatic scroll, and the
 * PerformanceObserver longtask stream. Nothing here is eyeballed.
 *
 * The harness is validated by the `stall` mode (see main.jsx): a deliberate
 * synchronous main-thread stall per frame MUST move these numbers. If it does
 * not, the harness is broken and no clean result from it means anything.
 */

const longtasks = [];
let longtaskObserver = null;

export function startLongtaskObserver() {
  if (longtaskObserver) return;
  try {
    longtaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longtasks.push({ start: entry.startTime, duration: entry.duration });
      }
    });
    longtaskObserver.observe({ entryTypes: ['longtask'] });
  } catch {
    longtaskObserver = null;
  }
}

export function longtaskSupported() {
  return longtaskObserver != null;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Count mounted CODE ROWS, descending into shadow roots (Pierre uses them).
 *
 * `[data-line]` is Pierre's code-content row. Do NOT use `[data-line-index]`:
 * that also matches the line-number gutter cell, so it double-counts. The
 * fallback path tags its rows with the same attribute so the two paths are
 * counted by one instrument.
 */
export function countRenderedLines(root = document) {
  let total = 0;
  const walk = (node) => {
    if (!node) return;
    total += node.querySelectorAll('[data-line]').length;
    for (const el of node.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return total;
}

/**
 * Count mounted syntax-token spans. This is the number that actually says
 * whether highlighted content is windowed: a renderer that mounts every line
 * mounts every token with it.
 */
export function countTokenSpans(root = document) {
  let total = 0;
  const walk = (node) => {
    if (!node) return;
    for (const line of node.querySelectorAll('[data-line]')) {
      total += line.querySelectorAll('span').length;
    }
    for (const el of node.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return total;
}

/** Total element count including shadow trees. */
export function countAllNodes(root = document) {
  let total = 0;
  const walk = (node) => {
    const els = node.querySelectorAll('*');
    total += els.length;
    for (const el of els) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return total;
}

export function heapBytes() {
  const m = performance.memory;
  return m ? m.usedJSHeapSize : null;
}

/**
 * Programmatic fast scroll with per-frame timing.
 *
 * Drives the scroller with rAF (real scroll events, so IntersectionObserver
 * and scroll listeners fire exactly as they would under a trackpad flick)
 * and records the interval between presented frames.
 */
export function runScroll(scroller, { passes = 2, pxPerFrame = 90 } = {}) {
  return new Promise((resolve) => {
    const isWindow = scroller === window || scroller === document.documentElement;
    const getMax = () => (isWindow
      ? document.documentElement.scrollHeight - window.innerHeight
      : scroller.scrollHeight - scroller.clientHeight);
    const setTop = (v) => {
      if (isWindow) window.scrollTo(0, v);
      else scroller.scrollTop = v;
    };

    const ltStart = longtasks.length;
    const t0 = performance.now();
    const deltas = [];
    let last = t0;
    let top = 0;
    let dir = 1;
    let pass = 0;
    let frames = 0;

    const step = (now) => {
      const dt = now - last;
      last = now;
      if (frames > 0) deltas.push(dt); // skip the first (scheduling) interval
      frames += 1;

      const max = getMax();
      top += dir * pxPerFrame;
      if (top >= max) { top = max; dir = -1; pass += 1; }
      else if (top <= 0) { top = 0; dir = 1; pass += 1; }
      setTop(top);

      if (pass >= passes || frames > 4000) {
        const elapsed = performance.now() - t0;
        const sorted = [...deltas].sort((a, b) => a - b);
        const lt = longtasks.slice(ltStart);
        resolve({
          frames,
          elapsedMs: round(elapsed),
          scrollHeightPx: Math.round(getMax()),
          fps: round(frames / (elapsed / 1000)),
          frameMs: {
            mean: round(deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length)),
            p50: round(quantile(sorted, 0.5)),
            p95: round(quantile(sorted, 0.95)),
            p99: round(quantile(sorted, 0.99)),
            max: round(sorted[sorted.length - 1] ?? 0),
          },
          over8_3ms: deltas.filter((d) => d > 8.34).length,
          over16_7ms: deltas.filter((d) => d > 16.7).length,
          over50ms: deltas.filter((d) => d > 50).length,
          longtasks: {
            count: lt.length,
            totalMs: round(lt.reduce((a, b) => a + b.duration, 0)),
            maxMs: round(lt.reduce((a, b) => Math.max(a, b.duration), 0)),
          },
        });
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Wait until the rendered-line count stops changing, and report the time of
 * the LAST change (not the time the stability window closed) so the settle
 * window doesn't inflate the render number.
 */
export function waitForStableRender(t0, { stableFrames = 30, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let lastCount = -1;
    let lastChangeAt = performance.now();
    let stable = 0;
    const tick = () => {
      const count = countRenderedLines();
      if (count !== lastCount) {
        lastCount = count;
        lastChangeAt = performance.now();
        stable = 0;
      } else if (count > 0) {
        stable += 1;
      }
      if (stable >= stableFrames || performance.now() - t0 > timeoutMs) {
        resolve({
          renderMs: round(lastChangeAt - t0),
          renderedLines: count,
          timedOut: performance.now() - t0 > timeoutMs,
        });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
