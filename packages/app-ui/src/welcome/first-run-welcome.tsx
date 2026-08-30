import type {
  AppearanceScheme,
  DetectedForge,
  ForgeHostDetection,
  HarnessHostDetection,
  Project,
  SettingsView,
} from "@rennet/protocol";
import { Button, cn } from "@rennet/ui";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Code,
  ExternalLink,
  FolderOpen,
  HardDrive,
  MessageCircleMore,
  Monitor,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Sun,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react";
import { type AnimationSequence, stagger, useAnimate, useReducedMotion } from "motion/react";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useBridge, useCommand, useMutation, useRefreshCommand } from "../data";
import { AddProjectFlow } from "../project/add-project-dialog";
import { newChatPath } from "../routes/url";
import { AgentMark, type AgentToolId } from "../settings/assets/agent-marks";
import { THEME_PACKS, type ThemePackId } from "../settings/assets/theme-packs";
import { type SourceControlToolId, ToolMark } from "../settings/assets/tool-marks";
import { useThemePref } from "../settings/theme-pref";
import { useConnectionCapabilities } from "../shell/connection-capabilities";
import { RennetLockup } from "../shell/sidebar/lockup";

const STEP_LABELS = ["Appearance", "Tools", "Review setup", "Project", "Ready"] as const;

const REVIEW_WORDS = [
  "digestible",
  "reviewable",
  "traceable",
  "explainable",
  "navigable",
  "manageable",
  "readable",
  "coherent",
  "focused",
  "structured",
  "grounded",
  "inspectable",
  "verifiable",
  "defensible",
  "deliberate",
  "rigorous",
  "legible",
  "intelligible",
  "searchable",
  "actionable",
] as const;

/** A syntax tone. Every tone resolves to a `--rn-syn-*`/diff token in `index.css`,
 *  so the code rain recolours with the theme pack the reader is choosing on this
 *  very screen — the prototype's fixed hues could not. */
type CodeTone =
  | "keyword"
  | "function"
  | "type"
  | "string"
  | "literal"
  | "comment"
  | "hunk"
  | "remove"
  | "add";

interface CodeToken {
  readonly tone?: CodeTone;
  readonly text: string;
}

interface CodeFragment {
  /** Absolute placement inside the code field, as authored in the prototype. */
  readonly place: CSSProperties;
  readonly lines: readonly (readonly CodeToken[])[];
}

const CODE_FRAGMENTS: readonly CodeFragment[] = [
  {
    place: { left: "1%", top: "4%" },
    lines: [
      [
        { tone: "keyword", text: "export async function" },
        { tone: "function", text: " listProjectFiles" },
        { text: "(root: string) {" },
      ],
      [
        { tone: "keyword", text: "  const" },
        { text: " entries = " },
        { tone: "keyword", text: "await" },
        { text: " fs.readdir(root, {" },
      ],
      [{ text: "    withFileTypes: " }, { tone: "literal", text: "true" }, { text: "," }],
      [{ text: "  });" }],
      [
        { tone: "keyword", text: "  return" },
        { text: " entries.filter((entry) => entry.isFile());" },
      ],
      [{ text: "}" }],
    ],
  },
  {
    place: { left: "33%", top: "1%" },
    lines: [
      [
        { tone: "function", text: "it" },
        { text: "(" },
        { tone: "string", text: '"keeps the claimed target stable"' },
        { text: ", " },
        { tone: "keyword", text: "async" },
        { text: " () => {" },
      ],
      [
        { tone: "keyword", text: "  const" },
        { text: " session = " },
        { tone: "keyword", text: "await" },
        { text: " createSession(project);" },
      ],
      [
        { tone: "keyword", text: "  await" },
        { text: " git.checkout(" },
        { tone: "string", text: '"feature/review"' },
        { text: ");" },
      ],
      [{ text: "" }],
      [
        { tone: "keyword", text: "  const" },
        { text: " result = " },
        { tone: "keyword", text: "await" },
        { text: " session.refresh();" },
      ],
      [
        { tone: "function", text: "  expect" },
        { text: "(result.target).toEqual(session.target);" },
      ],
      [{ text: "});" }],
    ],
  },
  {
    place: { right: "1%", top: "9%" },
    lines: [
      [
        { tone: "keyword", text: "const" },
        { text: " head = " },
        { tone: "keyword", text: "await" },
        { text: " git.revParse(" },
        { tone: "string", text: '"HEAD"' },
        { text: ");" },
      ],
      [{ tone: "keyword", text: "if" }, { text: " (head !== snapshot.head) {" }],
      [{ text: "  cache.invalidate(project.id);" }],
      [{ text: "}" }],
    ],
  },
  {
    place: { left: "7%", top: "36%" },
    lines: [
      [{ tone: "keyword", text: "type" }, { tone: "type", text: " ReviewState" }, { text: " =" }],
      [{ text: "  | { status: " }, { tone: "string", text: '"idle"' }, { text: " }" }],
      [
        { text: "  | { status: " },
        { tone: "string", text: '"reading"' },
        { text: "; files: number }" },
      ],
      [
        { text: "  | { status: " },
        { tone: "string", text: '"ready"' },
        { text: "; findings: Finding[] };" },
      ],
    ],
  },
  {
    place: { right: "4%", top: "40%" },
    lines: [
      [{ tone: "hunk", text: "@@ -118,7 +118,9 @@" }],
      [{ tone: "remove", text: "- return publish(review)" }],
      [{ tone: "add", text: "+ const draft = await preview(review)" }],
      [{ tone: "add", text: "+ return reviewer.decide(draft)" }],
    ],
  },
  {
    place: { left: "26%", top: "24%" },
    lines: [
      [
        { tone: "keyword", text: "const" },
        { text: " controller = " },
        { tone: "keyword", text: "new" },
        { tone: "type", text: " AbortController" },
        { text: "();" },
      ],
      [{ tone: "keyword", text: "try" }, { text: " {" }],
      [{ tone: "keyword", text: "  await" }, { text: " runner.start({" }],
      [{ text: "    target: session.target," }],
      [{ text: "    signal: controller.signal," }],
      [{ text: "  });" }],
      [{ text: "} " }, { tone: "keyword", text: "finally" }, { text: " {" }],
      [{ text: "  controller.abort();" }],
      [{ text: "}" }],
    ],
  },
  {
    place: { right: "25%", top: "30%" },
    lines: [
      [
        { tone: "keyword", text: "const" },
        { text: " reads = " },
        { tone: "keyword", text: "await" },
        { tone: "type", text: " Promise" },
        { text: ".all([" },
      ],
      [{ text: "  claude.review(evidence)," }],
      [{ text: "  codex.review(evidence)," }],
      [{ text: "]);" }],
      [{ tone: "keyword", text: "return" }, { text: " compare(reads);" }],
    ],
  },
  {
    place: { left: "2%", bottom: "5%" },
    lines: [
      [{ tone: "comment", text: "// Never infer a new target after the session starts." }],
      [{ tone: "keyword", text: "const" }, { text: " claimedTarget = session.target;" }],
      [{ text: "" }],
      [{ tone: "keyword", text: "return" }, { text: " review.run({" }],
      [{ text: "  projectId," }],
      [{ text: "  target: claimedTarget," }],
      [{ text: "});" }],
    ],
  },
  {
    place: { right: "6%", bottom: "9%" },
    lines: [
      [{ tone: "keyword", text: "if" }, { text: " (!validation.ok) {" }],
      [
        { tone: "keyword", text: "  throw new" },
        { tone: "type", text: " InvalidReviewError" },
        { text: "(" },
      ],
      [{ text: "    validation.rejectedItems," }],
      [{ text: "  );" }],
      [{ text: "}" }],
    ],
  },
  {
    place: { left: "39%", bottom: "3%" },
    lines: [
      [{ tone: "keyword", text: "switch" }, { text: " (event.type) {" }],
      [
        { tone: "keyword", text: "  case" },
        { tone: "string", text: '"review.completed"' },
        { text: ":" },
      ],
      [{ tone: "keyword", text: "    return" }, { text: " { ...state, result: event.result };" }],
      [
        { tone: "keyword", text: "  case" },
        { tone: "string", text: '"review.failed"' },
        { text: ":" },
      ],
      [{ tone: "keyword", text: "    return" }, { text: " { ...state, error: event.error };" }],
      [{ text: "}" }],
    ],
  },
];

