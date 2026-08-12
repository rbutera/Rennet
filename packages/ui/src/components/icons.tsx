// Rennet icon set — a small, consistent stroke vocabulary matching the design
// language (1.6px currentColor stroke, round caps/joins, inline SVG; see the
// canonical wireframes in wireframes/src/kit.mjs).
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

/** Sliders — the settings glyph (the config ladder's nav affordance, wireframe #15). */
export const SlidersIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 4.5h7M11.5 4.5h2M2.5 8h2M6.5 8h7M2.5 11.5h7M11.5 11.5h2" />
    <circle cx="10.5" cy="4.5" r="1.5" />
    <circle cx="5.5" cy="8" r="1.5" />
    <circle cx="10.5" cy="11.5" r="1.5" />
  </Icon>
);

/** Sparkle / asterisk — the ambient harness-detection glyph (backlight). */
export const SparkleIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2v12M2.8 5l10.4 6M13.2 5 2.8 11" />
  </Icon>
);

/** Small-size trace of the selected Rennet cheese-wheel mark. */
export const RennetMark = ({ size = 30, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 128.131244 71.738503"
    fill="none"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    <g transform="translate(.17791 71.738503) scale(.08 -.1)" fill="currentColor">
      <path d="M458 705c-231-33-396-106-444-197-69-132 125-256 466-298 127-16 391-10 413 9 22 17 22 49 0 73l-16 18h20c11 0 32 9 47 21 16 12 33 18 45 14 17-5 51 17 51 33-1 20-22 35-49 35-26 0-30 4-26 19 4 11-3 26-20 42l-26 24 30 10c16 6 35 20 41 32 16 30-15 74-56 78-16 2-35 9-43 15-11 10-10 13 9 17 32 7 49 35 32 52-19 19-349 21-474 3zm503-4c-8-5-11-16-8-25 8-22 75-22 84-1 3 9 3 18 1 20-10 11-64 15-77 6zm171-38c2-11 14-19 31-21 22-3 27 1 27 17 0 17-6 21-31 21-24 0-30-4-27-17zm-106-29c-22-21-20-31 8-49 26-17 68-12 86 10 9 10 6 19-9 34-25 25-63 27-85 5zm279-4c-4-6-3-16 3-22s12-6 17 2c4 6 3 16-3 22s-12 6-17-2zm120-30c-3-5 1-10 10-10s13 5 10 10c-3 6-8 10-10 10s-7-4-10-10zm-249-15c-8-9-13-22-10-30 12-29 66-29 78 0 6 17-19 45-39 45-7 0-20-7-29-15zM994 515c-20-31-11-61 26-80 48-25 114 13 102 57-13 50-100 66-128 23zm339-1c-3-9 0-20 8-24 18-12 50 7 43 25-8 20-43 19-51-1zm-137-20c-9-8-16-19-16-24 0-12 29-40 41-40 22 0 49 22 49 40 0 18-27 40-49 40-5 0-17-7-25-16zm284 1c0-9 5-15 10-13 12 4 11 16-1 24-5 3-9-2-9-11zm110-25c0-7 3-10 7-7 3 4 3 10 0 14-4 3-7 0-7-7zm-461-65c-35-19-42-48-17-74 24-27 62-27 88-1 26 26 25 36-6 65-31 29-31 29-65 10zm296 5c-8-13 4-32 16-25 12 8 12 35 0 35-6 0-13-4-16-10zm-108-7c-12-11-7-33 8-39 20-8 45 13 38 32-5 14-34 19-46 7zm233-23c0-5 5-10 10-10 6 0 10 5 10 10 0 6-4 10-10 10-5 0-10-4-10-10zM1 298l4-87 39-40C145 67 382 0 648 0h114l-7 29-6 29 28 14c21 10 29 21 31 46 6 57-6 62-147 62-279 0-555 75-637 173l-26 31 3-86zm983 25c-61-12-73-93-18-125l31-18 35 15c57 23 67 80 19 114-16 12-33 20-38 20-4-1-18-4-29-6zm279-10c-18-7-16-50 2-57 36-13 65 23 39 49-16 16-21 17-41 8zm197-7c0-9 7-16 16-16 9 0 14 5 12 12-6 18-28 21-28 4zm-327-49c-23-10-28-31-17-61 8-20 57-21 74-1 28 34-16 82-57 62zm231-38c-8-14 11-33 25-25 6 4 11 14 11 22 0 16-26 19-36 3zM870 177c-13-7-29-25-34-40l-10-28 26-25c20-21 32-25 55-20 58 13 70 91 18 114-31 14-25 14-55-1zm145-23c-19-20-16-43 8-58 34-22 73 27 47 59-16 19-35 19-55-1zm242 10c-14-14-7-35 11-32 9 2 17 10 17 17 0 16-18 25-28 15zm-130-71c-4-3-7-12-7-20 0-15 26-18 34-4 7 11-18 33-27 24zM782 58c-15-15 3-48 27-48 24 0 43 23 35 44-7 19-45 21-62 4zm172-3c-4-9-2-21 4-27 16-16 47-5 47 17 0 26-42 34-51 10z" />
    </g>
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
// The legend contract (issue #62, prototype frame `00-legend`). The legend is the
// vocabulary contract: every glyph the app renders must be accounted for here — a
// glyph with no entry is treated as a bug (`icons.legend.test.ts` enforces it, so
// adding a glyph without an entry fails the suite). The vocabulary glyphs map to
// their entry in frame `00-legend`; universal affordances the legend does not
// enumerate (chevron, back, dismiss, add) are marked `structural` so they are
// still accounted for without inventing legend vocabulary. The vocabulary-vs-
// structural split is a judgment call pending the awake designer — adjust the
// groups freely; the coverage (every glyph has an entry) is the invariant.
// ─────────────────────────────────────────────────────────────────────────────

export interface LegendEntry {
  /** The label this glyph carries in frame `00-legend`, or its role if structural. */
  entry: string;
  /** Which legend region it belongs to (or `structural` / `brand`). */
  group: "conversation" | "lens" | "mode" | "actions" | "objects" | "structural" | "brand";
}

export const ICON_LEGEND: Record<string, LegendEntry> = {
  // Conversation cluster · verbs
  CheckIcon: { entry: "Approve", group: "conversation" },
  TriangleIcon: { entry: "Request change", group: "conversation" },
  CommentIcon: { entry: "Comment", group: "conversation" },
  QuestionIcon: { entry: "Question", group: "conversation" },
  // The lenses / views
  FileDiffIcon: { entry: "Code / diff", group: "lens" },
  LayersIcon: { entry: "Canvases", group: "lens" },
  TargetIcon: { entry: "Destination", group: "lens" },
  // Execution mode
  LockIcon: { entry: "Read-only / private", group: "mode" },
  // Actions
  SignIcon: { entry: "Sign", group: "actions" },
  // Objects
  MonitorIcon: { entry: "Workspace", group: "objects" },
  GitBranchIcon: { entry: "Branch / worktree", group: "objects" },
  SparkleIcon: { entry: "Harness / LLM", group: "objects" },
  // Structural affordances (universal, not part of the vocabulary the legend enumerates)
  ChevronIcon: { entry: "Expand / collapse", group: "structural" },
  FolderIcon: { entry: "Choose a repository", group: "structural" },
  ArrowRightIcon: { entry: "Proceed", group: "structural" },
  ArrowLeftIcon: { entry: "Back", group: "structural" },
  CloseIcon: { entry: "Dismiss", group: "structural" },
  PlusIcon: { entry: "Add a project", group: "structural" },
  SlidersIcon: { entry: "Settings", group: "structural" },
  // Brand
  RennetMark: { entry: "Rennet", group: "brand" },
};
