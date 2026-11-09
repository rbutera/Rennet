import type { CommandOutput, Locus, SourceControlToolId } from "@rennet/protocol";
import { Button, Collapse, cn, Spinner } from "@rennet/ui";
import { Check, ChevronRight, Copy, ExternalLink } from "lucide-react";
import { useId, useState } from "react";
import { useToolInstall } from "../data/tool-install";
import { Icon } from "./icon";

// ─────────────────────────────────────────────────────────────────────────────
// Install for me (source-control-tooling spec) — ONE component for every place Rennet
// reports a missing `git` or `git-lfs`: the preparation failure block, the large-file
// prompt, Settings → Environments and the first-run tools stage.
//
// What it promises, and nothing more:
//   • Pressing the button runs the platform installer. No confirmation (Rule Zero).
//   • The output streams into a drawer while it runs, and Cancel stops it.
//   • The verdict is the daemon's re-probe, not the installer's exit code: `installed`
//     means the tool now answers. A failure says so plainly, with the output as detail.
//   • The command is always shown once it is known — WHILE the install runs as well as after
//     — with a copy button, so the person can run it themselves. Where no installer exists
//     the daemon runs nothing and answers `manual`: the command and a link replace the button.
//   • Until the machine to install on is known the button waits, disabled: an install that
//     guessed "this Mac" for a WSL project would install on the wrong machine.
//
// `onInstalled` is the parent's hook to Retry a preparation or re-read a row. `owner` keeps
// the install with whoever it is for (a session) across remounts — see `useToolInstall`.
// ─────────────────────────────────────────────────────────────────────────────

export const TOOL_NAME: Readonly<Record<SourceControlToolId, string>> = {
  git: "Git",
  "git-lfs": "Git LFS",
};

type InstallResult = CommandOutput<"tools.install">["result"];

export interface InstallForMeProps {
  readonly tool: SourceControlToolId;
  /** Where to install. Undefined while it is still being worked out: the button waits. */
  readonly locus: Locus | undefined;
  /** Whose install this is (a session id). Absent, it belongs to this component alone. */
  readonly owner?: string;
  readonly onInstalled?: (result: Extract<InstallResult, { status: "installed" }>) => void;
  /** The button's own label, when a surface needs to say more than "Install for me". */
  readonly label?: string;
  readonly className?: string;
}

export function InstallForMe({
  tool,
  locus,
  owner,
  onInstalled,
  label = "Install for me",
  className,
}: InstallForMeProps) {
  const install = useToolInstall({
    tool,
    locus,
    ...(owner === undefined ? {} : { owner }),
    ...(onInstalled ? { onInstalled } : {}),
  });
  const { state } = install;
  const name = TOOL_NAME[tool];
  const phase = state.phase === "done" ? state.result.status : state.phase;

  return (
    <div
      data-kind="install-for-me"
      data-tool={tool}
      data-phase={phase}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      {state.phase === "idle" ? (
        <div>
          <Button
            variant="accent"
            size="sm"
            disabled={locus === undefined}
            aria-busy={locus === undefined || undefined}
            onClick={install.start}
          >
            {label}
          </Button>
        </div>
      ) : state.phase === "running" ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span role="status" className="flex items-center gap-2 text-ink text-sm">
              <Spinner aria-hidden="true" className="size-3.5 text-ink-soft" />
              {state.cancelling
                ? `Stopping the ${name} install…`
                : state.reconnecting === true
                  ? `Installing ${name}… reconnecting`
                  : `Installing ${name}…`}
            </span>
            <Button variant="ghost" size="xs" disabled={state.cancelling} onClick={install.cancel}>
              Cancel
            </Button>
          </div>
          {state.command === undefined ? null : <CommandLine command={state.command} />}
          <OutputDrawer output={state.output} defaultOpen live />
        </>
      ) : state.phase === "unavailable" ? (
        <>
          <p className="text-danger text-sm">{state.message}</p>
          <div>
            <Button variant="outline" size="sm" onClick={install.start}>
              Try again
            </Button>
          </div>
        </>
      ) : (
        <InstallVerdict name={name} result={state.result} onRetry={install.start} />
      )}
    </div>
  );
}

function InstallVerdict({
  name,
  result,
  onRetry,
}: {
  readonly name: string;
  readonly result: InstallResult;
  readonly onRetry: () => void;
}) {
  switch (result.status) {
    case "installed":
      return (
        <>
          <p role="status" className="flex items-center gap-2 text-ink text-sm">
            <Icon icon={Check} strokeWidth={2.5} className="size-3.5 text-green" />
            {name} is installed
            {result.probe.version ? (
              <code className="font-mono text-2xs text-ink-faint">{result.probe.version}</code>
            ) : null}
          </p>
          {/* Empty only when the verdict came from a re-probe after a dropped connection
              that never heard which command ran. */}
          {result.command.length > 0 ? <CommandLine command={result.command} /> : null}
          <OutputDrawer output={result.output} />
        </>
      );
    case "failed":
      return (
        <>
          <p role="alert" className="text-danger text-sm">
            {result.cancelled ? `The ${name} install was stopped.` : result.message}
          </p>
          <CommandLine
            command={result.failedCommand}
            note={
              result.cancelled
                ? "stopped while running"
                : result.exitCode === null
                  ? undefined
                  : `exited with code ${result.exitCode}`
            }
          />
          <OutputDrawer output={result.output} />
          <div>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        </>
      );
    case "manual":
      return (
        <>
          <p className="text-ink text-sm">
            Rennet can't install {name} here. Run this in a terminal:
          </p>
          <CommandLine command={result.command} />
          <a
            href={result.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1 text-accent text-xs underline underline-offset-2"
          >
            {name} install instructions
            <Icon icon={ExternalLink} className="size-3" />
          </a>
        </>
      );
  }
}

/** A command a person can read and copy. */
function CommandLine({ command, note }: { readonly command: string; readonly note?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <code
        data-slot="install-command"
        className="min-w-0 break-all rounded-sm bg-raised px-1.5 py-0.5 font-mono text-12-5 text-ink"
      >
        {command}
      </code>
      <Button
        variant="ghost"
        size="xs"
        aria-label={copied ? "Copied" : `Copy ${command}`}
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(
            () => setCopied(true),
            () => undefined,
          );
        }}
      >
        <Icon icon={copied ? Check : Copy} />
        {copied ? "Copied" : "Copy"}
      </Button>
      {note ? <span className="text-2xs text-ink-soft">{note}</span> : null}
    </div>
  );
}

/** The installer's output, folded. While a run is live the log announces politely. */
function OutputDrawer({
  output,
  defaultOpen = false,
  live = false,
}: {
  readonly output: string;
  readonly defaultOpen?: boolean;
  readonly live?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  if (!live && output.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="flex w-fit items-center gap-1 text-ink-soft text-xs hover:text-ink"
      >
        <Icon
          icon={ChevronRight}
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
        {open ? "Hide output" : "Show output"}
      </button>
      <Collapse open={open}>
        <pre
          id={id}
          data-slot="install-output"
          role="log"
          aria-live={live ? "polite" : "off"}
          className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-raised p-2 font-mono text-2xs text-ink-soft"
        >
          {output.length > 0 ? output : " "}
        </pre>
      </Collapse>
    </div>
  );
}