const CODE_PARTICLES = Array.from({ length: 38 }, (_, index) => ({
  id: `code-particle-${index}`,
  symbol: index % 4 === 0 ? "+" : index % 4 === 1 ? "-" : index % 4 === 2 ? "{" : "@",
  left: `${21 + index * 1.55}%`,
  top: `${31 + (index % 7) * 8}%`,
  tone: index % 5 === 1 ? "remove" : index % 5 === 0 || index % 5 === 2 ? "add" : undefined,
}));

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function StepProgress({ step, onStep }: { step: number; onStep(next: number): void }) {
  return (
    <nav
      className="flex items-center gap-[3px] rounded-full border border-line bg-surface px-1.5 py-1"
      aria-label="Welcome progress"
    >
      {STEP_LABELS.map((label, index) => {
        // Three states, not two: a DONE step reads green-outlined with its tick, an
        // ACTIVE one gold-filled, a future one plain. Collapsing done into "not
        // active" loses the only progress signal a five-step wizard has.
        const state = index === step ? "active" : index < step ? "complete" : "upcoming";
        return (
          <button
            type="button"
            key={label}
            disabled={index > step}
            aria-current={index === step ? "step" : undefined}
            data-state={state}
            className={cn(
              "flex items-center gap-[7px] px-2 py-1.5 text-ink-faint",
              state === "active" && "text-ink",
            )}
            onClick={() => onStep(index)}
          >
            <span
              className={cn(
                "grid size-[22px] place-items-center rounded-full border border-line-strong text-2xs font-bold",
                state === "active" && "border-accent-fill bg-accent-fill text-accent-ink",
                state === "complete" && "border-green text-green",
              )}
            >
              {state === "complete" ? <Check className="size-3" /> : index + 1}
            </span>
            <em className="text-xs not-italic max-md:hidden">{label}</em>
          </button>
        );
      })}
    </nav>
  );
}

function WelcomeShell({
  step,
  onStep,
  children,
}: {
  step: number;
  onStep(next: number): void;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh overflow-hidden bg-canvas text-ink">
      {step > 0 ? (
        <header
          className="flex h-[58px] items-center justify-between border-b border-line bg-canvas px-7"
          data-welcome-header
        >
          <RennetLockup size={24} />
          <span className="flex items-center gap-1.5 text-xs text-ink-faint">
            <ShieldCheck className="size-3.5 text-green" /> Local by default
          </span>
        </header>
      ) : null}
      {/* `key={step}` REMOUNTS the stage, which is what re-runs `step-in` — a CSS
       *  animation on a persistent node fires once and never again. */}
      <main
        key={step}
        className={cn(
          "animate-welcome-step motion-reduce:animate-none",
          step === 0 ? "min-h-dvh" : "min-h-[calc(100dvh-58px)]",
        )}
      >
        {children}
      </main>
      <footer className="fixed bottom-3.5 left-1/2 z-50 -translate-x-1/2">
        <StepProgress step={step} onStep={onStep} />
      </footer>
    </div>
  );
}

function CodeField() {
  return (
    <div
      className="rn-code-field pointer-events-none absolute inset-0 overflow-hidden max-md:opacity-20"
      aria-hidden="true"
    >
      {CODE_FRAGMENTS.map((fragment, index) => (
        <pre
          className="rn-code-fragment"
          data-fragment
          // biome-ignore lint/suspicious/noArrayIndexKey: the fragment catalogue is a fixed literal
          key={index}
          style={fragment.place}
        >
          {fragment.lines.map((line, lineIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed literal, never reordered
            <span key={lineIndex}>
              {line.map((token, tokenIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed literal, never reordered
                <span key={tokenIndex} data-tone={token.tone}>
                  {token.text}
                </span>
              ))}
            </span>
          ))}
        </pre>
      ))}
      {CODE_PARTICLES.map((particle) => (
        <span
          className="rn-code-particle"
          data-particle
          data-tone={particle.tone}
          key={particle.id}
          style={
            {
              left: particle.left,
              top: particle.top,
            } as CSSProperties
          }
        >
          {particle.symbol}
        </span>
      ))}
    </div>
  );
}

/** The reel carries the whole sentence per row, with row 0 repeated at the end so the
 *  wrap from the last word back to the first is a continued scroll, not a jump. */
const REVIEW_WORD_REEL = [...REVIEW_WORDS, REVIEW_WORDS[0]];

/** Hand-built reel keyframes: hold each sentence still, then move one row. `times` is
 *  normalised over the whole cycle, so the pair (hold, move) repeats per word. */
function reelKeyframes(): { positions: string[]; times: number[] } {
  const hold = 1.55;
  const move = 0.35;
  const segment = hold + move;
  const cycle = REVIEW_WORDS.length * segment;
  const positions: string[] = [];
  const times: number[] = [];
  for (let index = 0; index < REVIEW_WORDS.length; index += 1) {
    const current = `${-(index / REVIEW_WORD_REEL.length) * 100}%`;
    const next = `${-((index + 1) / REVIEW_WORD_REEL.length) * 100}%`;
    if (index === 0) {
      positions.push(current);
      times.push(0);
    }
    positions.push(current, next);
    times.push((index * segment + hold) / cycle, ((index + 1) * segment) / cycle);
  }
  return { positions, times };
}

