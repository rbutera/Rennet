import type {
  AppearanceScheme,
  DetectedForge,
  ForgeHostDetection,
  HarnessHostDetection,
  SettingsView,
} from "@rennet/protocol";
import { Button, cn, Toggle } from "@rennet/ui";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Code,
  ExternalLink,
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
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Icon } from "../components/icon";
import { LiquidSphere } from "../components/liquid-sphere";
import { useBridge, useCommand, useMutation, useRefreshCommand } from "../data";
import { newChatPath } from "../routes/url";
import { AgentMark, type AgentToolId } from "../settings/assets/agent-marks";
import { THEME_PACKS, type ThemePackId } from "../settings/assets/theme-packs";
import { type SourceControlToolId, ToolMark } from "../settings/assets/tool-marks";
import { useThemePref } from "../settings/theme-pref";
import { useConnectionCapabilities } from "../shell/connection-capabilities";
import { useMacTrafficLights } from "../shell/corner-slot";
import { WelcomeConstellation } from "./welcome-constellation";
import "./welcome.css";
import { RennetLockup } from "../shell/sidebar/lockup";

const STEP_LABELS = ["Appearance", "Tools", "Review setup", "Access", "Ready"] as const;

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function StepProgress({ step, onStep }: { step: number; onStep(next: number): void }) {
  return (
    <nav className="welcome-progress" aria-label="Welcome progress">
      {STEP_LABELS.map((label, index) => {
        // Three states, not two: a DONE step reads green-outlined with its tick, an
        // ACTIVE one gold-filled, a future one plain. Collapsing done into "not
        // active" loses the only progress signal a five-step wizard has.
        const state = index === step ? "active" : index < step ? "complete" : "upcoming";
        return (
          <button
            type="button"
            key={label}
            aria-label={label}
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
              {state === "complete" ? <Icon icon={Check} className="size-3" /> : index + 1}
            </span>
            <em className="text-xs not-italic max-md:hidden">{label}</em>
          </button>
        );
      })}
    </nav>
  );
}

const REVIEW_SUBJECTS = [
  "code review",
  "AI-generated diffs",
  "HITL",
  "pull requests",
  "spec-driven development",
  "understanding code",
  "code ownership",
  "large changes",
  "refactoring",
  "review conversations",
  "agentic engineering",
  "finding regressions",
  "reading unfamiliar code",
  "technical decisions",
  "test coverage",
  "review handoffs",
  "shipping changes",
  "working with agents",
];
const REVIEW_QUALITIES = [
  "easy to digest",
  "manageable",
  "transparent",
  "better",
  "easier",
  "fun",
  "efficient",
  "clearer",
  "less overwhelming",
  "more focused",
  "more approachable",
  "more deliberate",
];

