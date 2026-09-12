// The three.js half of the live liquid sphere: one renderer, one scene, one mesh, and
// the step function that advances the motion. React owns when this runs; this file owns
// what a frame looks like.
//
// AUTHORITY: `brand/sources/liquid-sphere/index.html` — the animated master. The GLSL
// below (`ring` / `disp` / `surf`, the normal reconstruction, the height gradient) is
// carried across verbatim, and the numbers it reads live in `presets.ts`, which
// `presets.test.ts` pins against the master. Two deliberate departures, both because
// this is a component on a page rather than a full-window standalone:
//
//   • The canvas is alpha with a clear alpha of 0 and the scene has no background, so
//     the orb composites over whatever the app draws behind it.
//   • Sphere tessellation scales with the rendered size (the master is fixed at 320²,
//     which is wasteful for a 16 px chrome mark).
//
// The master also carries a `loop` mode that quantises every rate so a capture repeats
// exactly. That is a render-farm concern; this engine is live-mode only, so phases
// accumulate and a state change keeps its phase continuous.

import {
  ACESFilmicToneMapping,
  Clock,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { LOOK, MOTION_KEYS, type MotionPreset, STATES } from "./presets";

/** The two motion presets the sphere crosses between. */
export type LiquidSphereState = keyof typeof STATES;

/**
 * Sphere tessellation for a rendered size in CSS px. Bands rather than a formula so a
 * one-pixel layout nudge cannot churn the geometry: it is rebuilt only on a band cross.
 */
export function segmentsForSize(size: number): number {
  if (size <= 64) return 96;
  if (size <= 160) return 160;
  return 256;
}

/** Longest step the integrator will take. A resumed loop lands here, not on a jump. */
const MAX_FRAME_SECONDS = 0.05;

/** Hermite ease, used both for the state blend and for the breath. */
const smooth = (x: number) => x * x * (3 - 2 * x);

export interface SphereEngine {
  /** The renderer's canvas. The caller puts it in the document and takes it out again. */
  readonly canvas: HTMLCanvasElement;
  /** Resize the drawing buffer, rebuilding geometry if the size crossed a band. */
  setSize(size: number): void;
  /** Aim the eased blend at a state. Phases keep running; nothing restarts. */
  setTarget(state: LiquidSphereState): void;
  /** Advance by the wall-clock delta since the previous call, then draw. */
  frame(): void;
  /** Release the context and every GPU resource this engine owns. */
  dispose(): void;
}

export interface SphereEngineOptions {
  /** Rendered width and height in CSS px. */
  size: number;
  /** The state the sphere starts in, fully settled — no opening transition. */
  state: LiquidSphereState;
}

/**
 * Build a sphere engine. Throws if the browser refuses a WebGL context; the caller
 * treats that as "render the static mark instead".
 */
export function createSphereEngine(options: SphereEngineOptions): SphereEngine {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false });
  try {
    return buildSphereEngine(renderer, options);
  } catch (error) {
    // Anything after the context exists (the environment map, a shader compile) can
    // still throw. Hand the context back before rethrowing so a failed build does not
    // hold one of the browser's few live contexts for the life of the page.
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
}

/** Clamp the display's ratio: 3x panels cost 9x the pixels for no visible gain at 24 px. */
function pixelRatio(): number {
  return Math.min(globalThis.devicePixelRatio || 1, 2);
}

