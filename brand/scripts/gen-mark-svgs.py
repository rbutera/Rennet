#!/usr/bin/env python3
"""Author the static Rennet marks from the liquid-sphere parameters.

Writes three committed sources under brand/sources/:
  mark-sphere.svg        the colour mark: a resting-state frame as gradients on a wobbly disc
  mark-ridged.svg        the monochrome mark: the working-state silhouette, one fill
  mark-ridged-small.svg  the same silhouette with fewer, deeper ridges for 16-32 px

The ridge function is the one in brand/sources/liquid-sphere/index.html, so the
silhouette is the shader's outline, not a drawing of it.
"""
from __future__ import annotations

import math
from pathlib import Path

SOURCES = Path(__file__).resolve().parents[1] / "sources"
R = 46.0
N = 180

# Resting palette, identical to LOOK in the animated master.
BOTTOM, MID, TOP = "#d42c3b", "#e8641f", "#f3b437"


def smoothstep(a: float, b: float, x: float) -> float:
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def ridge(a: float, freq: float, phase: float) -> float:
    """Shader ring(): broad ridges, narrow creases, flat cap, damped far side."""
    s = 0.5 + 0.5 * math.sin(a * freq - phase)
    w = 1.0 - 2.0 * (1.0 - s) ** 2.2
    env = smoothstep(0.0, 0.32, a) * (0.3 + 0.7 * (1 - smoothstep(0.7, math.pi, a)))
    return w * env


def outline(radius_at) -> str:
    """Closed smooth path through N polar samples (Catmull-Rom → cubic Béziers)."""
    pts = []
    for i in range(N):
        th = i / N * math.tau
        r = radius_at(th)
        pts.append((50 + r * math.cos(th), 50 + r * math.sin(th)))
    d = [f"M{pts[0][0]:.3f},{pts[0][1]:.3f}"]
    for i in range(N):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[(i + 1) % N], pts[(i + 2) % N]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d.append(f"C{c1[0]:.3f},{c1[1]:.3f} {c2[0]:.3f},{c2[1]:.3f} {p2[0]:.3f},{p2[1]:.3f}")
    return " ".join(d) + " Z"


def sphere_svg() -> str:
    # Resting state: two low-frequency swells, the same amplitude the shader rests at.
    def r(th: float) -> float:
        return R * (1 + 0.018 * math.sin(3 * th + 0.4) + 0.012 * math.sin(2 * th - 1.1))

    r_path = outline(r)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Rennet">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.04" stop-color="{TOP}"/>
      <stop offset="0.30" stop-color="{TOP}"/>
      <stop offset="0.58" stop-color="{MID}"/>
      <stop offset="0.96" stop-color="{BOTTOM}"/>
    </linearGradient>
    <radialGradient id="light" cx="0.36" cy="0.28" r="0.55">
      <stop offset="0" stop-color="#fff3d6" stop-opacity="0.6"/>
      <stop offset="0.45" stop-color="#fff3d6" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#fff3d6" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="shade" cx="0.42" cy="0.38" r="0.66">
      <stop offset="0.62" stop-color="#7a1020" stop-opacity="0"/>
      <stop offset="1" stop-color="#7a1020" stop-opacity="0.26"/>
    </radialGradient>
    <clipPath id="disc"><path d="{r_path}"/></clipPath>
  </defs>
  <g clip-path="url(#disc)">
    <rect width="100" height="100" fill="url(#body)"/>
    <rect width="100" height="100" fill="url(#shade)"/>
    <rect width="100" height="100" fill="url(#light)"/>
  </g>
</svg>
'''


def ridged_svg(rings: int, crease: float, scallop: float) -> str:
    """Monochrome mark: the working sphere seen from slightly above, pole at the top.

    One fill. The body is a disc whose sides scallop where each ridge meets the
    outline; the creases between ridges are cut out of the fill through a mask,
    so the mark stays a single recolourable colour with paper showing through.
    """
    elev = math.radians(22)          # camera elevation: creases curve downward
    cap = 0.45                       # polar angle of the flat cap edge
    # polar angles of the creases, evenly spaced from the cap edge to the damped far side
    lo, hi = cap, math.radians(150)
    creases = [lo + (hi - lo) * (i + 0.5) / rings for i in range(rings)]

    def r(th: float) -> float:
        # scallops only where the rings cross the silhouette: the sides, not the cap
        a = abs(((th + math.pi / 2) % math.tau) - math.pi)      # 0 at top, π at bottom
        side = math.cos(th) ** 2                                  # 1 at left/right, 0 at top/bottom
        bump = 0.0
        for c in creases:
            bump += -math.exp(-((a - c) / 0.11) ** 2)                # a notch at each crease
        return R * (1 + scallop * bump * side)

    body = outline(r)
    cuts = []
    for c in creases:
        rho = R * math.sin(c)
        y = 50 - R * math.cos(c) * math.cos(elev)
        ry = rho * math.sin(elev)
        # front half of the latitude circle, drawn as an elliptical arc
        cuts.append(f'<path d="M{50 - rho:.3f},{y:.3f} A{rho:.3f},{ry:.3f} 0 0 0 {50 + rho:.3f},{y:.3f}" />')
    cut_paths = "\n    ".join(cuts)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Rennet">
  <defs>
    <mask id="creases" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
      <rect width="100" height="100" fill="#ffffff"/>
      <g fill="none" stroke="#000000" stroke-width="{crease}" stroke-linecap="round">
    {cut_paths}
      </g>
    </mask>
  </defs>
<g fill="#0B0D10" stroke="none" mask="url(#creases)">
<path d="{body}"/>
</g>
</svg>
'''


def main() -> None:
    (SOURCES / "mark-sphere.svg").write_text(sphere_svg(), encoding="utf-8")
    (SOURCES / "mark-ridged.svg").write_text(ridged_svg(rings=6, crease=2.6, scallop=0.05), encoding="utf-8")
    (SOURCES / "mark-ridged-small.svg").write_text(ridged_svg(rings=3, crease=5.0, scallop=0.07), encoding="utf-8")


if __name__ == "__main__":
    main()
