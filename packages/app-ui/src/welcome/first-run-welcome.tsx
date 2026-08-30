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
  ExternalLink,
  HardDrive,
  Monitor,
  Moon,
  RefreshCw,
  ShieldCheck,
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

const CODE_FRAGMENTS = [
  [
    "export async function listProjectFiles(root: string) {",
    "  const entries = await fs.readdir(root);",
    "  return entries.filter(isReviewable);",
    "}",
  ],
  [
    'it("keeps the claimed target stable", async () => {',
    "  const session = await createSession(project);",
    "  expect(await session.refresh()).toMatchObject({ target });",
    "});",
  ],
  [
    'const head = await git.revParse("HEAD");',
    "if (head !== snapshot.head) {",
    "  cache.invalidate(project.id);",
    "}",
  ],
  [
    "type ReviewState =",
    '  | { status: "idle" }',
    '  | { status: "reading"; files: number }',
    '  | { status: "ready"; findings: Finding[] };',
  ],
  [
    "@@ -118,7 +118,9 @@",
    "- return publish(review)",
    "+ const draft = await preview(review)",
    "+ return reviewer.decide(draft)",
  ],
  [
    "const controller = new AbortController();",
    "try {",
    "  await runner.start({ target, signal: controller.signal });",
    "} finally { controller.abort(); }",
  ],
  [
    "const reads = await Promise.all([",
    "  claude.review(evidence),",
    "  codex.review(evidence),",
    "]);",
    "return compare(reads);",
  ],
  [
    "// Never infer a new target after the session starts.",
    "const claimedTarget = session.target;",
    "return review.run({ projectId, target: claimedTarget });",
  ],
  ["if (!validation.ok) {", "  throw new InvalidReviewError(validation.rejectedItems);", "}"],
  [
    "switch (event.type) {",
    '  case "review.completed":',
    "    return { ...state, result: event.result };",
    "}",
  ],
] as const;

const CODE_PARTICLES = Array.from({ length: 34 }, (_, index) => ({
  id: `code-particle-${index}`,
  symbol: index % 4 === 0 ? "+" : index % 4 === 1 ? "-" : index % 4 === 2 ? "{" : "@",
  left: `${21 + index * 1.55}%`,
  top: `${31 + (index % 7) * 8}%`,
}));

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function StepProgress({ step, onStep }: { step: number; onStep(next: number): void }) {
  return (
    <nav className="rn-welcome-progress" aria-label="Welcome progress">
      {STEP_LABELS.map((label, index) => (
        <button
          type="button"
          key={label}
          disabled={index > step}
          aria-current={index === step ? "step" : undefined}
          className={cn("rn-welcome-progress-item", index === step && "is-active")}
          onClick={() => onStep(index)}
        >
          <span>{index < step ? <Check className="size-3" /> : index + 1}</span>
          <em>{label}</em>
        </button>
      ))}
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
    <div className={cn("rn-welcome-shell", step === 0 && "is-first-step")}>
      {step > 0 ? (
        <header className="rn-welcome-header">
          <RennetLockup size={24} />
          <span>
            <ShieldCheck className="size-3.5 text-green" /> Local by default
          </span>
        </header>
      ) : null}
      <main className="rn-welcome-main">{children}</main>
      <footer className="rn-welcome-footer">
        <StepProgress step={step} onStep={onStep} />
      </footer>
    </div>
  );
}

