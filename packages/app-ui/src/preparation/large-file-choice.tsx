import { type LargeFileMode, type Locus, newCommandId } from "@rennet/protocol";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@rennet/ui";
import { ArrowLeft, Download, FileDown } from "lucide-react";
import { useId, useState } from "react";
import { Icon } from "../components/icon";
import { InstallForMe } from "../components/install-for-me";
import { useMutation } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// THE LARGE-FILE CHOICE (large-file-checkout spec, D4, task 3.4).
//
// Rai: "give the user a nice user friendly modal with the choice". This is a product
// choice, not a warning and not a consent gate (Rule Zero): two ways to check out a
// repository that stores large files with Git LFS, each said in one plain line, and the
// review continues the moment one is picked.
//
// It renders while preparation is `awaiting` the answer, and again from a failure whose
// recovery is choosing a mode. The lens presence keeps animating behind it — the review is
// still on its way — and Escape closes it to a calm line with a way back (the header owns
// that line), so dismissing it never strands the reviewer.
//
// Download needs Git LFS. When it is not installed, picking Download turns the dialog to
// Install for me and Skip for now, and the checkout continues after either (spec: "Download
// chosen, git-lfs missing"). Skip for now answers for this review only, so the project's
// next review asks again — "for now" is exactly that.
// ─────────────────────────────────────────────────────────────────────────────

export interface LargeFileChoiceProps {
  readonly sessionId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Whether Git LFS answers on the repository's machine. */
  readonly lfsAvailable: boolean;
  /** Where Install for me installs it. */
  readonly locus: Locus;
}

export function LargeFileChoice({
  sessionId,
  open,
  onOpenChange,
  lfsAvailable,
  locus,
}: LargeFileChoiceProps) {
  const choose = useMutation("session.chooseLargeFileMode", { invalidates: ["session.list"] });
  const [needsLfs, setNeedsLfs] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  // Answered: the dialog stays put, still, until the session row moves on and its owner
  // unmounts it. Closing it here would flash the "waiting for your choice" line for the
  // beat between the answer landing and the refreshed row arriving.
  const [answered, setAnswered] = useState(false);
  const busy = choose.pending || answered;

  const answer = (mode: LargeFileMode, remember = true) => {
    setFailure(undefined);
    void choose
      .mutate({ sessionId, mode, commandId: newCommandId(), remember })
      .then(() => setAnswered(true))
      .catch((reason: unknown) =>
        setFailure(
          reason instanceof Error && reason.message.length > 0
            ? reason.message
            : "Rennet couldn't record that choice. Try again.",
        ),
      );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setNeedsLfs(false);
        onOpenChange(next);
      }}
    >
      <DialogContent data-kind="large-file-choice" className="gap-5 p-6 sm:max-w-lg">
        {needsLfs ? (
          <>
            <DialogHeader>
              <DialogTitle>Downloading large files needs Git LFS</DialogTitle>
              <DialogDescription>
                Git LFS isn't installed on the machine that checks this repository out. Install it
                and the review continues with full files, or skip large files for now.
              </DialogDescription>
            </DialogHeader>
            <InstallForMe tool="git-lfs" locus={locus} onInstalled={() => answer("download")} />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => answer("skip", false)}
              >
                Skip for now
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setNeedsLfs(false)}>
                <Icon icon={ArrowLeft} />
                Back
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>This repository stores large files with Git LFS</DialogTitle>
              <DialogDescription>
                Choose how review checkouts of this project treat them.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <ChoiceCard
                mode="download"
                icon={Download}
                title="Download large files"
                description="Full files in the checkout. Slower to open."
                note={lfsAvailable ? undefined : "Needs Git LFS, which isn't installed here."}
                disabled={busy}
                onChoose={() => (lfsAvailable ? answer("download") : setNeedsLfs(true))}
              />
              <ChoiceCard
                mode="skip"
                icon={FileDown}
                title="Skip large files"
                description="Faster. Large files appear as small placeholder files."
                disabled={busy}
                onChoose={() => answer("skip")}
              />
            </div>
            <p className="text-ink-soft text-xs">
              Rennet remembers this for the project. You can change it in Settings.
            </p>
          </>
        )}
        {failure ? (
          <p role="alert" className="text-danger text-sm">
            {failure}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ChoiceCard({
  mode,
  icon,
  title,
  description,
  note,
  disabled,
  onChoose,
}: {
  readonly mode: LargeFileMode;
  readonly icon: typeof Download;
  readonly title: string;
  readonly description: string;
  readonly note?: string | undefined;
  readonly disabled: boolean;
  readonly onChoose: () => void;
}) {
  const describedBy = useId();
  return (
    <button
      type="button"
      data-choice={mode}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onChoose}
      className={cn(
        "flex items-start gap-3 rounded-xl border border-line bg-surface p-4 text-left transition-colors",
        "hover:border-accent-line hover:bg-accent-soft disabled:opacity-60",
      )}
    >
      <Icon icon={icon} className="mt-0.5 size-4 shrink-0 text-ink-soft" />
      <span className="flex flex-col gap-1">
        <span className="font-medium text-ink text-sm">{title}</span>
        <span id={describedBy} className="text-ink-soft text-xs">
          {description}
          {note ? <span className="mt-1 block text-warn">{note}</span> : null}
        </span>
      </span>
    </button>
  );
}