const REEL_CYCLE_SECONDS = REVIEW_WORDS.length * 1.9;
/** Where the reel sits once it has scrolled through every word — the offset the
 *  reduced-motion path jumps straight to, so the sentence still reads complete. */
const REEL_FINAL_OFFSET = `${-((REVIEW_WORD_REEL.length - 1) / REVIEW_WORD_REEL.length) * 100}%`;

// The opening animates by data attribute, not by class, so the utilities on these
// elements stay free to change without silently unhooking a motion sequence.
const OPENING_TAGLINE = "[data-opening-tagline]";
const INTRO_ARROW = "[data-intro-arrow]";
const REVIEW_TAGLINE = "[data-review-tagline]";
const SENTENCE_REEL = "[data-sentence-reel]";
const LOGO_MARK = "[data-logo-mark]";
const LOGO_WORDMARK = "[data-logo-wordmark]";
const APPEARANCE_PANEL = "[data-appearance-panel]";

/** The run-of-the-wizard treatments, written once because five stages share them. */
const EYEBROW = "m-0 mb-[7px] text-2xs font-bold tracking-[0.12em] text-accent uppercase";
const INLINE_ERROR =
  "mt-3 mb-0 rounded-control border border-danger bg-danger-soft px-3 py-2.5 text-xs text-ink";
const CONTENT_STAGE =
  "mx-auto w-[min(900px,calc(100vw-48px))] pt-[clamp(54px,8vh,94px)] pb-[120px] max-md:pt-10";
const STAGE_H1 =
  "m-0 mb-3 font-display text-display leading-[1.05] font-medium tracking-[-0.035em]";
const STAGE_P = "m-0 max-w-[610px] leading-[1.65] text-ink-soft";
const PLAIN_NOTE =
  "mt-[18px] flex items-center gap-2.5 text-xs text-ink-faint [&>svg]:size-[18px] [&>svg]:shrink-0 [&>svg]:text-green";

type Cubic = [number, number, number, number];
const EASE_OUT: Cubic = [0.16, 1, 0.3, 1];
const EASE_IN: Cubic = [0.4, 0, 1, 1];
const EASE_GATHER: Cubic = [0.76, 0, 0.24, 1];

function ThemePreview({ id }: { id: ThemePackId }) {
  const scheme = id === "affineur" || id === "github" ? "light" : "dark";
  return (
    // `rn-theme-preview` stays a class: the 8px faux-diff inside it is decorative
    // micro-type below the ramp floor, pinned by selector in design-ramp.test.ts.
    <span
      className="rn-theme-preview block h-[104px] rounded-control border border-line bg-canvas p-[11px] text-left text-ink [@media(max-height:760px)]:h-[78px]"
      data-rn-theme={id === "affineur" ? undefined : id}
      data-scheme={scheme}
      aria-hidden="true"
    >
      <i className="flex gap-1">
        <b className="size-[5px] rounded-full bg-current opacity-30" />
        <b className="size-[5px] rounded-full bg-current opacity-30" />
        <b className="size-[5px] rounded-full bg-current opacity-30" />
      </i>
      <code>
        <span className="text-del-ink">−</span> const answer = draft
        <br />
        <strong className="text-add-ink">+</strong> const answer = evidence
      </code>
    </span>
  );
}