function CodeField() {
  return (
    <div className="rn-code-field" aria-hidden="true">
      {CODE_FRAGMENTS.map((lines, index) => (
        <pre className={`rn-code-fragment fragment-${index}`} data-fragment key={lines[0]}>
          {lines.map((line) => (
            <span key={line}>{line || " "}</span>
          ))}
        </pre>
      ))}
      {CODE_PARTICLES.map((particle) => (
        <span
          className="rn-code-particle"
          data-particle
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

function ThemePreview({ id }: { id: ThemePackId }) {
  const scheme = id === "affineur" || id === "github" ? "light" : "dark";
  return (
    <span
      className="rn-theme-preview bg-canvas text-ink"
      data-rn-theme={id === "affineur" ? undefined : id}
      data-scheme={scheme}
      aria-hidden="true"
    >
      <i>
        <b />
        <b />
        <b />
      </i>
      <code>
        <span>−</span> const answer = draft
        <br />
        <strong>+</strong> const answer = evidence
      </code>
    </span>
  );
}

function AppearanceStage({ settings, onContinue }: { settings: SettingsView; onContinue(): void }) {
  const [scope, animate] = useAnimate();
  const reduceMotion = useReducedMotion();
  const [started, setStarted] = useState(false);
  const [wordIndex, setWordIndex] = useState(0);
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

    if (!started) {
      const controls = [
        animate(
          ".rn-opening-tagline",
          { opacity: 1, y: 0 },
          { duration: reduceMotion ? 0.01 : 0.7 },
        ),
        animate(
          ".rn-intro-arrow",
          { opacity: 1, scale: 1 },
          { delay: reduceMotion ? 0 : 0.45, duration: reduceMotion ? 0.01 : 0.45 },
        ),
      ];
      if (!reduceMotion) {
        fragments.forEach((node, index) => {
          const x = root.clientWidth * (0.22 + (index % 4) * 0.05) * (index % 2 ? -1 : 1);
          const y = root.clientHeight * (0.12 + (index % 5) * 0.035) * (index % 3 ? 1 : -1);
          controls.push(
            animate(
              node,
              {
                x: [0, x, -x * 0.72, x * 0.38, 0],
                y: [0, y * 0.55, -y, y * 0.7, 0],
                rotate: [0, 7, -5, 3, 0],
                opacity: [0.42, 0.82, 0.56, 0.74, 0.42],
              },
              { duration: 17 + index, repeat: Infinity, ease: "linear" },
            ),
          );
        });
      }
      return () => {
        controls.forEach((control) => {
          control.stop();
        });
      };
    }

    if (reduceMotion) {
      const controls = animate([
        [
          ".rn-opening-tagline, .rn-intro-arrow, [data-fragment], [data-particle]",
          { opacity: 0 },
          { duration: 0.01 },
        ],
        [
          ".rn-assembled-logo, .rn-review-tagline",
          { opacity: 1, y: 0, scale: 1 },
          { at: 0, duration: 0.01 },
        ],
        [
          ".rn-appearance-card",
          { visibility: "visible", opacity: 1, y: 0 },
          { at: 0, duration: 0.01 },
        ],
      ]);
      return () => controls.stop();
    }

    const targetX = root.clientWidth / 2;
    const targetY = Math.max(120, root.clientHeight * 0.2);
    const gather: AnimationSequence = [];
    [...fragments, ...particles].forEach((node, index) => {
      const bounds = node.getBoundingClientRect();
      const rootBounds = root.getBoundingClientRect();
      gather.push([
        node,
        {
          x: targetX - (bounds.left - rootBounds.left + bounds.width / 2),
          y: targetY - (bounds.top - rootBounds.top + bounds.height / 2),
          opacity: [0.75, 0.9, 0],
          scale: [1, 0.7, 0.08],
          rotate: index % 2 ? -50 : 50,
        },
        { at: 0.08 + (index % 12) * 0.025, duration: 1.35, ease: [0.76, 0, 0.24, 1] },
      ]);
    });
    const sequence: AnimationSequence = [
      [".rn-intro-arrow", { opacity: 0, scale: 0.75 }, { duration: 0.2 }],
      [
        ".rn-opening-tagline",
        { opacity: 0, y: -8, filter: "blur(4px)" },
        { at: 0, duration: 0.35 },
      ],
      ...gather,
      [
        ".rn-assembled-logo",
        { opacity: 1, scale: 1, filter: "blur(0px)" },
        { at: 0.8, duration: 0.7, ease: [0.16, 1, 0.3, 1] },
      ],
      [
        ".rn-review-tagline > span",
        { opacity: 1, y: 0 },
        { at: 1.38, duration: 0.45, delay: stagger(0.06) },
      ],
      [".rn-review-tagline", { opacity: 1, y: 0 }, { at: 1.38, duration: 0.45 }],
      [
        ".rn-appearance-card",
        { visibility: "visible", opacity: 1, y: 0, scale: 1, filter: "blur(0px)" },
        { at: 2.55, duration: 0.65, ease: [0.16, 1, 0.3, 1] },
      ],
    ];
    const controls = animate(sequence);
    return () => controls.stop();
  }, [animate, reduceMotion, scope, started]);

  useEffect(() => {
    if (!started || reduceMotion) return;
    let index = 0;
    const timer = window.setInterval(() => setWordIndex(++index % REVIEW_WORDS.length), 1900);
    return () => window.clearInterval(timer);
  }, [started, reduceMotion]);

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
    <section className="rn-appearance-stage" ref={scope}>
      <CodeField />
      <div className="rn-welcome-hero">
        <div className="rn-assembled-logo">
          <RennetLockup size={100} />
        </div>
        <div className="rn-message-stage">
          <p className="rn-opening-tagline">
            You stopped writing the code. You still have to answer for it.
          </p>
          <p className="rn-review-tagline" aria-live="polite">
            <span>Rennet makes code review</span>{" "}
            <span className="rn-review-word" key={REVIEW_WORDS[wordIndex]}>
              {REVIEW_WORDS[wordIndex]}
            </span>
          </p>
        </div>
        <button
          className="rn-intro-arrow"
          type="button"
          onClick={() => setStarted(true)}
          disabled={started}
          aria-label="Continue to Rennet"
        >
          <ArrowRight />
        </button>
      </div>

      <div className="rn-appearance-card">
        <div className="rn-card-heading">
          <div>
            <p className="rn-eyebrow">Make it yours</p>
            <h2>Choose your appearance</h2>
          </div>
          <div className="rn-scheme-control" role="radiogroup" aria-label="Color scheme">
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
                className={settings.scheme === id ? "is-selected" : ""}
                onClick={() => void chooseScheme(id)}
              >
                <SchemeIcon />
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="rn-theme-grid">
          {THEME_PACKS.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={cn("rn-theme-card", themePack === theme.id && "is-selected")}
              onClick={() => void chooseTheme(theme.id)}
            >
              <ThemePreview id={theme.id} />
              <span>{theme.label}</span>
              {themePack === theme.id ? (
                <i>
                  <Check />
                </i>
              ) : null}
            </button>
          ))}
        </div>
        {appearanceError ? (
          <p className="rn-inline-error" role="alert">
            Couldn’t save that appearance: {appearanceError}
          </p>
        ) : null}
        <div className="rn-card-footer">
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
  continueLabel = "Continue",
  busy,
  disabled,
}: {
  onBack(): void;
  onContinue?(): void;
  continueLabel?: string;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="rn-step-actions">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft />
        Back
      </Button>
      {onContinue ? (
        <Button disabled={busy || disabled} onClick={onContinue}>
          {busy ? "Saving…" : continueLabel}
          <ArrowRight />
        </Button>
      ) : null}
    </div>
  );
}

