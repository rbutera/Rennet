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
import { ArrowLeft, Check, Download, FileDown } from "lucide-react";
import { type RefObject, useId } from "react";
import { Icon } from "../components/icon";
import { InstallForMe } from "../components/install-for-me";
import { useMutation } from "../data";
import { useScopedState } from "../data/scoped-state";
import { useInstalledByOwner } from "../data/tool-install";

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
// Install for me and Skip for now (spec: "Download chosen, git-lfs missing"). Skip for now
// answers for this review only, so the project's next review asks again — "for now" is
// exactly that. When the install lands, the dialog goes back to the two choices with
// Download available and says Git LFS is installed; the reviewer clicks Download. The
// install answers nothing itself: an answer sent on the reviewer's behalf raced Cancel.
//
// WHAT OUTLIVES THE DIALOG. The route can swap the workspace under it mid-question (the
// review attaches while the question is open), so which screen it is on, whether it was
// answered, and the install running under it are kept per session (`useScopedState`, and
// the install's own `owner`), not in this component. Closing it — Escape — does not stop an
// install either: it keeps running, and reopening the dialog finds it, or its verdict. A
// failure to record the answer is kept per session too, so the remounted dialog says it.
// ─────────────────────────────────────────────────────────────────────────────

export interface LargeFileChoiceProps {
  readonly sessionId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Whether Git LFS answers on the repository's machine. */
  readonly lfsAvailable: boolean;
  /** Where Install for me installs it; undefined while that is not known yet. */
  readonly locus: Locus | undefined;
  /** Where focus goes when the dialog closes, when not back to whatever opened it. */
  readonly finalFocus?: RefObject<HTMLElement | null>;
}

/** What the dialog remembers for a session across a remount. */
interface ChoiceScreen {
  /** On the "Downloading large files needs Git LFS" screen. */
  readonly needsLfs: boolean;
  /** An answer has been recorded; the dialog holds still until the row moves on. */
  readonly answered: boolean;
}

/** What a remembered answer means, said the same way wherever one is given. */
export const LARGE_FILE_REMEMBERED =
  "Rennet remembers this for the project. You can change it in Settings.";

const FIRST_SCREEN: ChoiceScreen = { needsLfs: false, answered: false };

/** The owner an install started from a session's large-file dialog runs under. */
export function largeFileInstallOwner(sessionId: string): string {
  return `large-file:${sessionId}`;
}

/** Where a session's large-file dialog keeps a failed answer's sentence across a remount. */
export function largeFileFailureKey(sessionId: string): string {
  return `large-file-failure:${sessionId}`;
}

export function LargeFileChoice({
  sessionId,
  open,
  onOpenChange,
  lfsAvailable,
  locus,
  finalFocus,
}: LargeFileChoiceProps) {
  const choose = useMutation("session.chooseLargeFileMode", { invalidates: ["session.list"] });
  const [screen, setScreen, screenHandle] = useScopedState<ChoiceScreen>(
    `large-file-choice:${sessionId}`,
    FIRST_SCREEN,
  );
  // Per session, like the screen: an answer that failed just before the route swap remounted
  // this dialog must still be able to say it did not go through.
  const [failure, setFailure] = useScopedState<string | undefined>(
    largeFileFailureKey(sessionId),
    undefined,
  );
  const owner = largeFileInstallOwner(sessionId);
  // Git LFS installed from this dialog: Download is available now, so the "needs Git LFS"
  // screen gives way to the choice again. Only the daemon's own verdict says so.
  const installedHere = useInstalledByOwner({ tool: "git-lfs", locus, owner });
  const lfsReady = lfsAvailable || installedHere;
  const needsLfs = screen.needsLfs && !installedHere;
  const { answered } = screen;
  // Answered: the dialog stays put, still, until the session row moves on and its owner
  // unmounts it. Closing it here would flash the "waiting for your choice" line for the
  // beat between the answer landing and the refreshed row arriving.
  const busy = choose.pending || answered;

  const answer = (mode: LargeFileMode, remember = true) => {
    setFailure(undefined);
    choose
      .mutate({ sessionId, mode, commandId: newCommandId(), remember })
      .then(() => screenHandle.set((previous) => ({ ...previous, answered: true })))
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
        // Closing keeps the screen it was on: an install running under "needs Git LFS" is
        // still running, and the way back should land on it.
        onOpenChange(next);
      }}
    >
      <DialogContent
        data-kind="large-file-choice"
        {...(finalFocus === undefined ? {} : { finalFocus })}
        className="gap-5 p-6"
        // Wider than the kit's 24rem default, so each choice's one line reads on one line.
        // Inline because, in the packaged app, a `sm:max-w-*` utility override of the kit's
        // `sm:max-w-sm` did not take effect (the dialog rendered full-width); a style wins.
        style={{ maxWidth: "min(520px, calc(100% - 2rem))" }}
      >
        {needsLfs ? (
          <>
            <DialogHeader>
              <DialogTitle>Downloading large files needs Git LFS</DialogTitle>
              <DialogDescription>
                Git LFS isn't installed on the machine that checks this repository out. Install it
                and the review continues with full files, or skip large files for now.
              </DialogDescription>
            </DialogHeader>
            <InstallForMe tool="git-lfs" locus={locus} owner={owner} />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => answer("skip", false)}
              >
                Skip for now
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setScreen((previous) => ({ ...previous, needsLfs: false }))}
              >
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
            {installedHere ? (
              <p
                role="status"
                data-slot="lfs-installed"
                className="flex items-center gap-2 text-ink text-sm"
              >
                <Icon icon={Check} strokeWidth={2.5} className="size-3.5 text-green" />
                Git LFS is installed. You can download large files now.
              </p>
            ) : null}
            <div className="grid gap-3">
              <ChoiceCard
                mode="download"
                icon={Download}
                title="Download large files"
                description="Full files in the checkout. Slower to open."
                note={lfsReady ? undefined : "Needs Git LFS, which isn't installed here."}
                disabled={busy}
                onChoose={() =>
                  lfsReady
                    ? answer("download")
                    : setScreen((previous) => ({ ...previous, needsLfs: true }))
                }
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
            <p className="text-ink-soft text-xs">{LARGE_FILE_REMEMBERED}</p>
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