function AppearanceStage({ settings, onContinue }: { settings: SettingsView; onContinue(): void }) {
  const [scope, animate] = useAnimate();
  const reduceMotion = useReducedMotion();
  const [started, setStarted] = useState(false);
  const { themePack, setThemePack } = useThemePref();
  const { mutate: setAppearance } = useMutation("settings.setAppearance", {
    invalidates: ["settings.get"],
  });
  const [appearanceError, setAppearanceError] = useState<string>();

  useEffect(() => {
    const root = scope.current;
    if (!root) return;
    const fragments = [...root.querySelectorAll("[data-fragment]")];
    const particles = [...root.querySelectorAll("[data-particle]")];

    // Reduced motion gets its own DESIGNED opening, not the full one at 0.01s: the
    // same states in the same order, arriving in 0.18s with no drift, no gather and
    // no looping reel — which is jumped straight to its final offset so the sentence
    // still reads complete rather than mid-scroll.
    if (!started) {
      if (reduceMotion) {
        const controls = animate([
          [OPENING_TAGLINE, { opacity: 1, y: 0 }, { duration: 0.18 }],
          [INTRO_ARROW, { opacity: 1, scale: 1 }, { at: 0.1, duration: 0.18 }],
        ]);
        return () => controls.stop();
      }

      const ambient = [
        animate(OPENING_TAGLINE, { opacity: 1, y: 0 }, { duration: 0.8, ease: EASE_OUT }),
        animate(
          INTRO_ARROW,
          { opacity: 1, scale: 1 },
          { delay: 0.48, duration: 0.5, ease: EASE_OUT },
        ),
        ...fragments.map((node, index) => {
          const directionX = index % 2 === 0 ? 1 : -1;
          const directionY = index % 3 === 0 ? -1 : 1;
          const travelX = root.clientWidth * (0.2 + (index % 4) * 0.055);
          const travelY = root.clientHeight * (0.12 + (index % 5) * 0.035);
          return animate(
            node,
            {
              x: [
                0,
                directionX * travelX,
                -directionX * travelX * 0.72,
                directionX * travelX * 0.38,
                0,
              ],
              y: [
                0,
                directionY * travelY * 0.55,
                -directionY * travelY,
                directionY * travelY * 0.7,
                0,
              ],
              rotate: [0, directionX * 7, -directionX * 5, directionX * 3, 0],
              opacity: [0.48, 0.82, 0.58, 0.76, 0.48],
            },
            { duration: 17 + index * 1.15, repeat: Infinity, ease: "linear" },
          );
        }),
        // Particles breathe on their own before the click, so the field is alive
        // rather than a still image waiting to be gathered.
        ...particles.map((node, index) =>
          animate(
            node,
            {
              x: [0, ((index % 5) - 2) * 8, 0],
              y: [0, ((index % 7) - 3) * 6, 0],
              opacity: [0.42, 0.9, 0.42],
            },
            { duration: 5.5 + (index % 8) * 0.44, repeat: Infinity, ease: "easeInOut" },
          ),
        ),
      ];
      return () => {
        for (const control of ambient) control.stop();
      };
    }

    if (reduceMotion) {
      const controls = animate([
        [INTRO_ARROW, { opacity: 0, scale: 0.9 }, { duration: 0.08 }],
        [OPENING_TAGLINE, { opacity: 0 }, { at: 0, duration: 0.08 }],
        ["[data-fragment], [data-particle]", { opacity: 0 }, { duration: 0.08 }],
        [LOGO_MARK, { opacity: 1, scale: 1, filter: "blur(0px)" }, { at: 0, duration: 0.18 }],
        [
          LOGO_WORDMARK,
          { opacity: 1, x: 0, clipPath: "inset(0 0% 0 0)" },
          { at: 0, duration: 0.18 },
        ],
        [REVIEW_TAGLINE, { opacity: 1, y: 0 }, { at: 0.08, duration: 0.18 }],
        [`${REVIEW_TAGLINE} > span`, { opacity: 1, y: 0 }, { at: 0.08, duration: 0.18 }],
        [SENTENCE_REEL, { y: REEL_FINAL_OFFSET }, { at: 0.08, duration: 0 }],
        [
          APPEARANCE_PANEL,
          { visibility: "visible", opacity: 1, y: 0, scale: 1, filter: "blur(0px)" },
          { at: 0.32, duration: 0.18 },
        ],
      ]);
      return () => controls.stop();
    }

    // The gather target is measured from the MARK, not from a viewport fraction: the
    // code converges on the logo that is assembling, wherever the responsive hero put
    // it, instead of on a guessed point that drifts with the window.
    const rootBounds = root.getBoundingClientRect();
    const mark = root.querySelector(LOGO_MARK);
    const markBounds = mark?.getBoundingClientRect();
    const targetX = markBounds
      ? markBounds.left - rootBounds.left + markBounds.width * 0.63
      : root.clientWidth / 2;
    const targetY = markBounds
      ? markBounds.top - rootBounds.top + markBounds.height * 0.5
      : Math.max(120, root.clientHeight * 0.2);

    const gather: AnimationSequence = fragments.map((node, index) => {
      const bounds = node.getBoundingClientRect();
      return [
        node,
        {
          x: targetX - (bounds.left - rootBounds.left + bounds.width / 2),
          y: targetY - (bounds.top - rootBounds.top + bounds.height / 2),
          opacity: [0.66, 0.8, 0],
          scale: [1, 0.72, 0.16],
          filter: ["blur(0px)", "blur(0px)", "blur(2px)"],
        },
        { at: 0.08 + index * 0.035, duration: 1.42, ease: EASE_GATHER },
      ];
    });
    const gatherParticles: AnimationSequence = particles.map((node, index) => {
      const bounds = node.getBoundingClientRect();
      const orbitX = ((index % 7) - 3) * 5;
      const orbitY = ((index % 5) - 2) * 4;
      return [
        node,
        {
          x: targetX - (bounds.left - rootBounds.left + bounds.width / 2) + orbitX,
          y: targetY - (bounds.top - rootBounds.top + bounds.height / 2) + orbitY,
          opacity: [0.7, 1, 0],
          scale: [1, 0.82, 0.1],
          rotate: index % 2 === 0 ? 80 : -80,
        },
        { at: 0.12 + (index % 11) * 0.025, duration: 1.28, ease: EASE_GATHER },
      ];
    });

    const controls = animate([
      [INTRO_ARROW, { opacity: 0, scale: 0.74, rotate: -8 }, { duration: 0.25, ease: EASE_IN }],
      [
        OPENING_TAGLINE,
        { opacity: 0, y: -8, filter: "blur(4px)" },
        { at: 0, duration: 0.42, ease: EASE_IN },
      ],
      ...gather,
      ...gatherParticles,
      [
        LOGO_MARK,
        { opacity: 1, scale: 1, filter: "blur(0px)" },
        { at: 0.78, duration: 0.72, ease: EASE_OUT },
      ],
      [
        LOGO_WORDMARK,
        { opacity: 1, x: 0, clipPath: "inset(0 0% 0 0)" },
        { at: 0.94, duration: 0.86, ease: EASE_OUT },
      ],
      [
        `${REVIEW_TAGLINE} > span`,
        { opacity: 1, y: 0 },
        { at: 1.38, duration: 0.5, delay: stagger(0.08), ease: EASE_OUT },
      ],
      [REVIEW_TAGLINE, { opacity: 1, y: 0 }, { at: 1.38, duration: 0.5, ease: EASE_OUT }],
      [
        APPEARANCE_PANEL,
        { visibility: "visible", opacity: 1, y: 0, scale: 1, filter: "blur(0px)" },
        { at: 2.76, duration: 0.68, ease: EASE_OUT },
      ],
    ]);

    const reel = reelKeyframes();
    const wordShuffle = animate(
      SENTENCE_REEL,
      { y: reel.positions },
      {
        delay: 1.68,
        duration: REEL_CYCLE_SECONDS,
        times: reel.times,
        repeat: Infinity,
        ease: "linear",
      },
    );

    return () => {
      controls.stop();
      wordShuffle.stop();
    };
  }, [animate, reduceMotion, scope, started]);

  async function chooseScheme(scheme: AppearanceScheme): Promise<void> {
    setAppearanceError(undefined);
    try {
      await setAppearance({ scheme });
    } catch (reason) {
      setAppearanceError(errorText(reason));
    }
  }

  async function chooseTheme(id: ThemePackId): Promise<void> {
    setAppearanceError(undefined);
    try {
      await setThemePack(id);
    } catch (reason) {
      setAppearanceError(errorText(reason));
    }
  }

  return (
    <section
      className="relative min-h-dvh overflow-hidden px-[4vw] pt-[clamp(48px,6vh,82px)] pb-[118px] [@media(max-height:760px)]:pt-5"
      ref={scope}
    >
      <CodeField />
      <div className="relative z-[2] grid min-h-[292px] content-start justify-items-center text-center">
        {/* Mark and wordmark are two windows onto one drawing, so the mark can land
         *  from a blurred scale while the wordmark wipes in behind it. */}
        <div
          className="mt-[clamp(42px,7vh,72px)] flex w-[clamp(360px,44vw,640px)] items-center justify-center gap-[clamp(12px,1.5vw,22px)] [@media(max-height:760px)]:mt-5"
          role="img"
          aria-label="Rennet"
        >
          <span
            className="w-[28%] shrink-0 [&>svg]:h-auto [&>svg]:w-full"
            data-logo-mark
            style={{ opacity: 0, transform: "scale(0.92)", filter: "blur(2px)" }}
          >
            <RennetLockup size={100} part="mark" />
          </span>
          <span
            className="w-[68%] shrink-0 [&>svg]:h-auto [&>svg]:w-full"
            data-logo-wordmark
            style={{
              opacity: 0,
              transform: "translateX(-14px)",
              clipPath: "inset(0 100% 0 0)",
            }}
          >
            <RennetLockup size={100} part="wordmark" />
          </span>
        </div>
        <div className="relative mt-5 grid min-h-[70px] w-[min(860px,90vw)] place-items-center">
          <p
            className="absolute inset-0 m-0 grid place-items-center text-lg leading-[1.35] tracking-[-0.015em] text-ink-soft"
            data-opening-tagline
            style={{ opacity: 0, transform: "translateY(10px)" }}
          >
            You stopped writing the code. You still have to answer for it.
          </p>
          {/* One reel row per sentence, scrolled under a one-line window: the whole
           *  line moves, so the words never reflow around a changing tail. */}
          <p
            className="absolute inset-y-0 left-[calc(50%-50vw)] grid w-screen place-items-center whitespace-nowrap text-lg leading-[1.35] tracking-[-0.015em] text-ink max-md:whitespace-normal"
            data-review-tagline
            style={{ opacity: 0, transform: "translateY(10px)" }}
          >
            <span
              className="relative h-[1.35em] w-full overflow-hidden"
              role="img"
              aria-label={`Rennet makes code review ${REVIEW_WORDS[0]}`}
              style={{ opacity: 0, transform: "translateY(8px)" }}
            >
              <span
                className="absolute inset-0 grid"
                data-sentence-reel
                style={{
                  height: `${REVIEW_WORD_REEL.length * 100}%`,
                  gridTemplateRows: `repeat(${REVIEW_WORD_REEL.length}, minmax(0, 1fr))`,
                }}
              >
                {REVIEW_WORD_REEL.map((word, index) => (
                  <strong
                    className="flex w-full items-center justify-center whitespace-nowrap font-semibold max-md:whitespace-normal"
                    // biome-ignore lint/suspicious/noArrayIndexKey: row 0 repeats at the end for the seamless wrap, so the word alone is not unique
                    key={`${word}-${index}`}
                  >
                    Rennet makes code review {word}
                  </strong>
                ))}
              </span>
            </span>
          </p>
        </div>
        <button
          className="mt-2.5 grid size-[46px] place-items-center rounded-full border border-accent-fill bg-accent-fill text-accent-ink hover:translate-x-0.5 hover:brightness-95 [&_svg]:size-5"
          data-intro-arrow
          type="button"
          onClick={() => setStarted(true)}
          disabled={started}
          aria-label="Continue to Rennet"
          style={{ opacity: 0, transform: "scale(0.86)" }}
        >
          <ArrowRight />
        </button>
      </div>

      <div
        // `invisible` (not an inline visibility) keeps the panel out of the tab order
        // until the opening ends; the sequence sets `visibility: visible` inline, which
        // beats the class.
        className="invisible relative z-[3] mx-auto mt-[clamp(20px,3vh,34px)] w-[min(1160px,92vw)] rounded-window border border-line bg-surface p-[30px]"
        data-appearance-panel
        style={{
          opacity: 0,
          transform: "translateY(60px) scale(0.98)",
          filter: "blur(3px)",
        }}
      >
        <div className="flex items-center justify-between gap-6 max-md:flex-col max-md:items-stretch">
          <div>
            <p className={EYEBROW}>Make it yours</p>
            <h2 className="m-0 text-lg font-semibold">Choose your appearance</h2>
          </div>
          <div
            className="grid grid-cols-3 overflow-hidden rounded-control border border-line"
            role="radiogroup"
            aria-label="Color scheme"
          >
            {(
              [
                ["system", "System", Monitor],
                ["light", "Light", Sun],
                ["dark", "Dark", Moon],
              ] as const
            ).map(([id, label, SchemeIcon]) => (
              <button
                key={id}
                type="button"
                className={cn(
                  "flex h-10 min-w-[110px] items-center justify-center gap-[7px] border-r border-line text-ink-soft last:border-r-0 max-md:min-w-0 [&_svg]:size-[17px]",
                  settings.scheme === id &&
                    "bg-raised text-ink shadow-[inset_0_-2px_var(--rn-accent-fill)]",
                )}
                onClick={() => void chooseScheme(id)}
              >
                <SchemeIcon />
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-6 mb-7 grid grid-cols-5 gap-[18px] max-md:grid-cols-2 max-md:gap-2.5">
          {THEME_PACKS.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={cn(
                "relative rounded-surface border border-transparent p-2 pb-2.5 hover:bg-raised",
                themePack === theme.id && "border-accent-line bg-accent-soft",
              )}
              onClick={() => void chooseTheme(theme.id)}
            >
              <ThemePreview id={theme.id} />
              <span className="mt-2.5 block text-xs font-semibold text-ink">{theme.label}</span>
              {themePack === theme.id ? (
                <i className="absolute top-0.5 right-0.5 grid size-[23px] place-items-center rounded-full bg-accent-fill text-accent-ink [&_svg]:size-[13px]">
                  <Check />
                </i>
              ) : null}
            </button>
          ))}
        </div>
        {appearanceError ? (
          <p className={INLINE_ERROR} role="alert">
            Couldn’t save that appearance: {appearanceError}
          </p>
        ) : null}
        <div className="flex justify-center border-t border-line pt-[18px]">
          <Button onClick={onContinue}>
            Continue <ArrowRight />
          </Button>
        </div>
      </div>
    </section>
  );
}

function StepActions({
  onBack,
  onContinue,
  busy,
  disabled,
}: {
  onBack(): void;
  onContinue?(): void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="mt-[30px] flex items-center justify-between border-t border-line pt-[22px]">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft />
        Back
      </Button>
      {onContinue ? (
        <Button disabled={busy || disabled} onClick={onContinue}>
          {busy ? "Saving…" : "Continue"}
          <ArrowRight />
        </Button>
      ) : null}
    </div>
  );
}

function StatusPill({ good, children }: { good: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] rounded-full px-[9px] py-1.5 text-2xs font-bold whitespace-nowrap [&_svg]:size-[13px]",
        good ? "bg-green-soft text-green" : "bg-raised text-ink-faint",
      )}
    >
      {good ? <CheckCircle2 /> : <TriangleAlert />}
      {children}
    </span>
  );
}

