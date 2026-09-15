import { createModels, createSpanner, sampleCodeGlyphs } from "@rennet/theme/constellation-models";
import { useEffect, useRef, useState } from "react";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  NormalBlending,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from "three";
import { RennetLockup } from "../shell/sidebar/lockup";

const SCENES = [5, 1, 3, 4, 5];

export function WelcomeConstellation({
  step,
  intro = false,
  onPauseChange,
}: {
  step: number;
  intro?: boolean;
  onPauseChange?(paused: boolean): void;
}) {
  const sceneIndex = intro ? 0 : (SCENES[step] ?? 5);
  const host = useRef<HTMLDivElement>(null);
  const target = useRef(sceneIndex);
  const invalidate = useRef<(() => void) | null>(null);
  const pausedRef = useRef(true);
  const [paused, setPaused] = useState(true);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    target.current = sceneIndex;
    onPauseChange?.(paused);
    pausedRef.current = paused;
    invalidate.current?.();
  }, [sceneIndex, paused, onPauseChange]);

  useEffect(() => {
    const root = host.current;
    if (!root || typeof WebGLRenderingContext === "undefined") return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ alpha: true, antialias: false, powerPreference: "low-power" });
    } catch {
      return;
    }
    root.append(renderer.domElement);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    setPaused(reduced.matches);
    setAvailable(true);
    const models = createModels(22000);
    models[1] = createSpanner(22000);
    const samples = sampleCodeGlyphs();
    if (samples) {
      const compact = root.clientWidth < 600;
      for (let i = 0; i < 22000; i++) {
        const sample = samples[Math.floor(i * 0.61803398875 * samples.length) % samples.length];
        if (!sample) continue;
        const block = i % (compact ? 2 : 6);
        const x = (sample.x / 1100 - 0.35) * (compact ? 8 : 7);
        const y = (0.5 - sample.y / 700) * 4;
        const angle = block % 2 ? -0.12 : 0.12;
        models[0].set(
          [
            x * Math.cos(angle) - y * Math.sin(angle) + (compact ? 0 : block % 2 ? 10 : -10),
            x * Math.sin(angle) +
              y * Math.cos(angle) +
              (compact ? (block ? -7 : 7) : 5 - Math.floor(block / 2) * 5),
            -2 - block * 0.2,
          ],
          i * 3,
        );
      }
    }
    const geometry = new BufferGeometry();
    const current = (models[target.current] ?? models[5]).slice();
    const position = new BufferAttribute(current, 3);
    geometry.setAttribute("position", position);
    const uniforms = {
      bottom: { value: new Color() },
      mid: { value: new Color() },
      top: { value: new Color() },
      opacity: { value: 0.55 },
      time: { value: 0 },
      sphere: { value: 1 },
      code: { value: 1 },
      pixelRatio: { value: 1 },
      viewportScale: { value: 1 },
    };
    const material = new ShaderMaterial({
      uniforms,
      vertexShader: `uniform float time; uniform float sphere; uniform float code; uniform float pixelRatio; uniform float viewportScale; uniform vec3 bottom; uniform vec3 mid; uniform vec3 top;
        varying vec3 tint;
        void main() {
          vec3 p = position;
          p.y += code * sin(time * .35 + floor(position.x) * .2) * .3;
          p = p * (1.0 + sphere * .018 * sin(time * 1.5));
          float h = clamp(p.y / 6.5 + .5, 0.0, 1.0);
          tint = mix(bottom, mid, smoothstep(0.0, .55, h));
          tint = mix(tint, top, smoothstep(.45, 1.0, h));
          vec4 view = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * view;
          gl_PointSize = clamp(24.0 / -view.z * pixelRatio * viewportScale, .45, 2.5);
        }`,
      fragmentShader: `varying vec3 tint; uniform float opacity; void main() {
        float radius = length(gl_PointCoord - .5) * 2.0;
        if (radius > 1.0) discard;
        gl_FragColor = vec4(tint, pow(1.0 - radius, .8) * opacity);
        #include <colorspace_fragment>
      }`,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const scene = new Scene();
    const points = new Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);
    const camera = new PerspectiveCamera(48, 1, 0.1, 100);
    camera.position.set(0, 1.5, 22);
    camera.lookAt(0, 0, 0);
    const measure = () => {
      const { width, height } = root.getBoundingClientRect();
      if (!width || !height) return;
      const ratio = Math.min(devicePixelRatio, 1.5);
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height);
      uniforms.pixelRatio.value = ratio;
      uniforms.viewportScale.value = height / 540;
      camera.aspect = width / height;
      camera.position.z = camera.aspect < 0.8 ? 28 : 22;
      camera.updateProjectionMatrix();
    };
    const resize = new ResizeObserver(() => {
      measure();
      invalidate.current?.();
    });
    resize.observe(root);
    measure();
    let frame = 0;
    let last = 0;
    let elapsed = 0;
    let rotation = 0;
    let disposed = false;
    function render(now: number) {
      frame = 0;
      if (disposed || document.hidden) return;
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
      last = now;
      const stop = pausedRef.current;
      if (!stop) elapsed += dt;
      const destination = models[target.current] ?? models[5];
      const amount = stop ? 1 : 1 - Math.exp(-dt * 5);
      for (let i = 0; i < current.length; i++) {
        const value = current[i] ?? 0;
        current[i] = value + ((destination[i] ?? 0) - value) * amount;
      }
      position.needsUpdate = true;
      uniforms.time.value = elapsed;
      uniforms.sphere.value = target.current === 5 ? 1 : 0;
      uniforms.code.value = target.current === 0 ? 1 : 0;
      const compact = (root?.clientWidth ?? 0) < 760;
      const offset = target.current === 0 ? 0 : compact ? 0 : -6;
      points.position.x += (offset - points.position.x) * amount;
      const code = target.current === 0;
      if (!stop && !code) rotation += dt * 0.14;
      points.position.y = code ? 0 : (compact ? 5 : 1) + Math.sin(elapsed * 0.65) * 0.16;
      points.rotation.y = code ? Math.sin(elapsed * 0.12) * 0.12 : rotation;
      renderer.render(scene, camera);
      root?.setAttribute("data-scene", String(target.current));
      root?.setAttribute("data-frame", String(Math.round(elapsed * 1000)));
      if (!stop) frame = requestAnimationFrame(render);
    }
    function visibility() {
      cancelAnimationFrame(frame);
      last = 0;
      if (!document.hidden) frame = requestAnimationFrame(render);
    }
    function preference() {
      setPaused(reduced.matches);
    }
    function lost(event: Event) {
      event.preventDefault();
      disposed = true;
      cancelAnimationFrame(frame);
      setAvailable(false);
    }
    function syncPalette() {
      const css = getComputedStyle(document.documentElement);
      uniforms.bottom.value.set(css.getPropertyValue("--app-art-bottom").trim());
      uniforms.mid.value.set(css.getPropertyValue("--app-art-mid").trim());
      uniforms.top.value.set(css.getPropertyValue("--app-art-top").trim());
      const light = document.documentElement.dataset.scheme === "light";
      material.blending = light ? NormalBlending : AdditiveBlending;
      material.needsUpdate = true;
      uniforms.opacity.value = light ? 0.85 : 0.55;
      visibility();
    }
    const paletteObserver = new MutationObserver(syncPalette);
    paletteObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-scheme", "data-rn-theme"],
    });
    syncPalette();
    invalidate.current = visibility;
    renderer.domElement.addEventListener("webglcontextlost", lost);
    document.addEventListener("visibilitychange", visibility);
    reduced.addEventListener("change", preference);
    visibility();
    return () => {
      disposed = true;
      invalidate.current = null;
      cancelAnimationFrame(frame);
      resize.disconnect();
      paletteObserver.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      reduced.removeEventListener("change", preference);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);
  return (
    <div ref={host} className="welcome-constellation" aria-hidden="true" data-available={available}>
      {!available && <RennetLockup part="wordmark" size={48} />}
    </div>
  );
}
