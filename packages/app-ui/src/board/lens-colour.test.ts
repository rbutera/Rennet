import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LENS_KINDS } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { LENS_SLOT, LENS_TINT, lensSlot, lensTint } from "./lens-colour";

// The lens→slot mapping is a JOIN across two packages: `packages/theme` owns the five
// hue slots, this package owns which lens takes which. Nothing at runtime notices when
// the two disagree — a tint naming a slot the palette does not define resolves to the
// `var(--rn-lens, var(--rn-ink-soft))` fallback, so every lens silently goes grey and
// the bench still renders. That is the failure these tests exist to catch, and it is
// why they read the REAL palette.css rather than a copy of the slot names.

const paletteCss = readFileSync(
  fileURLToPath(new URL("../../../theme/src/palette.css", import.meta.url)),
  "utf8",
);

/** The slots the palette actually defines, read out of the file. */
const definedSlots = [...paletteCss.matchAll(/--rn-lens-([a-z]+)\s*:/g)].map((m) => m[1] as string);

describe("the lens colour register", () => {
  it("the palette defines the five slots this mapping expects (the read is not vacuous)", () => {
    expect([...new Set(definedSlots)].sort()).toEqual([
      "blue",
      "green",
      "neutral",
      "red",
      "yellow",
    ]);
  });

  it("every lens the protocol knows has a slot and a tint", () => {
    // Driven off LENS_KINDS, not a list retyped here: a sixth lens lands with no
    // colour and this reddens rather than shipping a grey lane.
    expect(Object.keys(LENS_SLOT).sort()).toEqual([...LENS_KINDS].sort());
    expect(Object.keys(LENS_TINT).sort()).toEqual([...LENS_KINDS].sort());
  });

  it("carries the mapping Rai set: flagged red, decisions yellow, design blue, sequence green, noise neutral", () => {
    expect(LENS_SLOT).toEqual({
      flagged: "red",
      decisions: "yellow",
      design: "blue",
      sequence: "green",
      noise: "neutral",
    });
  });

  it("every tint binds a slot the palette really defines", () => {
    // The silent one. `[--rn-lens:var(--rn-lens-blu)]` is valid CSS, generates a real
    // utility, and paints ink-soft.
    for (const lens of LENS_KINDS) {
      const slot = LENS_TINT[lens].match(/var\(--rn-lens-([a-z]+)\)/)?.[1];
      expect(slot, `${lens} tint names a slot`).toBeDefined();
      expect(definedSlots, `${lens} binds --rn-lens-${slot}`).toContain(slot);
      expect(slot, `${lens} tint agrees with its slot`).toBe(LENS_SLOT[lens]);
    }
  });

  it("four lenses take four different slots, and only Noise is quiet", () => {
    // Without this, a mapping that bound every lens to `neutral` would satisfy every
    // assertion above about definedness.
    const slots = LENS_KINDS.map((lens) => LENS_SLOT[lens]);
    expect(new Set(slots).size).toBe(5);
    expect(slots.filter((s) => s === "neutral")).toEqual(["neutral"]);
  });

  it("a lane id this client has never heard of falls back to the quiet slot, not to nothing", () => {
    // Lane ids arrive off the wire as strings. An unknown one must still bind a hue,
    // or its subtree inherits whichever lens is nearest in the tree.
    expect(lensSlot("cheese")).toBe("neutral");
    expect(lensTint("cheese")).toBe(LENS_TINT.noise);
    // Control: a known id does NOT take the fallback path.
    expect(lensTint("design")).toBe(LENS_TINT.design);
    expect(lensTint("design")).not.toBe(LENS_TINT.noise);
  });
});