const TOOL_MARK =
  "grid size-11 place-items-center rounded-control border border-line bg-raised [&_svg]:size-6";

function ToolRow({
  id,
  name,
  version,
  detail,
  status,
  good,
  index,
}: {
  id: SourceControlToolId | AgentToolId;
  name: string;
  version?: string;
  detail: string;
  status: string;
  good: boolean;
  /** Position in the list; the rows deal themselves in 70ms apart. */
  index: number;
}) {
  const harness = id === "claude" || id === "codex";
  return (
    <article
      className="grid min-h-[84px] animate-welcome-row grid-cols-[48px_1fr_auto] items-center gap-4 rounded-surface border border-line bg-surface px-[18px] py-[15px] motion-reduce:animate-none max-md:grid-cols-[44px_1fr]"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      <span className={TOOL_MARK}>{harness ? <AgentMark id={id} /> : <ToolMark id={id} />}</span>
      <div>
        <h3 className="m-0 text-sm font-semibold">
          {name}
          {version ? (
            <code className="ml-2.5 text-2xs font-normal text-ink-faint">{version}</code>
          ) : null}
        </h3>
        <p className="mt-[5px] text-xs text-ink-faint">{detail}</p>
      </div>
      <div className="max-md:col-start-2">
        <StatusPill good={good}>{status}</StatusPill>
      </div>
    </article>
  );
}

