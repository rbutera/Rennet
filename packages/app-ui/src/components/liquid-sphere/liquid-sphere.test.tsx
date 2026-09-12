// @vitest-environment happy-dom
//
// happy-dom has no WebGL, so this file does NOT test the live path — there is no way to
// compile a shader here, and a test that mounted `LiquidSphere` and asserted a canvas
// appeared would be asserting the fallback while reading as coverage. What it does test
// is the fallback DECISION, which is the part that has three causes and one landing.
//
// The reduced-motion case is the one that needs care. In a bare happy-dom run the static
// mark renders for the wrong reason — no WebGL — so an assertion that "reduce gives you
// static" would pass with the reduced-motion branch deleted. So that test stubs the
// WebGL probe to SUCCEED, which makes the reduced-motion branch the only thing that can
// still choose static, and then asserts the probe was never even consulted.
//
// What none of this can catch: whether the live path renders the right picture. The orb
// itself is pinned by `presets.test.ts` (the numbers) and by eye against
// `brand/sources/liquid-sphere/index.html` (the motion).

import { describe, expect, it, vi } from "vitest";
import { mount } from "../../test/dom";
import { segmentsForSize } from "./engine";
import { LiquidSphere } from "./liquid-sphere";

/** Replace `window.matchMedia` with one that answers every query the same way. */
function stubMatchMedia(matches: boolean) {
  const matchMedia = vi.fn((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => false,
  }));
  const original = window.matchMedia;
  Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
  return {
    matchMedia,
    restore: () =>
      Object.defineProperty(window, "matchMedia", { configurable: true, value: original }),
  };
}

/**
 * Make every `canvas.getContext(…)` hand back a non-null object, so the capability probe
 * believes WebGL is available. The object is NOT a working context: three.js rejects it,
 * which is exactly the "context refused after the probe said yes" case.
 */
function stubWebGLProbe() {
  const getContext = vi.fn(() => ({ getExtension: () => null }));
  const original = HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: getContext,
  });
  return {
    getContext,
    restore: () =>
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        configurable: true,
        value: original,
      }),
  };
}

const root = (container: HTMLElement) => container.querySelector("[data-liquid-sphere]");

describe("LiquidSphere fallback", () => {
  it("renders the static mark in an environment with no WebGL", () => {
    const { container } = mount(<LiquidSphere size={48} state="resting" />);
    const el = root(container);
    expect(el?.getAttribute("data-liquid-sphere")).toBe("static");
    expect(el?.getAttribute("data-state")).toBe("resting");
    expect(container.querySelector("canvas")).toBeNull();
    // The box is the caller's `size`, square, on both the root and the mark inside it.
    expect((el as HTMLElement | null)?.style.width).toBe("48px");
    expect((el as HTMLElement | null)?.style.height).toBe("48px");
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("48");
    expect(svg?.getAttribute("height")).toBe(svg?.getAttribute("width"));
  });

  it("stops at reduced motion before it probes for WebGL at all", () => {
    const media = stubMatchMedia(true);
    const probe = stubWebGLProbe();
    try {
      const { container } = mount(<LiquidSphere size={48} state="working" />);
      expect(media.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
      expect(root(container)?.getAttribute("data-liquid-sphere")).toBe("static");
      expect(container.querySelector("canvas")).toBeNull();
      // Load-bearing: WebGL is available in this test, so "static" cannot be blamed on
      // the environment. Delete the reduced-motion branch and the probe runs, the live
      // path is taken, and this line fails.
      expect(probe.getContext).not.toHaveBeenCalled();
    } finally {
      probe.restore();
      media.restore();
    }
  });

  it("lands on the static mark when the renderer refuses the context the probe found", async () => {
    const media = stubMatchMedia(false);
    const probe = stubWebGLProbe();
    // three.js logs the refusal before rethrowing; the component catches the throw, and
    // the log is noise rather than a failure.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { container } = mount(<LiquidSphere size={48} state="working" />);
      // The probe said yes — this is the path the previous test proves is skipped.
      expect(probe.getContext).toHaveBeenCalled();
      // …and the refusal landed on the static mark instead of throwing into the tree.
      // three.js loads on its own chunk, so the refusal, and the landing, are a tick away.
      await vi.waitFor(() => {
        expect(root(container)?.getAttribute("data-liquid-sphere")).toBe("static");
      });
      expect(container.querySelector("canvas")).toBeNull();
      expect(container.querySelector("svg")).not.toBeNull();
    } finally {
      logged.mockRestore();
      probe.restore();
      media.restore();
    }
  });
});

describe("LiquidSphere chrome contract", () => {
  it("is aria-hidden without a title", () => {
    const { container } = mount(<LiquidSphere size={16} state="resting" />);
    const el = root(container);
    expect(el?.getAttribute("aria-hidden")).toBe("true");
    expect(el?.getAttribute("role")).toBeNull();
  });

  it("exposes an accessible name when given a title", () => {
    const { container } = mount(<LiquidSphere size={16} state="resting" title="Rennet" />);
    const el = root(container);
    expect(el?.getAttribute("role")).toBe("img");
    expect(el?.getAttribute("aria-label")).toBe("Rennet");
    expect(el?.getAttribute("aria-hidden")).toBeNull();
  });

  it("reports the state it was asked for, and follows a change", () => {
    const { container, rerender } = mount(<LiquidSphere size={16} state="resting" />);
    expect(root(container)?.getAttribute("data-state")).toBe("resting");
    rerender(<LiquidSphere size={16} state="working" />);
    expect(root(container)?.getAttribute("data-state")).toBe("working");
  });

  it("takes the className it was given", () => {
    const { container } = mount(<LiquidSphere size={16} state="resting" className="rn-orb" />);
    expect(root(container)?.getAttribute("class")).toBe("rn-orb");
  });
});

describe("segmentsForSize", () => {
  it("steps at the band edges rather than scaling continuously", () => {
    expect(segmentsForSize(16)).toBe(96);
    expect(segmentsForSize(64)).toBe(96);
    expect(segmentsForSize(65)).toBe(160);
    expect(segmentsForSize(160)).toBe(160);
    expect(segmentsForSize(161)).toBe(256);
    expect(segmentsForSize(512)).toBe(256);
  });
});
