// Drift guard. `presets.ts` is a COPY of numbers authored in the animated master, and a
// copy rots: someone tunes the sphere in `brand/sources/liquid-sphere/index.html` against
// its lil-gui panel, saves a png, and the shipped mark quietly keeps the old look. This
// test reads the master off disk and fails when the two disagree.
//
// It reads the master as TEXT rather than importing it, because the master is an HTML
// page whose module needs a DOM, three.js from a CDN, and a WebGL context. The regexes
// below are therefore the weak point: they can only fail when they find a value and it
// differs. To keep a silent no-match from passing as agreement, every extractor throws
// when its key is missing, and the LOOK/STATES slices are asserted non-empty first.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOOK, MOTION_KEYS, STATES } from "./presets";

const MASTER = readFileSync(
  fileURLToPath(new URL("../../../../../brand/sources/liquid-sphere/index.html", import.meta.url)),
  "utf8",
);

/** The body of a top-level `const <name> = { … };` object literal in the master. */
function objectLiteral(name: string): string {
  const match = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(MASTER);
  const body = match?.[1];
  if (!body) throw new Error(`master has no \`const ${name} = { … }\` block`);
  return body;
}

/** The body of a nested `<name>: { … }` object inside `source`. */
function nestedLiteral(source: string, name: string): string {
  const match = new RegExp(`${name}:\\s*\\{([\\s\\S]*?)\\n  \\}`).exec(source);
  const body = match?.[1];
  if (!body) throw new Error(`master has no \`${name}: { … }\` block`);
  return body;
}

/** The raw text of one `key: value` pair, up to the comma that ends it. */
function field(source: string, key: string): string {
  const match = new RegExp(`\\b${key}:\\s*([^,\\n]+)`).exec(source);
  const raw = match?.[1]?.trim();
  if (!raw) throw new Error(`master has no \`${key}:\` field in that block`);
  return raw;
}

const colour = (source: string, key: string) => field(source, key).replace(/^"|"$/g, "");
const number = (source: string, key: string) => {
  const value = Number(field(source, key));
  if (Number.isNaN(value)) throw new Error(`master's \`${key}\` is not a number`);
  return value;
};

describe("liquid sphere presets match the animated master", () => {
  const look = objectLiteral("LOOK");
  const states = objectLiteral("STATES");

  it("finds the master's LOOK and STATES blocks", () => {
    // Without this, a renamed or reformatted master would make every extractor below
    // throw — loudly, but for a reason the failure message would not explain.
    expect(look.length).toBeGreaterThan(0);
    expect(states.length).toBeGreaterThan(0);
  });

  it("carries the master's palette", () => {
    expect(LOOK.bottom).toBe(colour(look, "bottom"));
    expect(LOOK.mid).toBe(colour(look, "mid"));
    expect(LOOK.top).toBe(colour(look, "top"));
  });

  it("carries the master's material and transition values", () => {
    expect(LOOK.roughness).toBe(number(look, "roughness"));
    expect(LOOK.clearcoat).toBe(number(look, "clearcoat"));
    expect(LOOK.clearcoatRoughness).toBe(number(look, "clearcoatRoughness"));
    expect(LOOK.envIntensity).toBe(number(look, "envIntensity"));
    expect(LOOK.exposure).toBe(number(look, "exposure"));
    expect(LOOK.speed).toBe(number(look, "speed"));
    expect(LOOK.transition).toBe(number(look, "transition"));
  });

  it("carries every motion number of both states", () => {
    for (const state of ["resting", "working"] as const) {
      const block = nestedLiteral(states, state);
      for (const key of MOTION_KEYS) {
        expect(`${state}.${key} = ${STATES[state][key]}`).toBe(
          `${state}.${key} = ${number(block, key)}`,
        );
      }
    }
  });

  it("reads every motion key the blend walks", () => {
    // The loop above is only a guard for the keys it iterates. This pins the key SET:
    // a preset field added to the master and to `presets.ts` but left out of
    // MOTION_KEYS would never be blended, and nothing else here would notice.
    for (const state of ["resting", "working"] as const) {
      expect([...MOTION_KEYS].sort()).toEqual(Object.keys(STATES[state]).sort());
    }
  });
});