function buildSphereEngine(
  renderer: WebGLRenderer,
  { size, state }: SphereEngineOptions,
): SphereEngine {
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(size, size);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = LOOK.exposure;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.domElement.style.display = "block";

  // No `scene.background`: the clear colour's zero alpha is what shows through.
  const scene = new Scene();

  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04).texture;
  scene.environment = environment;
  room.dispose();

  // Square canvas, so the aspect is 1 for every size and never needs updating.
  const camera = new PerspectiveCamera(28, 1, 0.1, 20);
  camera.position.set(0, 0.35, 5.2);
  camera.lookAt(0, 0, 0);

  const key = new DirectionalLight(0xfff4e0, 0.85);
  key.position.set(-2.5, 4, 3.5);
  scene.add(key);
  const fill = new HemisphereLight(0xffe9d2, 0xc86a50, 0.6);
  scene.add(fill);

  const uniforms = {
    uPole: { value: new Vector3(0, 1, 0) },
    uPoleB: { value: new Vector3(1, 0.2, 0.3).normalize() },
    uFreq: { value: 12 },
    uAmp: { value: 0.03 },
    uPhase: { value: 0 },
    uFreqB: { value: 4.5 },
    uAmpB: { value: 0.018 },
    uPhaseB: { value: 0 },
    uBottom: { value: new Color(LOOK.bottom) },
    uMid: { value: new Color(LOOK.mid) },
    uTop: { value: new Color(LOOK.top) },
  };

  const material = new MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: LOOK.roughness,
    metalness: 0,
    clearcoat: LOOK.clearcoat,
    clearcoatRoughness: LOOK.clearcoatRoughness,
    envMapIntensity: LOOK.envIntensity,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `
      #include <common>
      uniform vec3 uPole, uPoleB;
      uniform float uFreq, uAmp, uPhase, uFreqB, uAmpB, uPhaseB;
      varying float vHeight;

      // Ring ripple radiating from a pole. Ridges broad, creases narrow
      // (stacked tori), flat cap at the pole, damped on the far side.
      float ring(vec3 n, vec3 pole, float freq, float phase) {
        float a = acos(clamp(dot(n, pole), -1.0, 1.0));   // 0 at pole, π at antipode
        float s = 0.5 + 0.5 * sin(a * freq - phase);
        float w = 1.0 - 2.0 * pow(1.0 - s, 2.2);
        float env = smoothstep(0.0, 0.32, a) * mix(0.3, 1.0, smoothstep(3.1416, 0.7, a));
        return w * env;
      }
      float disp(vec3 n) {
        return uAmp * ring(n, uPole, uFreq, uPhase)
             + uAmpB * ring(n, uPoleB, uFreqB, uPhaseB);
      }
      vec3 surf(vec3 n) { return n * (1.0 + disp(n)); }
      `,
      )
      .replace(
        "#include <beginnormal_vertex>",
        /* glsl */ `
      vec3 n0 = normalize(position);
      vec3 up = abs(n0.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 tX = normalize(cross(up, n0));
      vec3 tY = cross(n0, tX);
      float e = 0.006;
      vec3 pC = surf(n0);
      vec3 pX = surf(normalize(n0 + tX * e));
      vec3 pY = surf(normalize(n0 + tY * e));
      vec3 objectNormal = normalize(cross(pX - pC, pY - pC));
      `,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `
      vec3 transformed = pC;
      vHeight = pC.y;
      `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `
      #include <common>
      uniform vec3 uBottom, uMid, uTop;
      varying float vHeight;
      `,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `
      #include <color_fragment>
      {
        float h = clamp(vHeight * 0.5 + 0.5, 0.0, 1.0);
        vec3 g = mix(uBottom, uMid, smoothstep(0.08, 0.5, h));
        g = mix(g, uTop, smoothstep(0.62, 1.0, h));
        diffuseColor.rgb *= g;
      }
      `,
      );
  };

  let segments = segmentsForSize(size);
  let geometry = new SphereGeometry(1, segments, segments);
  const sphere = new Mesh(geometry, material);
  scene.add(sphere);

  // ── motion state ──────────────────────────────────────────────────────────────
  const clock = new Clock();
  const motion: MotionPreset = { ...STATES.resting };
  const pole = new Vector3();
  const phases = { a: 0, b: 0, spin: 0 };
  let target: LiquidSphereState = state;
  let blend = state === "working" ? 1 : 0;
  let elapsed = 0;

  function step(dt: number): void {
    const direction = target === "working" ? 1 : -1;
    blend = Math.min(1, Math.max(0, blend + (direction * dt) / LOOK.transition));
    const k = smooth(blend);
    for (const name of MOTION_KEYS) {
      motion[name] = STATES.resting[name] + (STATES.working[name] - STATES.resting[name]) * k;
    }

    elapsed += dt * LOOK.speed;
    const scaled = dt * LOOK.speed;

    const drift = motion.poleDrift;
    pole
      .set(
        Math.sin(elapsed * drift * 1.0) * 0.9,
        Math.cos(elapsed * drift * 0.73) * 1.0,
        Math.sin(elapsed * drift * 0.57 + 1.3) * 0.8,
      )
      .normalize();
    uniforms.uPole.value.copy(pole);

    const breathe = smooth(0.5 + 0.5 * Math.sin(elapsed * motion.pulse));
    uniforms.uAmp.value = motion.ampMax * (0.25 + 0.75 * breathe);
    uniforms.uFreq.value = motion.freqMin + (motion.freqMax - motion.freqMin) * breathe;

    phases.a += scaled * motion.travel;
    phases.b += scaled * motion.travelB;
    phases.spin += scaled * motion.spin;

    uniforms.uPhase.value = phases.a;
    uniforms.uAmpB.value = motion.ampB;
    uniforms.uFreqB.value = motion.freqB;
    uniforms.uPhaseB.value = phases.b;
    sphere.rotation.y = phases.spin;
  }

  return {
    canvas: renderer.domElement,
    setSize(next) {
      // Re-read the ratio: the window may have moved to a display with a different one.
      renderer.setPixelRatio(pixelRatio());
      renderer.setSize(next, next);
      const wanted = segmentsForSize(next);
      if (wanted === segments) return;
      segments = wanted;
      const replacement = new SphereGeometry(1, segments, segments);
      sphere.geometry = replacement;
      geometry.dispose();
      geometry = replacement;
    },
    setTarget(next) {
      target = next;
    },
    frame() {
      step(Math.min(clock.getDelta(), MAX_FRAME_SECONDS));
      renderer.render(scene, camera);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
