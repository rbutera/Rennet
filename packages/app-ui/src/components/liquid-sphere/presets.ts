// Look and motion constants for the live liquid sphere.
//
// AUTHORITY: `brand/sources/liquid-sphere/index.html` — the animated master, where the
// mark's look and motion are authored against a lil-gui panel. Every value below is a
// copy of a field in that file's `LOOK` or `STATES` objects, and `presets.test.ts` reads
// the master off disk and fails when the two disagree. Tune the mark THERE, then carry
// the number here; never tune it here.
//
// `LOOK.background` is deliberately absent: the master paints a backdrop for the
// standalone page, while the component renders on an alpha canvas so the orb sits on
// whatever the app draws behind it. `LOOK.paused` is a panel control, not a look value.

/* eslint-disable rennet/no-hardcoded-hex -- brand artwork: the sphere's own gradient is
   the mark, authored in the master and fed to a WebGL material, not a themed surface. */
/** Palette and material, shared by both states. */
export const LOOK = {
  /** Gradient ink at the bottom of the height ramp. */
  bottom: "#d42c3b",
  /** Gradient ink through the middle of the height ramp. */
  mid: "#e8641f",
  /** Gradient ink at the top of the height ramp. */
  top: "#f2b032",
  roughness: 0.7,
  clearcoat: 0.4,
  clearcoatRoughness: 0.5,
  /** `MeshPhysicalMaterial.envMapIntensity` against the RoomEnvironment probe. */
  envIntensity: 0.53,
  /** `WebGLRenderer.toneMappingExposure` under ACES filmic tone mapping. */
  exposure: 0.8,
  /** Multiplier on elapsed time; 1 is the authored tempo. */
  speed: 1,
  /** Seconds the eased blend takes to cross between two states. */
  transition: 1.6,
} as const;
/* eslint-enable rennet/no-hardcoded-hex */

/** One state's motion parameters. Every field is linearly blended between states. */
export interface MotionPreset {
  /** Peak displacement of the primary ring field, in sphere radii. */
  ampMax: number;
  /** Ring frequency at the trough of the breath. */
  freqMin: number;
  /** Ring frequency at the crest of the breath. */
  freqMax: number;
  /** Radians per second the primary ridges travel away from the pole. */
  travel: number;
  /** Radians per second of the breathing cycle that drives amp and frequency. */
  pulse: number;
  /** Rate the pole wanders across the sphere. */
  poleDrift: number;
  /** Amplitude of the secondary ring field, from a fixed second pole. */
  ampB: number;
  /** Frequency of the secondary ring field. */
  freqB: number;
  /** Travel rate of the secondary ring field. */
  travelB: number;
  /** Radians per second the whole sphere spins about Y. */
  spin: number;
}

/** The order the blend walks, and the key set `presets.test.ts` checks. */
export const MOTION_KEYS = [
  "ampMax",
  "freqMin",
  "freqMax",
  "travel",
  "pulse",
  "poleDrift",
  "ampB",
  "freqB",
  "travelB",
  "spin",
] as const satisfies readonly (keyof MotionPreset)[];

/**
 * resting: lava lamp. Broad, slow swells; the pulse field barely breathes.
 * working: tight travelling ridges from a wandering pole.
 */
export const STATES = {
  resting: {
    ampMax: 0.028,
    freqMin: 2.5,
    freqMax: 5,
    travel: 0.35,
    pulse: 0.12,
    poleDrift: 0.06,
    ampB: 0.03,
    freqB: 2.2,
    travelB: 0.18,
    spin: 0.03,
  },
  working: {
    ampMax: 0.075,
    freqMin: 11.2,
    freqMax: 35.3,
    travel: 4.1,
    pulse: 0.87,
    poleDrift: 0.28,
    ampB: 0.018,
    freqB: 4.5,
    travelB: 0.6,
    spin: 0.08,
  },
} satisfies Record<string, MotionPreset>;
