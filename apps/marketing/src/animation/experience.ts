import { createModels, sampleCodeGlyphs } from "@rennet/theme/constellation-models";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Euler,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

const vertexShader = `
attribute vec3 destination;
attribute float seed;
uniform float progress;
uniform float time;
uniform float pixelRatio;
uniform float finalScene;
varying vec3 tint;
varying float intensity;
void main() {
  float blend = progress * progress * (3.0 - 2.0 * progress);
  vec3 p = mix(position, destination, blend);
  float scatter = sin(progress * 3.14159265);
  vec3 orbit = vec3(sin(seed * 91.7 + time * .12), cos(seed * 71.3), sin(seed * 33.1));
  p += orbit * scatter * (1.0 + seed * 2.2);
  p *= 1.0 + finalScene * .024 * sin(time * 1.7);
  p.y += sin(time * .45 + seed * 6.28) * .015;
  vec4 view = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * view;
  gl_PointSize = clamp((15.0 / -view.z) * pixelRatio * (.55 + seed * .8) * mix(1.0, 1.55, finalScene), .7, 2.8);
  vec3 ember = mix(vec3(.72, .12, .035), vec3(.95, .56, .13), clamp(seed, 0.0, 1.0));
  float h = clamp(p.y / 6.5 + .5, 0.0, 1.0);
  vec3 warm = mix(vec3(.83, .17, .23), vec3(.91, .39, .12), smoothstep(.0, .55, h));
  warm = mix(warm, vec3(.95, .70, .21), smoothstep(.45, 1.0, h));
  tint = mix(ember, warm, finalScene);
  intensity = (.6 + .4 * sin(seed * 170.0 + time * .65)) * mix(.8, 1.2, seed);
}`;

const fragmentShader = `
varying vec3 tint;
varying float intensity;
uniform float luminosity;
void main() {
  float radius = length(gl_PointCoord - .5) * 2.0;
  if (radius > 1.0) discard;
  float alpha = pow(1.0 - radius, .6) * .5;
  gl_FragColor = vec4(tint * (.75 + intensity * .4) * luminosity, alpha);
}`;

function codeCloud(count: number): Float32Array | null {
  const samples = sampleCodeGlyphs();
  if (!samples) return null;
  const compact = matchMedia("(max-width: 700px)").matches;
  const output = new Float32Array(count * 3);
  const point = new Vector3();
  const rotations = [
    new Euler(0, 0.28, -0.13),
    new Euler(0, -0.35, 0.1),
    new Euler(0.1, 0.12, -0.08),
  ];
  for (let i = 0; i < count; i++) {
    const plane = i % 3;
    const sample = samples[Math.floor(i * 0.61803398875 * samples.length) % samples.length];
    point.set((sample.x / 1100 - 0.5) * 10, (0.5 - sample.y / 700) * 6.5, 0);
    point.applyEuler(rotations[compact ? 0 : plane]);
    if (compact) {
      point.multiplyScalar(1.1);
      point.x += 1.2;
      point.y += 6.4;
      point.z -= 2;
    } else {
      point.x += plane === 1 ? 12 : -12;
      point.y += plane === 2 ? -5.5 : 0.5;
      point.z += plane === 2 ? -6 : -1.5;
    }
    point.toArray(output, i * 3);
  }
  return output;
}