function forgeDisplayStatus(forge: DetectedForge) {
  return forge.authProbe ?? forge.status;
}

function forgeStatusLabel(status: ReturnType<typeof forgeDisplayStatus>): string {
  switch (status) {
    case "available":
      return "Available";
    case "not-authenticated":
      return "Not authenticated";
    case "unreachable":
      return "Unreachable";
    case "not-installed":
      return "Not installed";
  }
}

function ToolsStage({
  harnesses,
  forges,
  onBack,
  onContinue,
}: {
  harnesses?: HarnessHostDetection;
  forges?: ForgeHostDetection;
  onBack(): void;
  onContinue(): void;
}) {
  const gh = forges?.asked ? forges.detected.find((tool) => tool.id === "github") : undefined;
  const glab = forges?.asked ? forges.detected.find((tool) => tool.id === "gitlab") : undefined;
  return (
    <section className={CONTENT_STAGE}>
      <div className="mb-9 max-w-[650px]">
        <p className={EYEBROW}>This environment</p>
        <h1 className={STAGE_H1}>Your tools, already connected.</h1>
        <p className={STAGE_P}>
          Rennet uses the command-line tools installed here. No new accounts and no duplicate
          credentials.
        </p>
      </div>
      <div className="grid gap-2.5">
        <ToolRow
          index={0}
          id="git"
          name="Git"
          status="Required"
          good
          detail="Rennet uses Git for local branches, diffs, and repository history."
        />
        {gh ? (
          <ToolRow
            index={1}
            id="gh"
            name="GitHub CLI"
            version={gh.version ?? undefined}
            status={forgeStatusLabel(forgeDisplayStatus(gh))}
            good={forgeDisplayStatus(gh) === "available"}
            detail={gh.detail}
          />
        ) : (
          <ToolRow
            index={1}
            id="gh"
            name="GitHub CLI"
            status={forges?.asked ? "Not detected" : "Not checked"}
            good={false}
            detail="Rennet could not prove a GitHub CLI installation in this environment."
          />
        )}
        {glab ? (
          <ToolRow
            index={2}
            id="glab"
            name="GitLab CLI"
            version={glab.version ?? undefined}
            status={forgeStatusLabel(forgeDisplayStatus(glab))}
            good={forgeDisplayStatus(glab) === "available"}
            detail={glab.detail}
          />
        ) : (
          <ToolRow
            index={2}
            id="glab"
            name="GitLab CLI"
            status={forges?.asked ? "Not detected" : "Not checked"}
            good={false}
            detail="Rennet could not read GitLab CLI state in this environment."
          />
        )}
        <ToolRow
          index={3}
          id="bitbucket"
          name="Bitbucket"
          status="Not supported yet"
          good={false}
          detail="Bitbucket integration is not part of this launch."
        />
        {harnesses?.asked
          ? harnesses.detected
              .filter((tool) => tool.id === "claude" || tool.id === "codex")
              .map((tool, position) => (
                <ToolRow
                  key={tool.id}
                  index={4 + position}
                  id={tool.id as AgentToolId}
                  name={tool.id === "claude" ? "Claude Code" : "Codex"}
                  version={tool.version ?? undefined}
                  status="Available"
                  good
                  detail="Existing install · existing account"
                />
              ))
          : null}
      </div>
      <aside className={PLAIN_NOTE}>
        <HardDrive />
        Detection runs separately for every local, remote, and WSL environment you add.
      </aside>
      <StepActions onBack={onBack} onContinue={onContinue} />
    </section>
  );
}