function WelcomeRefrain({ paused }: { paused: boolean }) {
  const [subject, setSubject] = useState(0);
  const [quality, setQuality] = useState(0);
  useEffect(() => {
    if (paused) return;
    const subjects = setInterval(
      () => setSubject((value) => (value + 1) % REVIEW_SUBJECTS.length),
      3100,
    );
    const qualities = setInterval(
      () => setQuality((value) => (value + 1) % REVIEW_QUALITIES.length),
      4300,
    );
    return () => {
      clearInterval(subjects);
      clearInterval(qualities);
    };
  }, [paused]);
  return (
    <p className="welcome-refrain">
      <span className="sr-only">Rennet makes code review easy to digest.</span>
      <span aria-hidden="true">Rennet makes</span>{" "}
      <span key={`subject-${subject}`} className="welcome-refrain-subject" aria-hidden="true">
        {REVIEW_SUBJECTS[subject]}
      </span>{" "}
      <span key={`quality-${quality}`} className="welcome-refrain-quality" aria-hidden="true">
        {REVIEW_QUALITIES[quality]}.
      </span>
    </p>
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
  const mac = useMacTrafficLights();
  const [started, setStarted] = useState(false);
  const [motionPaused, setMotionPaused] = useState(true);
  const intro = step === 0 && !started;
  return (
    <div
      className="welcome-shell"
      data-welcome-step={step}
      data-welcome-intro={intro}
      data-mac-traffic-lights={mac}
    >
      <WelcomeConstellation step={step} intro={intro} onPauseChange={setMotionPaused} />
      <header className="welcome-header">
        <span className="flex items-center gap-1.5" role="img" aria-label="Rennet">
          <LiquidSphere size={32} state="resting" className="shrink-0" />
          <RennetLockup part="wordmark" size={16} className="w-auto" />
        </span>
        {!intro && <StepProgress step={step} onStep={onStep} />}
      </header>
      <div className="welcome-layout">
        <aside className="welcome-scene">
          {!intro &&
            (step === 0 ? (
              <div className="welcome-arrival">
                <h1>
                  Welcome to your new <em>Review Harness.</em>
                </h1>
                <WelcomeRefrain paused={motionPaused} />
              </div>
            ) : (
              <div className="welcome-scene-caption">
                <p>
                  {
                    [
                      "",
                      "The tools you already trust.",
                      "Independent reads. Your judgement.",
                      "Start with the source.",
                      "You’re ready for the next change.",
                    ][step]
                  }
                </p>
                <span>No Rennet backend. Your agents connect to their providers.</span>
              </div>
            ))}
        </aside>
        <main key={step} className="welcome-main animate-welcome-step motion-reduce:animate-none">
          {intro ? (
            <section className="welcome-opening">
              <h1>
                You stopped writing the code. <br />
                You still have to answer for it.
              </h1>
              <Button onClick={() => setStarted(true)}>
                Start <Icon icon={ArrowRight} />
              </Button>
            </section>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  );
}

const INLINE_ERROR =
  "mt-3 mb-0 rounded-control border border-danger bg-danger-soft px-3 py-2.5 text-xs text-ink";
const CONTENT_STAGE = "welcome-panel";
const STAGE_H1 = "welcome-heading";
const STAGE_P = "m-0 max-w-[610px] leading-[1.65] text-ink-soft";
const PLAIN_NOTE =
  "mt-[18px] flex items-center gap-2.5 text-xs text-ink-faint [&>svg]:size-[18px] [&>svg]:shrink-0 [&>svg]:text-green";

function ThemePreview({ id }: { id: ThemePackId }) {
  return (
    <>
      {(["light", "dark"] as const).map((scheme) => (
        <span
          key={scheme}
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
      ))}
    </>
  );
}

function AppearanceStage({ settings, onContinue }: { settings: SettingsView; onContinue(): void }) {
  const { themePack, setThemePack } = useThemePref();
  const { mutate: setAppearance } = useMutation("settings.setAppearance", {
    invalidates: ["settings.get"],
  });
  const [appearanceError, setAppearanceError] = useState<string>();

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
    <section className={CONTENT_STAGE}>
      <div data-appearance-panel>
        <div className="flex items-center justify-between gap-6 max-md:flex-col max-md:items-stretch">
          <div>
            <h2 className="m-0 text-lg font-semibold">Choose your appearance</h2>
          </div>
          <fieldset
            className="grid grid-cols-3 overflow-hidden rounded-control border border-line"
            aria-label="Color scheme"
          >
            {(
              [
                ["system", "System", Monitor],
                ["light", "Light", Sun],
                ["dark", "Dark", Moon],
              ] as const
            ).map(([id, label, SchemeIcon]) => (
              <Toggle
                key={id}
                type="button"
                className={cn(
                  "flex h-10 min-w-[110px] items-center justify-center gap-[7px] border-r border-line text-ink-soft last:border-r-0 max-md:min-w-0 [&_svg]:size-[17px]",
                  settings.scheme === id &&
                    "bg-raised text-ink shadow-[inset_0_-2px_var(--rn-accent-fill)]",
                )}
                pressed={settings.scheme === id}
                onClick={() => void chooseScheme(id)}
              >
                <Icon icon={SchemeIcon} />
                {label}
              </Toggle>
            ))}
          </fieldset>
        </div>
        <div className="mt-6 mb-7 grid grid-cols-5 gap-[18px] max-md:grid-cols-2 max-md:gap-2.5">
          {THEME_PACKS.map((theme) => (
            <Toggle
              key={theme.id}
              type="button"
              className={cn(
                "relative h-auto min-w-0 flex-col whitespace-normal rounded-surface border border-transparent p-2 pb-2.5 hover:bg-raised",
                themePack === theme.id && "border-accent-line bg-accent-soft",
              )}
              pressed={themePack === theme.id}
              onClick={() => void chooseTheme(theme.id)}
            >
              <ThemePreview id={theme.id} />
              <span className="mt-2.5 block text-xs font-semibold text-ink">{theme.label}</span>
              {themePack === theme.id ? (
                <i className="absolute top-0.5 right-0.5 grid size-[23px] place-items-center rounded-full bg-accent-fill text-accent-ink [&_svg]:size-[13px]">
                  <Icon icon={Check} />
                </i>
              ) : null}
            </Toggle>
          ))}
        </div>
        {appearanceError ? (
          <p className={INLINE_ERROR} role="alert">
            Couldn’t save that appearance: {appearanceError}
          </p>
        ) : null}
        <div className="flex justify-center border-t border-line pt-[18px]">
          <Button onClick={onContinue}>
            Continue <Icon icon={ArrowRight} />
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
    <div className="welcome-actions mt-[30px] flex items-center justify-between border-t border-line pt-[22px]">
      <Button variant="ghost" onClick={onBack}>
        <Icon icon={ArrowLeft} />
        Back
      </Button>
      {onContinue ? (
        <Button disabled={busy || disabled} onClick={onContinue}>
          {busy ? "Saving…" : continueLabel}
          <Icon icon={ArrowRight} />
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
      {good ? <Icon icon={CheckCircle2} /> : <Icon icon={TriangleAlert} />}
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
        <h1 className={STAGE_H1}>Your tools, already connected.</h1>
        <p className={STAGE_P}>
          Rennet uses the command-line tools installed here. No new accounts and no duplicate
          credentials.
        </p>
      </div>
      <div className="welcome-tools grid gap-2.5">
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
        <Icon icon={HardDrive} />
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
        <h1 className={STAGE_H1}>Choose how Rennet reviews.</h1>
        <p className={STAGE_P}>
          Your Claude Code. Your Codex. Rennet uses the harnesses already installed and signed in
          here.
        </p>
      </div>
      {ids.length === 0 ? (
        <div className="welcome-missing-harness grid min-h-[370px] place-items-center content-center rounded-window border border-danger bg-surface p-12 text-center">
          <span className="grid size-[70px] place-items-center rounded-window bg-danger-soft text-danger [&_svg]:size-9">
            <Icon icon={TerminalSquare} />
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
              Installation guide <Icon icon={ExternalLink} />
            </a>
            <Button onClick={onRefresh}>
              <Icon icon={RefreshCw} />
              Check again
            </Button>
          </div>
        </div>
      ) : (
        <>
          <fieldset
            className="grid grid-cols-2 gap-3.5 max-md:grid-cols-1"
            aria-label="Orchestrator harness"
          >
            {available.map((tool) => (
              <Toggle
                key={tool.id}
                type="button"
                className={cn(
                  "relative grid h-auto whitespace-normal min-h-[118px] grid-cols-[50px_1fr_auto] items-center gap-3.5 rounded-surface border border-line bg-surface p-5 text-left",
                  orchestrator === tool.id && "border-accent-line bg-accent-soft",
                )}
                pressed={orchestrator === tool.id}
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
                    <Icon icon={Check} />
                  </i>
                ) : null}
              </Toggle>
            ))}
          </fieldset>
          <aside className="my-3.5 flex items-center gap-3 rounded-control bg-accent-soft px-4 py-[13px] [&>svg]:text-accent">
            <Icon icon={ShieldCheck} />
            <div className="grid gap-0.5">
              {/* What the choice ACTUALLY does (session-thread-briefing 4.4): it enables the
                  harness and routes the council's `orchestrator-chat` job, which is the
                  review's own conversation — the thread in the chat column. It does not move
                  the lens seats, which route from the council's tables, so "orchestrate
                  reviews" was more than the write can deliver. */}
              <strong className="text-xs">
                {orchestrator === "claude" ? "Claude Code" : "Codex"} will run the review
                conversation.
              </strong>
              <span className="text-2xs text-ink-faint">
                The thread in the chat column. Lens seats route on their own — change either in
                Settings → Environments.
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
            aria-pressed={dual}
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

function AccessStage({ onBack, onContinue }: { onBack(): void; onContinue(): void }) {
  const bridge = useBridge();
  const [accessError, setAccessError] = useState<string>();
  async function openAccess() {
    setAccessError(undefined);
    try {
      if (!(await bridge.openFullDiskAccessSettings?.())) {
        setAccessError("Open System Settings → Privacy & Security → Full Disk Access.");
      }
    } catch (reason) {
      setAccessError(errorText(reason));
    }
  }
  return (
    <section className={CONTENT_STAGE}>
      <h1 className={STAGE_H1}>
        {bridge.platform === "darwin"
          ? "Your code, wherever it lives."
          : "Bring your code when you’re ready."}
      </h1>
      {bridge.platform === "darwin" ? (
        <>
          <p className={STAGE_P}>
            Full Disk Access is optional. Without it, macOS may prevent Rennet from reading projects
            on external drives, network volumes, or protected folders.
          </p>
          <p className="my-5 text-sm text-ink-soft">
            Enable Rennet in System Settings → Privacy &amp; Security → Full Disk Access. You can do
            this later.
          </p>
          <Button variant="outline" onClick={() => void openAccess()}>
            Grant Full Disk Access <Icon icon={ExternalLink} />
          </Button>
        </>
      ) : (
        <p className={STAGE_P}>
          Choose a project when you start a new chat. There’s no need to add one during setup.
        </p>
      )}
      {accessError && (
        <p className={INLINE_ERROR} role="status">
          {accessError}
        </p>
      )}
      <StepActions onBack={onBack} onContinue={onContinue} />
    </section>
  );
}

interface ReviewChoice {
  /** Absent when no harness is installed here. Rennet says so; it does not invent one. */
  readonly orchestrator?: AgentToolId;
  readonly dual: boolean;
}

function ReadyStage({ reviewChoice, onBack }: { reviewChoice: ReviewChoice; onBack(): void }) {
  const [, navigate] = useLocation();
  const complete = useMutation("settings.completeWelcome", { invalidates: ["settings.get"] });
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
      await complete.mutate({});
      navigate(newChatPath(), { replace: true });
    } catch (reason) {
      setError(errorText(reason));
      setBusy(false);
    }
  }
  return (
    <section className="welcome-panel welcome-ready">
      {/* The ready badge is the MARK alone, and the box hugs it: the tick pins to the
       *  sphere's own corner rather than to the far end of a wordmark-wide strip. The
       *  sphere is decorative, so the assembly carries the accessible name. Resting —
       *  setup is finished, which is what the tick says. */}
      <span className="relative mb-[22px] grid place-items-center" role="img" aria-label="Rennet">
        <LiquidSphere size={72} state="resting" />
        <i className="absolute right-0 -bottom-1 grid size-[31px] place-items-center rounded-full border-4 border-canvas bg-green text-surface [&_svg]:size-3.5">
          <Icon icon={Check} />
        </i>
      </span>
      <h1 className={STAGE_H1}>Make the next change digestible.</h1>
      <p className={cn(STAGE_P, "max-w-[620px]")}>
        Your review harness is ready. Choose a project when you start your first chat.
      </p>
      {/* Each row is icon + label + value: the glyph is what makes three cells read as
       *  three different KINDS of fact rather than one undifferentiated strip. */}
      <div className="my-8 grid w-full grid-cols-2 rounded-surface border border-line bg-surface max-md:grid-cols-1">
        {(
          [
            [Sparkles, "Orchestrator", orchestratorLabel],
            [Code, "Mode", modeLabel],
          ] as const
        ).map(([RowIcon, label, value], index) => (
          <span
            key={label}
            className={cn(
              "flex items-center justify-center gap-3 p-[18px]",
              index < 1 && "border-r border-line max-md:border-r-0 max-md:border-b",
            )}
          >
            <Icon icon={RowIcon} className="size-[22px] shrink-0 text-accent" />
            <span className="grid gap-1 text-left">
              <small className="text-2xs tracking-[0.08em] text-ink-faint uppercase">{label}</small>
              <strong>{value}</strong>
            </span>
          </span>
        ))}
      </div>
      {reviewChoice.orchestrator ? null : (
        <aside className={cn(PLAIN_NOTE, "[&>svg]:text-ink-faint")}>
          <Icon icon={TerminalSquare} />
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
        <Icon icon={MessageCircleMore} />
        {busy ? "Opening…" : "Start a new chat"}
        <Icon icon={ArrowRight} />
      </Button>
      <Button className="mt-2.5" variant="ghost" onClick={onBack}>
        <Icon icon={ArrowLeft} />
        Back
      </Button>
    </section>
  );
}

export function FirstRunWelcome({ settings }: { settings: SettingsView }) {
  const { activeSource } = useConnectionCapabilities();
  const [step, setStep] = useState(0);
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
        return <AccessStage onBack={() => setStep(2)} onContinue={() => setStep(4)} />;
      case 4:
        return <ReadyStage reviewChoice={reviewChoice} onBack={() => setStep(3)} />;
      default:
        return null;
    }
  }, [forges, harnesses, refreshForges, refreshHarnesses, reviewChoice, settings, step]);

  return (
    <WelcomeShell step={step} onStep={setStep}>
      {page}
    </WelcomeShell>
  );
}
