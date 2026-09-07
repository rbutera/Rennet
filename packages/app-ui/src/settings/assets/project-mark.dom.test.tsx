// @vitest-environment happy-dom
//
// The project mark (#900) — the one component every surface draws a project's identity
// through. Two questions only, because everything else about a mark is decided before it
// gets here: does a logo actually render as an image, and does a logo that will not decode
// leave the reviewer with the glyph rather than a broken square.
import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, mount } from "../../test/dom";
import { logoMark, ProjectMark } from "./project-mark";

const SRC = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";

describe("ProjectMark", () => {
  it("renders a logo as an image, decorative and contained in the glyph's square", () => {
    const { container } = mount(
      <ProjectMark mark={{ kind: "logo", logo: "detected", src: SRC }} className="size-4" />,
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(SRC);
    // Decorative like the glyph — the project's NAME is always beside it.
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("aria-hidden")).toBe("true");
    // The caller's size wins, and the image is contained rather than cropped or stretched.
    expect(img?.className).toContain("size-4");
    expect(img?.className).toContain("object-contain");
    // A logo is the author's image: no glyph is drawn underneath it.
    expect(container.querySelector("svg")).toBeNull();
    cleanup();
  });

  // POSITIVE CONTROL RUN, 2026-09-07: deleting the `onError` handler from
  // `project-mark.tsx` leaves the `<img>` in the document and reddens both assertions
  // below; the `lucide-layers` query is what makes the fallback mean "a glyph is drawn",
  // not merely "the image left".
  it("falls back to the glyph when the bytes will not decode", () => {
    const { container } = mount(
      <ProjectMark mark={{ kind: "logo", logo: "upload", src: "data:image/png;base64,zzz" }} />,
    );
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    fireEvent.error(img as Element);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg.lucide-layers")).toBeTruthy();
    cleanup();
  });

  // The refusal is earned by the BYTES, not by the component: a project whose logo is
  // re-detected or re-uploaded gets a fresh attempt. Keyed on the failing `src` rather
  // than a bare `failed` flag, which would leave the new image permanently unrendered.
  it("gives a different logo its own attempt after one has failed", () => {
    const { container, rerender } = mount(
      <ProjectMark mark={{ kind: "logo", logo: "detected", src: "data:image/png;base64,zzz" }} />,
    );
    fireEvent.error(container.querySelector("img") as Element);
    expect(container.querySelector("img")).toBeNull();
    rerender(<ProjectMark mark={{ kind: "logo", logo: "upload", src: SRC }} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(SRC);
    cleanup();
  });

  it("renders the named glyph, and the builtin one when nothing is chosen", () => {
    const chosen = mount(<ProjectMark mark={{ kind: "glyph", icon: "rocket" }} />);
    expect(chosen.container.querySelector("svg.lucide-rocket")).toBeTruthy();
    cleanup();
    const bare = mount(<ProjectMark />);
    expect(bare.container.querySelector("svg.lucide-layers")).toBeTruthy();
    cleanup();
  });

  it("turns held logo bytes into the data URL an image reads", () => {
    expect(
      logoMark({
        projectId: "p1",
        logo: "detected",
        mimeType: "image/png",
        bytesBase64: "AAAA",
        source: "assets/logo.png",
      }),
    ).toEqual({ kind: "logo", logo: "detected", src: "data:image/png;base64,AAAA" });
  });
});
