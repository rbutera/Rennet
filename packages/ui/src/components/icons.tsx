// Rennet icon set — a small, consistent stroke vocabulary matching the mood-board
// (prototypes/moodboard: 1.6px currentColor stroke, round caps/joins, inline SVG).
// Icons are decorative: each is aria-hidden so it never changes a control's
// accessible name (the button text stays the label). No hardcoded hex — stroke and
// fill ride currentColor, so an icon takes the colour of whatever it sits in.

import type { ReactNode, SVGProps } from "react";

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function Icon({ size = 14, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Approve — a check. */
export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8.5 6.5 12 13 4.5" />
  </Icon>
);

/** Request change / blast / disagreement — a warning triangle (amber family). */
export const TriangleIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.5 14.5 13.5H1.5z" />
    <path d="M8 6.5v3" />
    <circle cx="8" cy="11.6" r="0.3" />
  </Icon>
);

/** Comment — a chat bubble. */
export const CommentIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 3h11v7.5h-6L4 13.5V10.5H2.5z" />
  </Icon>
);

/** Question — a help circle. */
export const QuestionIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.3 6.2a1.8 1.8 0 0 1 3.4.6c0 1.2-1.7 1.5-1.7 2.6" />
    <circle cx="8" cy="11.6" r="0.3" />
  </Icon>
);

/** Chevron — expand/collapse (rotate 0/-90 via CSS or the caller). */
export const ChevronIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6 8 10l4-4" />
  </Icon>
);

/** Folder — choose a repository. */
export const FolderIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M1.75 4.25c0-.55.45-1 1-1H6l1.5 1.5h5.75c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z" />
  </Icon>
);

/** Diff / files — the raw-diff view. */
export const FileDiffIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 1.75h5l3 3v9.5H4z" />
    <path d="M9 1.75v3h3" />
    <path d="M6 8h4M8 6v4" />
  </Icon>
);

/** Layers / canvases — the AI-review view. */
export const LayersIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2 14 5 8 8 2 5z" />
    <path d="M2 8l6 3 6-3" />
    <path d="M2 11l6 3 6-3" />
  </Icon>
);

/** Target / destination — the north the review stages toward. */
export const TargetIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <circle cx="8" cy="8" r="3" />
    <circle cx="8" cy="8" r="0.4" />
  </Icon>
);

/** Arrow-right — proceed (open the draft, provenance base→head). */
export const ArrowRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 8h11M9.5 4l4 4-4 4" />
  </Icon>
);

/** Arrow-left — back. */
export const ArrowLeftIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.5 8h-11M6.5 4l-4 4 4 4" />
  </Icon>
);

/** Lock — private to you / the signable seal. */
export const LockIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="7" width="10" height="6.5" rx="1.4" />
    <path d="M5.4 7V5.4a2.6 2.6 0 0 1 5.2 0V7" />
  </Icon>
);

/** Pen / sign — the publish ceremony. */
export const SignIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11.5 2.5 13.5 4.5 6 12l-2.6.6L4 10z" />
    <path d="M1.5 14.5h13" />
  </Icon>
);

/** Close — dismiss the paper. */
export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

/** Plus — the persistent add-a-project affordance. */
export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

/** Monitor / device — a workspace (a folder holding several repos). */
export const MonitorIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="8.5" rx="1.3" />
    <path d="M6 14h4M8 11.5V14" />
  </Icon>
);

/** Git branch — a project repo (one repo). */
export const GitBranchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="4.5" cy="3.5" r="1.6" />
    <circle cx="4.5" cy="12.5" r="1.6" />
    <circle cx="11.5" cy="4.5" r="1.6" />
    <path d="M4.5 5.1v5.8M4.5 8h4a3 3 0 0 0 3-3v-.4" />
  </Icon>
);

/** Sparkle / asterisk — the ambient harness-detection glyph (backlight). */
export const SparkleIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2v12M2.8 5l10.4 6M13.2 5 2.8 11" />
  </Icon>
);

/** The Rennet wordmark glyph — an R in a rounded square, used at the front door
 * and in the Files titlebar. Sized larger by default. */
export const RennetMark = ({ size = 30, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    <text
      x="16"
      y="22"
      textAnchor="middle"
      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      fontWeight="800"
      fontSize="20"
      fill="currentColor"
    >
      R
    </text>
  </svg>
);