export function mountExperience() {
  const element = document.querySelector<HTMLCanvasElement>("#constellation-canvas");
  if (!element) return;
  const canvas = element;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const control = document.querySelector<HTMLButtonElement>(".motion-toggle");
  const chapters = [...document.querySelectorAll<HTMLElement>("[data-scene]")];
  let paused = motion.matches;
  let frame = 0;
  let elapsed = 0;
  let previousTime = 0;
  let width = 0;
  let height = 0;
  let boundaries: number[] = [];
  let target = 0;
  let current = 0;
  let activeFrom = -1;
  let activeTo = -1;
  let pointerX = 0;
  let pointerY = 0;
  let disposed = false;
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: "low-power" });
  } catch {
    control?.setAttribute("hidden", "");
    return;
  }
  const scene = new Scene();
  scene.background = new Color("#100d0b");
  const atmosphereGeometry = new PlaneGeometry(120, 100);
  const atmosphereMaterial = new ShaderMaterial({
    vertexShader: `varying vec2 uvPosition; void main() { uvPosition = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec2 uvPosition; void main() {
      vec2 p = uvPosition - vec2(.5, .47);
      float pool = exp(-dot(p * vec2(4.5, 5.0), p * vec2(4.5, 5.0)));
      float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233))) * 43758.5453);
      vec3 color = mix(vec3(.004, .004, .004), vec3(.014, .012, .010), pool);
      gl_FragColor = vec4(color + (grain - .5) * .002, 1.0);
    }`,
    depthWrite: false,
  });
  const atmosphere = new Mesh(atmosphereGeometry, atmosphereMaterial);
  atmosphere.position.z = -24;
  scene.add(atmosphere);
  const camera = new PerspectiveCamera(48, 1, 0.1, 100);
  camera.position.set(0, 2.5, 19);
  camera.lookAt(0, 0, 0);
  const count = matchMedia("(max-width: 700px)").matches ? 26000 : 72000;
  const models = createModels(count);
  models[0] = codeCloud(count) ?? models[0];
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(models[0], 3));
  geometry.setAttribute("destination", new BufferAttribute(models[0], 3));
  const seeds = Float32Array.from(
    { length: count },
    (_, i) => ((Math.sin(i * 127.1) * 43758.5453) % 1) + 0.5,
  );
  geometry.setAttribute("seed", new BufferAttribute(seeds, 1));
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      progress: { value: 0 },
      time: { value: 0 },
      pixelRatio: { value: 1 },
      finalScene: { value: 0 },
      luminosity: { value: 1.8 },
    },
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(800, 600), 0.3, 0.4, 0.25);
  composer.addPass(bloom);
  const starGeometry = new BufferGeometry();
  const stars = new Float32Array(2400 * 3);
  for (let i = 0; i < 2400; i++) {
    stars[i * 3] = ((Math.sin(i * 127.1) * 43758.5453) % 1) * 25;
    stars[i * 3 + 1] = ((Math.sin(i * 311.7) * 15731.743) % 1) * 16;
    stars[i * 3 + 2] = -8 - ((i * 13) % 24);
  }
  starGeometry.setAttribute("position", new BufferAttribute(stars, 3));
  starGeometry.setAttribute("destination", new BufferAttribute(stars, 3));
  starGeometry.setAttribute(
    "seed",
    new BufferAttribute(
      Float32Array.from({ length: 2400 }, (_, i) => (i % 100) / 100),
      1,
    ),
  );
  const starMaterial = material.clone();
  starMaterial.uniforms.luminosity.value = 0.65;
  const starField = new Points(starGeometry, starMaterial);
  scene.add(starField);

  function updateControl() {
    control?.setAttribute("aria-pressed", String(paused));
    control?.setAttribute(
      "aria-label",
      paused ? "Play background animation" : "Pause background animation",
    );
  }
  function measure() {
    boundaries = chapters.map((chapter) => chapter.getBoundingClientRect().top + scrollY);
    const nextWidth = window.innerWidth;
    const nextHeight = window.innerHeight;
    if (nextWidth !== width || nextHeight !== height) {
      width = nextWidth;
      height = nextHeight;
      const ratio = Math.min(devicePixelRatio, width < 700 ? 1.25 : 1.5);
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height, false);
      composer.setPixelRatio(ratio);
      composer.setSize(width, height);
      camera.aspect = width / height;
      camera.position.z = width < 700 ? 27 : 19;
      camera.updateProjectionMatrix();
      material.uniforms.pixelRatio.value = ratio;
      starMaterial.uniforms.pixelRatio.value = ratio;
    }
    updateScroll();
  }
  function updateScroll() {
    const position = scrollY + height * 0.58;
    let index = 0;
    for (let i = 1; i < boundaries.length; i++) if (position >= boundaries[i]) index = i;
    const next = Math.min(index + 1, models.length - 1);
    const start = Math.max(boundaries[next] - height * 0.5, index === 0 ? height * 0.73 : 0);
    const blend =
      next === index
        ? 0
        : Math.max(0, Math.min(1, (position - start) / (boundaries[next] - start)));
    target = index + blend;
    if (paused) current = target;
    requestFrame();
  }
  function render(now: number) {
    frame = 0;
    if (disposed || document.hidden) return;
    const dt = previousTime ? Math.min((now - previousTime) / 1000, 0.05) : 0.016;
    previousTime = now;
    if (!paused) elapsed += dt;
    current = paused ? Math.round(target) : target;
    const from = Math.min(Math.floor(current), models.length - 1);
    const to = Math.min(from + 1, models.length - 1);
    if (from !== activeFrom || to !== activeTo) {
      geometry.setAttribute("position", new BufferAttribute(models[from], 3));
      geometry.setAttribute("destination", new BufferAttribute(models[to], 3));
      activeFrom = from;
      activeTo = to;
    }
    material.uniforms.progress.value = current - from;
    material.uniforms.time.value = elapsed;
    material.uniforms.finalScene.value = Math.max(0, current - 4);
    starMaterial.uniforms.time.value = elapsed * 0.25;
    const intro = Math.max(0, 1 - current);
    material.uniforms.luminosity.value = 1.8 + Math.max(0, current - 4) * 1.5;
    const finale = Math.max(0, current - 4);
    const rotation = paused ? 0.16 : Math.sin(elapsed * 0.11) * 0.3;
    points.rotation.y = (rotation + pointerX * 0.055) * (1 - intro * 0.8);
    points.rotation.x = Math.sin(elapsed * 0.09) * 0.03 + pointerY * 0.02;
    const finalScroll = Math.max(0, scrollY - boundaries[5]);
    const visibleHeight = 2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.z;
    points.position.y =
      finale * (1.4 + (finalScroll / height) * visibleHeight) +
      intro * (scrollY / height) * visibleHeight;
    points.scale.setScalar(width < 700 ? 1 : 1.2);
    composer.render();
    canvas.dataset.scene = String(from);
    canvas.dataset.progress = String(current);
    canvas.dataset.frame = String(Math.round(elapsed * 1000));
    document.documentElement.dataset.webgl = "ready";
    if (!paused) requestFrame();
  }
  function requestFrame() {
    if (!frame && !disposed && !document.hidden) frame = requestAnimationFrame(render);
  }
  function toggleMotion() {
    paused = !paused;
    updateControl();
    requestFrame();
  }
  function changeMotion() {
    paused = motion.matches;
    updateControl();
    requestFrame();
  }
  function visibility() {
    if (document.hidden) cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
    requestFrame();
  }
  function pointer(event: PointerEvent) {
    if (paused || event.pointerType !== "mouse") return;
    pointerX = event.clientX / width - 0.5;
    pointerY = event.clientY / height - 0.5;
  }
  const resize = new ResizeObserver(measure);
  resize.observe(document.body);
  window.addEventListener("resize", measure);
  window.addEventListener("scroll", updateScroll, { passive: true });
  window.addEventListener("pointermove", pointer, { passive: true });
  document.addEventListener("visibilitychange", visibility);
  motion.addEventListener("change", changeMotion);
  control?.addEventListener("click", toggleMotion);
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    cancelAnimationFrame(frame);
    disposed = true;
    document.documentElement.dataset.webgl = "fallback";
    control?.setAttribute("hidden", "");
  });
  window.addEventListener(
    "pagehide",
    (event) => {
      if (event.persisted) return;
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      geometry.dispose();
      atmosphereGeometry.dispose();
      atmosphereMaterial.dispose();
      starGeometry.dispose();
      material.dispose();
      starMaterial.dispose();
      bloom.dispose();
      composer.dispose();
      renderer.dispose();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", updateScroll);
      window.removeEventListener("pointermove", pointer);
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", changeMotion);
      control?.removeEventListener("click", toggleMotion);
    },
    { once: true },
  );
  updateControl();
  measure();
}