function ReviewSetupStage({
  harnesses,
  settings,
  onRefresh,
  onBack,
  onContinue,
}: {
  harnesses?: HarnessHostDetection;
  settings: SettingsView;
  onRefresh(): void;
  onBack(): void;
  onContinue(choice: ReviewChoice): void;
}) {
  const available = useMemo(
    () =>
      harnesses?.asked
        ? harnesses.detected.filter((tool) => tool.id === "claude" || tool.id === "codex")
        : [],
    [harnesses],
  );
  const ids = useMemo(() => available.map((tool) => tool.id as AgentToolId), [available]);
  const [orchestrator, setOrchestrator] = useState<AgentToolId>(
    ids.includes("claude") ? "claude" : "codex",
  );
  const [dual, setDual] = useState(ids.length > 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { activeSource } = useConnectionCapabilities();
  const enableHarness = useMutation("harness.setEnabled", { invalidates: ["harness.hosts"] });
  const setRole = useMutation("settings.setRoleAssignment", { invalidates: ["settings.get"] });

  useEffect(() => {
    if (!ids.includes(orchestrator) && ids[0]) setOrchestrator(ids[0]);
    if (ids.length < 2) setDual(false);
  }, [ids, orchestrator]);

  async function save(): Promise<void> {
    // No harness on this machine is a fact to disclose, not a wall. There is nothing to
    // enable and no orchestrator to assign, so carry the empty choice forward rather than
    // inventing one — the Ready step and Settings both say plainly what is missing.
    if (!ids.length) {
      onContinue({ dual: false });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await Promise.all(
        ids.map((id) =>
          enableHarness.mutate({
            source: activeSource,
            harnessId: id,
            enabled: dual || id === orchestrator,
          }),
        ),
      );
      const row = settings.reviewRoles?.find((role) => role.id === "orchestrator");
      const assignment = row?.[orchestrator === "claude" ? "claudeOnly" : "codexOnly"].value;
      if (assignment)
        await setRole.mutate({ roleId: "orchestrator", scenario: "dual", assignment });
      onContinue({ orchestrator, dual });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={CONTENT_STAGE}>
      <div className="mb-9 max-w-[650px]">
        <p className={EYEBROW}>Review setup</p>
        <h1 className={STAGE_H1}>Choose how Rennet reviews.</h1>
        <p className={STAGE_P}>
          Your Claude Code. Your Codex. Rennet uses the harnesses already installed and signed in
          here.
        </p>
      </div>
      {ids.length === 0 ? (
        <div className="grid min-h-[370px] place-items-center content-center rounded-window border border-danger bg-surface p-12 text-center">
          <span className="grid size-[70px] place-items-center rounded-window bg-danger-soft text-danger [&_svg]:size-9">
            <TerminalSquare />
          </span>
          <h2 className="mx-auto mt-[22px] mb-2 max-w-[550px] font-display text-2xl font-medium">
            Rennet couldn’t detect Claude Code or Codex.
          </h2>
          <p className="mx-auto max-w-[540px] leading-[1.6] text-ink-soft">
            Rennet can’t run review turns until one is installed. Install a harness, sign in with
            its CLI, then check again — or continue now and set it up later in Settings →
            Environments. Rennet uses your existing account.
          </p>
          <div className="mt-6 flex items-center gap-2.5">
            <a
              className="inline-flex min-h-9 items-center gap-2 rounded-control border border-line-strong px-3.5 font-semibold no-underline [&_svg]:size-[15px]"
              href="https://docs.rennet.dev/using/guides/install-a-coding-harness/"
              target="_blank"
              rel="noreferrer"
            >
              Installation guide <ExternalLink />
            </a>
            <Button onClick={onRefresh}>
              <RefreshCw />
              Check again
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div
            className="grid grid-cols-2 gap-3.5 max-md:grid-cols-1"
            role="radiogroup"
            aria-label="Orchestrator harness"
          >
            {available.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className={cn(
                  "relative grid min-h-[118px] grid-cols-[50px_1fr_auto] items-center gap-3.5 rounded-surface border border-line bg-surface p-5 text-left",
                  orchestrator === tool.id && "border-accent-line bg-accent-soft",
                )}
                onClick={() => setOrchestrator(tool.id as AgentToolId)}
              >
                <span className={TOOL_MARK}>
                  <AgentMark id={tool.id as AgentToolId} />
                </span>
                <span className="grid gap-[5px]">
                  <strong>{tool.id === "claude" ? "Claude Code" : "Codex"}</strong>
                  <small className="text-2xs text-ink-faint">
                    Existing install · existing account
                  </small>
                </span>
                <StatusPill good>Detected</StatusPill>
                {orchestrator === tool.id ? (
                  <i className="absolute top-2 right-2 grid size-5 place-items-center rounded-full bg-accent-fill text-accent-ink [&_svg]:size-3">
                    <Check />
                  </i>
                ) : null}
              </button>
            ))}
          </div>
          <aside className="my-3.5 flex items-center gap-3 border-l-[3px] border-accent-fill bg-surface px-4 py-[13px] [&>svg]:text-accent">
            <ShieldCheck />
            <div className="grid gap-0.5">
              <strong className="text-xs">
                {orchestrator === "claude" ? "Claude Code" : "Codex"} will orchestrate reviews.
              </strong>
              <span className="text-2xs text-ink-faint">
                You can change this per environment later in Settings.
              </span>
            </div>
          </aside>
          <button
            type="button"
            disabled={ids.length < 2}
            className={cn(
              "grid min-h-[126px] w-full grid-cols-[126px_1fr_auto] items-center gap-5 rounded-surface border border-line bg-surface px-[22px] py-5 text-left max-md:grid-cols-[84px_1fr_auto]",
              dual && "border-accent-line",
            )}
            onClick={() => setDual((value) => !value)}
          >
            <span className="flex items-center justify-center gap-2.5 [&_svg]:size-[34px]">
              <AgentMark id="claude" />
              <span className="text-xl text-accent" aria-hidden="true">
                +
              </span>
              <AgentMark id="codex" />
            </span>
            <span className="grid gap-[7px]">
              <strong className="font-display text-xl font-medium">Dual Harness</strong>
              <small className="leading-[1.55] text-ink-soft">
                Two independent reads. Rennet shows where they agree and where they split.
                Disagreement tells you where to look.
              </small>
            </span>
            <i
              className={cn(
                "h-6 w-[42px] rounded-full p-[3px]",
                dual ? "bg-accent-fill" : "bg-line-strong",
              )}
            >
              <b
                className={cn(
                  "block size-[18px] rounded-full bg-surface transition-transform",
                  dual && "translate-x-[18px]",
                )}
              />
            </i>
          </button>
          {error ? (
            <p className={INLINE_ERROR} role="alert">
              Couldn’t save review setup: {error}
            </p>
          ) : null}
        </>
      )}
      <StepActions onBack={onBack} onContinue={() => void save()} busy={busy} />
    </section>
  );
}

function ProjectStage({ onBack, onAdded }: { onBack(): void; onAdded(project: Project): void }) {
  const bridge = useBridge();
  const [accessError, setAccessError] = useState<string>();
  async function openAccess(): Promise<void> {
    setAccessError(undefined);
    try {
      const opened = await bridge.openFullDiskAccessSettings?.();
      if (!opened) setAccessError("Open System Settings → Privacy & Security → Full Disk Access.");
    } catch (reason) {
      setAccessError(errorText(reason));
    }
  }
  return (
    <section className={CONTENT_STAGE}>
      <div className="mb-9 max-w-[650px]">
        <p className={EYEBROW}>First project</p>
        <h1 className={STAGE_H1}>Add the code you’re responsible for.</h1>
        <p className={STAGE_P}>
          Choose a repository or a workspace. Rennet scouts its structure and opens it in New Chat.
        </p>
      </div>
      {bridge.platform === "darwin" && bridge.openFullDiskAccessSettings ? (
        <aside className="mb-[18px] grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-control bg-raised px-4 py-3.5 max-md:grid-cols-[auto_1fr] [&>svg]:text-green">
          <ShieldCheck />
          <div className="grid gap-0.5">
            <strong>Need access outside the folders you choose?</strong>
            <span className="text-xs text-ink-faint">
              Full Disk Access is optional. Rennet only reads projects you add.
            </span>
          </div>
          <Button
            className="max-md:col-start-2 max-md:justify-self-start"
            variant="outline"
            onClick={() => void openAccess()}
          >
            Grant Full Disk Access <ExternalLink />
          </Button>
        </aside>
      ) : null}
      {accessError ? (
        <p className={INLINE_ERROR} role="status">
          {accessError}
        </p>
      ) : null}
      <div className="rounded-window border border-line bg-surface p-6 [&_[role=dialog]]:shadow-none">
        <AddProjectFlow onAdded={onAdded} showAddEnvironment={false} embedded />
      </div>
      {/* No `onContinue`, so no Continue button — deliberately, and NOT the bug that review
       *  setup had. The shape is identical, which is exactly why this note exists: someone
       *  will find it, recognise the gate one step back, and "fix" it the same way.
       *
       *  What made review setup a GATE: it refused the reviewer over a fact about their
       *  machine they could only change OUTSIDE Rennet — install a harness, sign in with its
       *  CLI, come back. Nothing on that screen could satisfy it, so an empty machine was
       *  held at the door forever.
       *
       *  What makes this a FORM: it asks the reviewer to do the one thing the step is for,
       *  and the picker that does it is right here, satisfiable in place, with no harness
       *  condition of its own (`AddProjectFlow`'s `disabled={!selectedPath || busy}` is just
       *  an empty form declining to submit nothing). Adding a project is the step.
       *
       *  So: if a step withholds progress over something the user cannot resolve on that
       *  screen, that is a gate and Rule Zero kills it. If it withholds progress until they
       *  perform the step's own action, that is a form. Do not collapse the two. */}
      <StepActions onBack={onBack} />
    </section>
  );
}

