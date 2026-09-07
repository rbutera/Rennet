import type { ProjectLogo, ProjectLogoKind } from "@rennet/protocol";
import { cn } from "@rennet/ui";
import { useState } from "react";
import { ProjectIcon, type ProjectIconName } from "./project-icon";

// ─────────────────────────────────────────────────────────────────────────────
// The project MARK (#900) — the visual that identifies a project everywhere the
// shell shows it. A mark is either a glyph from the fixed vocabulary or a logo
// image, and WHICH one a project shows is decided on the settings ladder before it
// reaches here: this component renders the resolved answer, it never resolves one.
//
// A logo rides the wire as base64 bytes and renders through a `data:` URL, so the
// desktop renderer and the served browser tab share one path with no static route.
// It is drawn as the author made it: contained in the square the glyph occupied, no
// recolouring, no dark-scheme treatment, no background of its own. Decorative like
// the glyph — the project's NAME is always beside it, so the image is `alt=""`.
// ─────────────────────────────────────────────────────────────────────────────

/** The resolved mark for one project: a glyph, or a logo's `data:` URL with the kind
 *  of logo it is (the detected repo image, or the user's upload). */
export type ProjectMarkView =
  | { readonly kind: "glyph"; readonly icon: ProjectIconName }
  | { readonly kind: "logo"; readonly logo: ProjectLogoKind; readonly src: string };

/** One held logo as a mark: its bytes as the `data:` URL an `<img>` reads. */
export function logoMark(logo: ProjectLogo): ProjectMarkView {
  return {
    kind: "logo",
    logo: logo.logo,
    src: `data:${logo.mimeType};base64,${logo.bytesBase64}`,
  };
}

export function ProjectMark({
  mark,
  className,
}: {
  /** The resolved mark; absent renders the default glyph, exactly as `ProjectIcon` does. */
  readonly mark?: ProjectMarkView;
  readonly className?: string;
}) {
  // Bytes that will not decode fall back to the glyph rather than leaving a broken
  // image in a sidebar row. Keyed by the SRC that failed, so a later mark — a
  // re-detection, a fresh upload — gets its own attempt instead of inheriting a
  // refusal earned by different bytes.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);

  if (mark?.kind === "logo" && mark.src !== brokenSrc) {
    return (
      <img
        src={mark.src}
        alt=""
        aria-hidden="true"
        onError={() => setBrokenSrc(mark.src)}
        // `size-3.5` is the row glyph's size; a caller sizing its glyph differently
        // passes the same class it passes `ProjectIcon`, so the mark occupies exactly
        // the square it replaces whichever kind it is.
        className={cn("size-3.5 shrink-0 rounded-sm object-contain", className)}
      />
    );
  }
  return (
    <ProjectIcon icon={mark?.kind === "glyph" ? mark.icon : undefined} className={className} />
  );
}
