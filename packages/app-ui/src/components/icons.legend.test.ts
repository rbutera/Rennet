import { describe, expect, it } from "vitest";
import * as Icons from "./icons";

// The legend is the vocabulary contract (issue #62, prototype frame `00-legend`):
// every line-icon glyph the app renders must have a legend entry — a glyph with no
// entry is a bug. Every app glyph comes from this module (no component renders an
// inline <svg>), so covering every exported glyph here covers the app. Adding a glyph
// without an ICON_LEGEND entry, or leaving a stale entry for a removed glyph, fails
// this suite. (The brand mark lives in `./brand-mark`, not here — it is the committed
// export geometry, not part of the line-icon vocabulary.)

const glyphNames = Object.keys(Icons).filter((name) => name.endsWith("Icon"));

describe("icon legend coverage (#62)", () => {
  it("has glyphs to check (guards against an empty enumeration)", () => {
    expect(glyphNames.length).toBeGreaterThan(0);
  });

  it("gives every exported glyph a legend entry", () => {
    const missing = glyphNames.filter((name) => Icons.ICON_LEGEND[name] === undefined);
    expect(missing).toEqual([]);
  });

  it("carries no legend entry for a glyph that no longer exists", () => {
    const stale = Object.keys(Icons.ICON_LEGEND).filter((name) => !glyphNames.includes(name));
    expect(stale).toEqual([]);
  });
});
