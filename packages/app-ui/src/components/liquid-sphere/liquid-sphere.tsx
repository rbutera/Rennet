// Rennet's mark, rendered live: the liquid sphere from
// `brand/sources/liquid-sphere/index.html`, running in the Electron renderer and the
// browser client. `engine.ts` owns the three.js; this file owns when it runs, how big it
// is, and what happens when it cannot run at all.
//
// The fallback is one code path, not three. Reduced motion, a refused WebGL context, and
// an environment with no WebGL at all (happy-dom under vitest) all land on the same
// static `RennetBrandMark`, and none of them throws into the React tree. `data-liquid-
// sphere` says which path rendered, so a test or the chrome can tell without guessing.
//
// Accessibility lives on the ROOT for both paths, because a canvas has no accessible
// name of its own and a caller should not have to know which path it got. With a
// `title` the root is `role="img"` with that label; without one it is `aria-hidden`. The
// static mark inside is always decorative — it is the root's rendering, not a second
// image.

import { type CSSProperties, type JSX, useEffect, useRef, useState } from "react";
import { RennetBrandMark } from "../brand-mark";
import type { LiquidSphereState, SphereEngine } from "./engine";

export type { LiquidSphereState };

export interface LiquidSphereProps {
  /** Rendered size in px. The mark is square: this is both width and height. */
  size: number;
  /** Which motion preset to settle into. Changing it eases across; phases keep running. */
  state: LiquidSphereState;
  /** Accessible name. When given, the mark is exposed as role=img; otherwise aria-hidden. */
  title?: string;
  className?: string;
}

/** Which of the two paths rendered. Mirrored onto `data-liquid-sphere`. */
type RenderPath = "live" | "static";

/** The OS reduced-motion query, or null where matchMedia is missing. Never throws. */
function reducedMotionQuery(): MediaQueryList | null {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)");
  } catch {
    return null;
  }
}

/** True when the user has asked the OS for reduced motion. */
function prefersReducedMotion(): boolean {
  return reducedMotionQuery()?.matches ?? false;
}

/**
 * True when this environment can actually give us a WebGL context. Probes with a
 * throwaway canvas and hands the context straight back, so the probe does not hold one
 * of the browser's small pool of live contexts.
 */
function hasWebGL(): boolean {
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") ?? probe.getContext("webgl");
    if (!gl) return false;
    const lose = gl.getExtension("WEBGL_lose_context") as { loseContext(): void } | null;
    lose?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** The fallback decision, made before the first render and without throwing. */
function canRenderLive(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  // Reduced motion answers first: when it holds, the WebGL probe never runs.
  if (prefersReducedMotion()) return false;
  return hasWebGL();
}

/**
 * Run the frame loop for a built engine, only while its canvas is both on screen and
 * in a visible document. Returns the stop function. Stopping is a cancelled rAF and
 * nothing else: the engine clamps its own delta, so a resume after any pause takes one
 * 50 ms step rather than jumping the motion forward by the whole gap.
 */
function run(live: SphereEngine, mount: HTMLElement): () => void {
  let raf = 0;
  let onScreen = true;
  let documentVisible = document.visibilityState === "visible";

  const tick = () => {
    live.frame();
    raf = requestAnimationFrame(tick);
  };
  const sync = () => {
    const shouldRun = onScreen && documentVisible;
    if (shouldRun && raf === 0) raf = requestAnimationFrame(tick);
    else if (!shouldRun && raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const onVisibilityChange = () => {
    documentVisible = document.visibilityState === "visible";
    sync();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          onScreen = entries.some((entry) => entry.isIntersecting);
          sync();
        })
      : null;
  observer?.observe(mount);

  // Draw from the first frame rather than waiting for the observer's opening
  // callback, which is async and would blank a mark that is already on screen.
  sync();

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    observer?.disconnect();
    if (raf !== 0) cancelAnimationFrame(raf);
  };
}

export function LiquidSphere({ size, state, title, className }: LiquidSphereProps): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const engine = useRef<SphereEngine | null>(null);
  // The size and state this instance MOUNTED with. A ref rather than the live props
  // because the engine is built once: every later change reaches it through the two
  // small effects below, which is what keeps the blend eased and the phases continuous.
  const initial = useRef({ size, state });
  const latest = useRef({ size, state });
  const [path, setPath] = useState<RenderPath>(() => (canRenderLive() ? "live" : "static"));

  useEffect(() => {
    if (path !== "live") return;
    const mount = host.current;
    if (!mount) return;

    // three.js arrives on its own chunk, after first paint. The static mark is
    // already the fallback, so until the engine exists the root simply stays
    // empty-but-sized for the few frames the import takes; `cancelled` covers an
    // unmount that lands before it resolves.
    let cancelled = false;
    let live: SphereEngine | null = null;
    let stop: (() => void) | null = null;

    import("./engine")
      .then(({ createSphereEngine }) => {
        if (cancelled) return;
        try {
          live = createSphereEngine(initial.current);
        } catch {
          // The probe said yes and the real context still refused. Same landing as
          // the other two causes: the static mark, no throw.
          setPath("static");
          return;
        }
        engine.current = live;
        // Props may have moved on while the chunk loaded.
        live.setSize(latest.current.size);
        live.setTarget(latest.current.state);
        mount.appendChild(live.canvas);
        stop = run(live, mount);
      })
      .catch(() => {
        if (!cancelled) setPath("static");
      });

    return () => {
      cancelled = true;
      stop?.();
      if (live) {
        live.canvas.remove();
        live.dispose();
      }
      engine.current = null;
    };
    // `path` ONLY. Adding `size` or `state` here would tear the engine down and build a
    // new one on every resize and every state change, which is exactly what the eased
    // blend and the continuous phases exist to avoid.
  }, [path]);

  // Reduced motion can change while we are mounted (System Settings, a profile
  // switch). Follow it both ways: to static at once, and back to live on release.
  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    const onChange = () => setPath(query.matches || !hasWebGL() ? "static" : "live");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    latest.current = { size, state };
    engine.current?.setSize(size);
  }, [size, state]);

  useEffect(() => {
    engine.current?.setTarget(state);
  }, [state]);

  const box: CSSProperties = { width: size, height: size };
  // `aria-label` only ever travels WITH `role="img"`, and `aria-hidden` only ever
  // without it. Built as one object so the pairing is a single decision rather than
  // three ternaries a reader (or a static rule) has to line up by eye.
  const labelling = title
    ? ({ role: "img", "aria-label": title } as const)
    : ({ "aria-hidden": true } as const);
  return (
    <div
      ref={host}
      className={className}
      style={box}
      data-liquid-sphere={path}
      data-state={state}
      {...labelling}
    >
      {path === "static" ? <RennetBrandMark size={size} /> : null}
    </div>
  );
}
