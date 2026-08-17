// The real Rennet brand mark (issue #43): the committed small-mark geometry from
// `brand/exports/logo/svg/mark-small-{black,white}.svg`. Both exports share
// identical path data and transform — only the authored fill differs — so we carry
// the geometry once and colour it with `--mark-ink` (paper on dark, ink on light).
// That renders the white export's colour on dark and the black export's on light,
// both authored variants, never a CSS-filtered redraw of the other.
//
// The intrinsic art is wide (viewBox ~1.79:1). `size` is the rendered HEIGHT in px;
// width follows the intrinsic ratio. aria-hidden by default; pass `title` for an
// accessible name (role=img).

const VIEW_W = 128.131244;
const VIEW_H = 71.738503;

export interface RennetBrandMarkProps {
  /** Rendered height in px. Width follows the intrinsic ~1.79:1 ratio. */
  size: number;
  /** Accessible name. When given, the mark is exposed as role=img; otherwise aria-hidden. */
  title?: string;
  className?: string;
}

export const RennetBrandMark = ({ size, title, className }: RennetBrandMarkProps) => (
  <svg
    width={(size * VIEW_W) / VIEW_H}
    height={size}
    viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
    className={className}
    role={title ? "img" : undefined}
    aria-label={title}
    aria-hidden={title ? undefined : true}
    focusable="false"
  >
    {title ? <title>{title}</title> : null}
    <g
      transform="translate(0.177910,71.738503) scale(0.080000,-0.100000)"
      fill="var(--mark-ink)"
      stroke="none"
    >
      <path d="M458 705 c-231 -33 -396 -106 -444 -197 -69 -132 125 -256 466 -298 127 -16 391 -10 413 9 22 17 22 49 0 73 l-16 18 20 0 c11 0 32 9 47 21 16 12 33 18 45 14 17 -5 51 17 51 33 -1 20 -22 35 -49 35 -26 0 -30 4 -26 19 4 11 -3 26 -20 42 l-26 24 30 10 c16 6 35 20 41 32 16 30 -15 74 -56 78 -16 2 -35 9 -43 15 -11 10 -10 13 9 17 32 7 49 35 32 52 -19 19 -349 21 -474 3z M961 701 c-8 -5 -11 -16 -8 -25 8 -22 75 -22 84 -1 3 9 3 18 1 20 -10 11 -64 15 -77 6z M1132 663 c2 -11 14 -19 31 -21 22 -3 27 1 27 17 0 17 -6 21 -31 21 -24 0 -30 -4 -27 -17z M1026 634 c-22 -21 -20 -31 8 -49 26 -17 68 -12 86 10 9 10 6 19 -9 34 -25 25 -63 27 -85 5z M1305 630 c-4 -6 -3 -16 3 -22 6 -6 12 -6 17 2 4 6 3 16 -3 22 -6 6 -12 6 -17 -2z M1425 600 c-3 -5 1 -10 10 -10 9 0 13 5 10 10 -3 6 -8 10 -10 10 -2 0 -7 -4 -10 -10z M1176 585 c-8 -9 -13 -22 -10 -30 12 -29 66 -29 78 0 6 17 -19 45 -39 45 -7 0 -20 -7 -29 -15z M994 515 c-20 -31 -11 -61 26 -80 48 -25 114 13 102 57 -13 50 -100 66 -128 23z M1333 514 c-3 -9 0 -20 8 -24 18 -12 50 7 43 25 -8 20 -43 19 -51 -1z M1196 494 c-9 -8 -16 -19 -16 -24 0 -12 29 -40 41 -40 22 0 49 22 49 40 0 18 -27 40 -49 40 -5 0 -17 -7 -25 -16z M1480 495 c0 -9 5 -15 10 -13 12 4 11 16 -1 24 -5 3 -9 -2 -9 -11z M1590 470 c0 -7 3 -10 7 -7 3 4 3 10 0 14 -4 3 -7 0 -7 -7z M1129 405 c-35 -19 -42 -48 -17 -74 24 -27 62 -27 88 -1 26 26 25 36 -6 65 -31 29 -31 29 -65 10z M1425 410 c-8 -13 4 -32 16 -25 12 8 12 35 0 35 -6 0 -13 -4 -16 -10z M1317 403 c-12 -11 -7 -33 8 -39 20 -8 45 13 38 32 -5 14 -34 19 -46 7z M1550 380 c0 -5 5 -10 10 -10 6 0 10 5 10 10 0 6 -4 10 -10 10 -5 0 -10 -4 -10 -10z M1 298 l4 -87 39 -40 c101 -104 338 -171 604 -171 l114 0 -7 29 -6 29 28 14 c21 10 29 21 31 46 6 57 -6 62 -147 62 -279 0 -555 75 -637 173 l-26 31 3 -86z M984 323 c-61 -12 -73 -93 -18 -125 l31 -18 35 15 c57 23 67 80 19 114 -16 12 -33 20 -38 20 -4 -1 -18 -4 -29 -6z M1263 313 c-18 -7 -16 -50 2 -57 36 -13 65 23 39 49 -16 16 -21 17 -41 8z M1460 306 c0 -9 7 -16 16 -16 9 0 14 5 12 12 -6 18 -28 21 -28 4z M1133 257 c-23 -10 -28 -31 -17 -61 8 -20 57 -21 74 -1 28 34 -16 82 -57 62z M1364 219 c-8 -14 11 -33 25 -25 6 4 11 14 11 22 0 16 -26 19 -36 3z M870 177 c-13 -7 -29 -25 -34 -40 l-10 -28 26 -25 c20 -21 32 -25 55 -20 58 13 70 91 18 114 -31 14 -25 14 -55 -1z M1015 154 c-19 -20 -16 -43 8 -58 34 -22 73 27 47 59 -16 19 -35 19 -55 -1z M1257 164 c-14 -14 -7 -35 11 -32 9 2 17 10 17 17 0 16 -18 25 -28 15z M1127 93 c-4 -3 -7 -12 -7 -20 0 -15 26 -18 34 -4 7 11 -18 33 -27 24z M782 58 c-15 -15 3 -48 27 -48 24 0 43 23 35 44 -7 19 -45 21 -62 4z M954 55 c-4 -9 -2 -21 4 -27 16 -16 47 -5 47 17 0 26 -42 34 -51 10z" />
    </g>
  </svg>
);