interface ReviewChoice {
  /** Absent when no harness is installed here. Rennet says so; it does not invent one. */
  readonly orchestrator?: AgentToolId;
  readonly dual: boolean;
}

function ReadyStage({
  project,
  reviewChoice,
  onBack,
}: {
  project: Project;
  reviewChoice: ReviewChoice;
  onBack(): void;
}) {
  const [, navigate] = useLocation();
  const complete = useMutation("settings.completeWelcome", { invalidates: ["settings.get"] });
  const remember = useMutation("settings.setLastProject", { invalidates: ["settings.get"] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const orchestratorLabel = reviewChoice.orchestrator
    ? reviewChoice.orchestrator === "codex"
      ? "Codex"
      : "Claude Code"
    : "None installed";
  const modeLabel = !reviewChoice.orchestrator
    ? "No harness yet"
    : reviewChoice.dual
      ? "Dual Harness"
      : "Single Harness";
  async function start(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await remember.mutate({ source: project.source, projectId: project.id });
      await complete.mutate({});
      navigate(newChatPath(project.id), { replace: true });
    } catch (reason) {
      setError(errorText(reason));
      setBusy(false);
    }
  }
  return (
    <section className="mx-auto flex min-h-[calc(100dvh-58px)] w-[min(780px,calc(100vw-48px))] flex-col items-center pt-[clamp(70px,10vh,120px)] pb-[120px] text-center">
      <span className="relative mb-[22px] grid h-20 w-[280px] place-items-center">
        <RennetLockup size={46} />
        <i className="absolute right-0 -bottom-1 grid size-[31px] place-items-center rounded-full border-4 border-canvas bg-green text-surface [&_svg]:size-3.5">
          <Check />
        </i>
      </span>
      <p className={EYEBROW}>Ready</p>
      <h1 className={STAGE_H1}>Make the next change digestible.</h1>
      <p className={cn(STAGE_P, "max-w-[620px]")}>
        Rennet is set up for <strong>{project.name}</strong>. Your review starts with the source and
        keeps every conclusion attached to the code.
      </p>
      {/* Each row is icon + label + value: the glyph is what makes three cells read as
       *  three different KINDS of fact rather than one undifferentiated strip. */}
      <div className="my-8 grid w-full grid-cols-3 rounded-surface border border-line bg-surface max-md:grid-cols-1">
        {(
          [
            [FolderOpen, "Project", project.name],
            [Sparkles, "Orchestrator", orchestratorLabel],
            [Code, "Mode", modeLabel],
          ] as const
        ).map(([RowIcon, label, value], index) => (
          <span
            key={label}
            className={cn(
              "flex items-center justify-center gap-3 p-[18px]",
              index < 2 && "border-r border-line max-md:border-r-0 max-md:border-b",
            )}
          >
            <RowIcon className="size-[22px] shrink-0 text-accent" />
            <span className="grid gap-1 text-left">
              <small className="text-2xs tracking-[0.08em] text-ink-faint uppercase">{label}</small>
              <strong>{value}</strong>
            </span>
          </span>
        ))}
      </div>
      {reviewChoice.orchestrator ? null : (
        <aside className={cn(PLAIN_NOTE, "[&>svg]:text-ink-faint")}>
          <TerminalSquare />
          No coding harness is installed here, so Rennet can’t run review turns yet. Install Claude
          Code or Codex, then enable it in Settings → Environments.
        </aside>
      )}
      {error ? (
        <p className={INLINE_ERROR} role="alert">
          Setup wasn’t completed: {error}
        </p>
      ) : null}
      <Button className="mt-4" size="lg" disabled={busy} onClick={() => void start()}>
        <MessageCircleMore />
        {busy ? "Opening…" : "Start a new chat"}
        <ArrowRight />
      </Button>
      <Button className="mt-2.5" variant="ghost" onClick={onBack}>
        <ArrowLeft />
        Back
      </Button>
    </section>
  );
}

export function FirstRunWelcome({ settings }: { settings: SettingsView }) {
  const { activeSource } = useConnectionCapabilities();
  const [step, setStep] = useState(0);
  const [project, setProject] = useState<Project>();
  const [reviewChoice, setReviewChoice] = useState<ReviewChoice>({
    orchestrator: "claude",
    dual: true,
  });
  const harnessQuery = useCommand("harness.hosts", {});
  const forgeQuery = useCommand("forge.hosts", {});
  const refreshHarnesses = useRefreshCommand("harness.hosts");
  const refreshForges = useRefreshCommand("forge.hosts");
  const harnesses =
    harnessQuery.data?.hosts.find((host) => host.source === activeSource) ??
    (harnessQuery.error
      ? { source: activeSource, asked: false as const, detected: [] }
      : undefined);
  const forges =
    forgeQuery.data?.hosts.find((host) => host.source === activeSource) ??
    (forgeQuery.error ? { source: activeSource, asked: false as const, detected: [] } : undefined);

  const page = useMemo(() => {
    switch (step) {
      case 0:
        return <AppearanceStage settings={settings} onContinue={() => setStep(1)} />;
      case 1:
        return (
          <ToolsStage
            harnesses={harnesses}
            forges={forges}
            onBack={() => setStep(0)}
            onContinue={() => setStep(2)}
          />
        );
      case 2:
        return (
          <ReviewSetupStage
            harnesses={harnesses}
            settings={settings}
            onRefresh={() => {
              refreshHarnesses();
              refreshForges();
            }}
            onBack={() => setStep(1)}
            onContinue={(choice) => {
              setReviewChoice(choice);
              setStep(3);
            }}
          />
        );
      case 3:
        return (
          <ProjectStage
            onBack={() => setStep(2)}
            onAdded={(added) => {
              setProject(added);
              setStep(4);
            }}
          />
        );
      case 4:
        return project ? (
          <ReadyStage project={project} reviewChoice={reviewChoice} onBack={() => setStep(3)} />
        ) : (
          <ProjectStage
            onBack={() => setStep(2)}
            onAdded={(added) => {
              setProject(added);
              setStep(4);
            }}
          />
        );
      default:
        return null;
    }
  }, [forges, harnesses, project, refreshForges, refreshHarnesses, reviewChoice, settings, step]);

  return (
    <WelcomeShell step={step} onStep={setStep}>
      {page}
    </WelcomeShell>
  );
}