function StatusPill({ good, children }: { good: boolean; children: ReactNode }) {
  return (
    <span className={cn("rn-status-pill", good ? "is-good" : "is-muted")}>
      {good ? <CheckCircle2 /> : <TriangleAlert />}
      {children}
    </span>
  );
}

function ToolRow({
  id,
  name,
  version,
  detail,
  status,
  good,
}: {
  id: SourceControlToolId | AgentToolId;
  name: string;
  version?: string;
  detail: string;
  status: string;
  good: boolean;
}) {
  const harness = id === "claude" || id === "codex";
  return (
    <article className="rn-tool-row">
      <span className="rn-tool-mark">{harness ? <AgentMark id={id} /> : <ToolMark id={id} />}</span>
      <div>
        <h3>
          {name}
          {version ? <code>{version}</code> : null}
        </h3>
        <p>{detail}</p>
      </div>
      <StatusPill good={good}>{status}</StatusPill>
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
    <section className="rn-content-stage">
      <div className="rn-stage-copy">
        <p className="rn-eyebrow">This environment</p>
        <h1>Your tools, already connected.</h1>
        <p>
          Rennet uses the command-line tools installed here. No new accounts and no duplicate
          credentials.
        </p>
      </div>
      <div className="rn-tool-list">
        <ToolRow
          id="git"
          name="Git"
          status="Required"
          good
          detail="Rennet uses Git for local branches, diffs, and repository history."
        />
        {gh ? (
          <ToolRow
            id="gh"
            name="GitHub CLI"
            version={gh.version ?? undefined}
            status={forgeStatusLabel(forgeDisplayStatus(gh))}
            good={forgeDisplayStatus(gh) === "available"}
            detail={gh.detail}
          />
        ) : (
          <ToolRow
            id="gh"
            name="GitHub CLI"
            status={forges?.asked ? "Not detected" : "Not checked"}
            good={false}
            detail="Rennet could not prove a GitHub CLI installation in this environment."
          />
        )}
        {glab ? (
          <ToolRow
            id="glab"
            name="GitLab CLI"
            version={glab.version ?? undefined}
            status={forgeStatusLabel(forgeDisplayStatus(glab))}
            good={forgeDisplayStatus(glab) === "available"}
            detail={glab.detail}
          />
        ) : (
          <ToolRow
            id="glab"
            name="GitLab CLI"
            status={forges?.asked ? "Not detected" : "Not checked"}
            good={false}
            detail="Rennet could not read GitLab CLI state in this environment."
          />
        )}
        <ToolRow
          id="bitbucket"
          name="Bitbucket"
          status="Not supported yet"
          good={false}
          detail="Bitbucket integration is not part of this launch."
        />
        {harnesses?.asked
          ? harnesses.detected
              .filter((tool) => tool.id === "claude" || tool.id === "codex")
              .map((tool) => (
                <ToolRow
                  key={tool.id}
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
      <aside className="rn-plain-note">
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
    <section className="rn-content-stage">
      <div className="rn-stage-copy">
        <p className="rn-eyebrow">Review setup</p>
        <h1>Choose how Rennet reviews.</h1>
        <p>
          Your Claude Code. Your Codex. Rennet uses the harnesses already installed and signed in
          here.
        </p>
      </div>
      {ids.length === 0 ? (
        <div className="rn-harness-error">
          <span>
            <TerminalSquare />
          </span>
          <h2>Rennet couldn’t detect Claude Code or Codex.</h2>
          <p>
            Rennet can’t run review turns until one is installed. Install a harness, sign in with
            its CLI, then check again — or continue now and set it up later in Settings →
            Environments. Rennet uses your existing account.
          </p>
          <div>
            <a
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
          <div className="rn-harness-grid" role="radiogroup" aria-label="Orchestrator harness">
            {available.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className={cn("rn-harness-card", orchestrator === tool.id && "is-selected")}
                onClick={() => setOrchestrator(tool.id as AgentToolId)}
              >
                <span className="rn-tool-mark">
                  <AgentMark id={tool.id as AgentToolId} />
                </span>
                <span>
                  <strong>{tool.id === "claude" ? "Claude Code" : "Codex"}</strong>
                  <small>Existing install · existing account</small>
                </span>
                <StatusPill good>Detected</StatusPill>
                {orchestrator === tool.id ? (
                  <i>
                    <Check />
                  </i>
                ) : null}
              </button>
            ))}
          </div>
          <aside className="rn-orchestrator-note">
            <ShieldCheck />
            <div>
              <strong>
                {orchestrator === "claude" ? "Claude Code" : "Codex"} will orchestrate reviews.
              </strong>
              <span>You can change this per environment later in Settings.</span>
            </div>
          </aside>
          <button
            type="button"
            disabled={ids.length < 2}
            className={cn("rn-dual-card", dual && "is-selected")}
            onClick={() => setDual((value) => !value)}
          >
            <span className="rn-dual-marks">
              <AgentMark id="claude" />
              <span className="rn-dual-plus" aria-hidden="true">
                +
              </span>
              <AgentMark id="codex" />
            </span>
            <span>
              <strong>Dual Harness</strong>
              <small>
                Two independent reads. Rennet shows where they agree and where they split.
                Disagreement tells you where to look.
              </small>
            </span>
            <i className={dual ? "is-on" : ""}>
              <b />
            </i>
          </button>
          {error ? (
            <p className="rn-inline-error" role="alert">
              Couldn’t save review setup: {error}
            </p>
          ) : null}
        </>
      )}
      <StepActions onBack={onBack} onContinue={() => void save()} busy={busy} />
    </section>
  );
}

function ProjectStage({
  onBack,
  onAdded,
  existing,
}: {
  onBack(): void;
  onAdded(project: Project): void;
  /** A project this client ALREADY has (a replay, not a fresh install). Undefined on the
   *  zero-project first run, which is the path this step was originally written for. */
  existing?: Project;
}) {
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
    <section className="rn-content-stage rn-project-stage">
      <div className="rn-stage-copy">
        <p className="rn-eyebrow">First project</p>
        <h1>{existing ? "Pick up where you left off." : "Add the code you’re responsible for."}</h1>
        <p>
          {existing
            ? "Continue with a project you already have, or add another. Rennet scouts a new one’s structure and opens it in New Chat."
            : "Choose a repository or a workspace. Rennet scouts its structure and opens it in New Chat."}
        </p>
      </div>
      {bridge.platform === "darwin" && bridge.openFullDiskAccessSettings ? (
        <aside className="rn-access-note">
          <ShieldCheck />
          <div>
            <strong>Need access outside the folders you choose?</strong>
            <span>Full Disk Access is optional. Rennet only reads projects you add.</span>
          </div>
          <Button variant="outline" onClick={() => void openAccess()}>
            Grant Full Disk Access <ExternalLink />
          </Button>
        </aside>
      ) : null}
      {accessError ? (
        <p className="rn-inline-error" role="status">
          {accessError}
        </p>
      ) : null}
      <div className="rn-add-project-flow">
        <AddProjectFlow onAdded={onAdded} showAddEnvironment={false} embedded />
      </div>
      {/* With NO existing project there is no `onContinue`, so no Continue button —
       *  deliberately, and NOT the bug that review setup had. The shape is identical, which
       *  is exactly why this note exists: someone will find it, recognise the gate one step
       *  back, and "fix" it the same way.
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
       *  perform the step's own action, that is a form. Do not collapse the two.
       *
       *  `existing` is the REPLAY path, and there the same form would be a trap: the wizard's
       *  only exit ran through `projects.add`, so replaying on a real machine meant adding a
       *  DUPLICATE row (and re-indexing it) to get back to the shell — with no way out, since
       *  the replay stamp survives a relaunch. Continuing with a project the client already
       *  has is the step performed, not skipped. */}
      <StepActions
        onBack={onBack}
        onContinue={existing ? () => onAdded(existing) : undefined}
        continueLabel={existing ? `Continue with ${existing.name}` : undefined}
      />
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
    <section className="rn-ready-stage">
      <span className="rn-ready-mark">
        <RennetLockup size={46} />
        <i>
          <Check />
        </i>
      </span>
      <p className="rn-eyebrow">Ready</p>
      <h1>Make the next change digestible.</h1>
      <p>
        Rennet is set up for <strong>{project.name}</strong>. Your review starts with the source and
        keeps every conclusion attached to the code.
      </p>
      <div className="rn-ready-summary">
        <span>
          <small>Project</small>
          <strong>{project.name}</strong>
        </span>
        <span>
          <small>Orchestrator</small>
          <strong>{orchestratorLabel}</strong>
        </span>
        <span>
          <small>Mode</small>
          <strong>{modeLabel}</strong>
        </span>
      </div>
      {reviewChoice.orchestrator ? null : (
        <aside className="rn-plain-note">
          <TerminalSquare />
          No coding harness is installed here, so Rennet can’t run review turns yet. Install Claude
          Code or Codex, then enable it in Settings → Environments.
        </aside>
      )}
      {error ? (
        <p className="rn-inline-error" role="alert">
          Setup wasn’t completed: {error}
        </p>
      ) : null}
      <Button size="lg" disabled={busy} onClick={() => void start()}>
        {busy ? "Opening…" : "Start a new chat"}
        <ArrowRight />
      </Button>
      <Button variant="ghost" onClick={onBack}>
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
  const projectsQuery = useCommand("projects.list", {});

  // On a REPLAY the client already has projects, and the wizard's only exit used to run
  // through `projects.add` — so getting back to the shell meant adding a duplicate row and
  // paying for a redundant re-index, on a stamp that survives a relaunch. Seeding the
  // wizard's project with one it already has makes Ready reachable without adding anything.
  // Preference order matches the shell's own (`NewChatScreen`): the last-used project for
  // the active source, else the first listed. On a genuine first run the list is empty and
  // nothing is seeded — the Project step is exactly the form it always was.
  const listed = projectsQuery.data?.projects;
  const rememberedId = settings.navigation?.lastProjectBySource?.[activeSource];
  useEffect(() => {
    if (!listed?.length) return;
    setProject(
      (current) =>
        current ?? listed.find((candidate) => candidate.id === rememberedId) ?? listed[0],
    );
  }, [listed, rememberedId]);
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
            existing={project}
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
          // No project yet, so Ready has nothing to summarise — fall back to the step that
          // produces one. `existing` is deliberately omitted: `project` is undefined here.
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
