import { newCommandId, type SessionPreparation, type SidebarSession } from "@rennet/protocol";
import { Button } from "@rennet/ui";
import { useState } from "react";
import { useLocation } from "wouter";
import { FailureDetail } from "../components/failure-detail";
import { InstallForMe, TOOL_NAME } from "../components/install-for-me";
import { useMutation } from "../data";
import { useScopedState } from "../data/scoped-state";
import { useInstalledByOwner } from "../data/tool-install";
import { settingsPath } from "../routes/url";
import { ActionFailureLine, useActionFailure } from "./action-failure";
import { preparationFailureCopy } from "./failure-copy";
import { LARGE_FILE_REMEMBERED, LargeFileChoice } from "./large-file-choice";
import { useLfsAvailable, useProjectLocus } from "./session-locus";

// ─────────────────────────────────────────────────────────────────────────────
// THE PREPARATION FAILURE BLOCK (review-preparation-reliability D5/D6, task 3.3).
//
// One block for a preparation that stopped — failed or cancelled — in place of the thin
// strip that used to sit over an empty board. Rai, on the build it replaces: a pull request
// that "didn't look like it was working at all", then a raw git error. So:
//
//   • The message is the daemon's plain sentence (`reason`) when the failure is classified,
//     and a fixed plain sentence when it is not: an unclassified `reason` is whatever the
//     failing step said, so it moves behind Details with the raw output (`failure-copy.ts`).
//   • The action is the one the failure's kind calls for: Install for me (streaming its
//     output, with the command shown), Choose large-file mode (the large-file choice), or
//     Sign in (the GitHub account rows in Settings → Environments). Retry is always there.
//   • A missing Git LFS also offers Skip large files: skipping needs no Git LFS at all, so
//     it is a real way forward rather than a detour through an install.
//   • The raw output sits behind a details disclosure, rendered only when opened.
//
// A cancelled run is calm: it says so and offers Retry. Nothing here names a stage or a
// step; the stage is the daemon's bookkeeping, not something the reviewer acts on.
//
// Install for me sends nothing when it lands. Its verdict ("Git LFS is installed") shows in
// the block and Retry becomes the primary action, so the next step is one obvious click by
// the reviewer. Retrying on the reviewer's behalf raced Cancel and their own Retry. The
// install is kept per session, so it survives the block unmounting. A Retry that did not go
// through says so from the per-session slot, so a block remounted by the route still shows it.
// ─────────────────────────────────────────────────────────────────────────────

type Stopped = Extract<SessionPreparation, { status: "failed" | "cancelled" }>;

/** Where a session's failure block keeps a Retry's failure across a remount. */
export function retryFailureKey(sessionId: string): string {
  return `preparation-retry-failure:${sessionId}`;
}

const RETRY_FAILED = "Rennet couldn't start this review again. Try again.";

/** The owner an install started from a session's failure block runs under. */
export function failureInstallOwner(sessionId: string): string {
  return `failure:${sessionId}`;
}

export function PreparationFailure({
  session,
  preparation,
}: {
  readonly session: SidebarSession;
  readonly preparation: Stopped;
}) {
  const retry = useMutation("session.retryPreparation", { invalidates: ["session.list"] });
  const [retryFailure, , retryFailureHandle] = useScopedState<string | undefined>(
    retryFailureKey(session.id),
    undefined,
  );
  const { locus, failed: locusFailed, retry: rereadLocus } = useProjectLocus(session.projectId);
  const sessionId = session.id;
  const retryNow = () => {
    retryFailureHandle.set(undefined);
    retry
      .mutate({ sessionId, commandId: newCommandId() })
      .catch(() => retryFailureHandle.set(RETRY_FAILED));
  };
  const failed = preparation.status === "failed";
  // Absent `kind` reads as unknown and absent `action` as retry (protocol D5).
  const action = failed ? (preparation.action ?? "retry") : "retry";
  const copy = failed ? preparationFailureCopy(preparation) : undefined;
  const tool = failed ? (preparation.tool ?? "git-lfs") : "git-lfs";
  const owner = failureInstallOwner(session.id);
  // The tool is installed now, by the daemon's own verdict: Retry is the way forward.
  const installed = useInstalledByOwner({ tool, locus, owner });
  const retryPrimary = action === "retry" || (action === "install" && installed);

  return (
    <div className="border-line border-b bg-surface/60">
      <section
        data-testid="preparation-failure"
        data-status={preparation.status}
        data-failure-kind={failed ? (preparation.kind ?? "unknown") : undefined}
        data-action={action}
        className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-8 py-6"
      >
        {/* The live region is the SENTENCE alone. On the whole block it re-announced every
            line an install streamed into the drawer below as part of the alert; that drawer
            is its own polite log (`install-for-me.tsx`), outside this region. */}
        {copy ? (
          <p role="alert" className="font-medium text-base text-ink">
            {copy.headline}
          </p>
        ) : (
          <div role="status" className="flex flex-col gap-1">
            <p className="font-medium text-base text-ink">Cancelled</p>
            <p className="text-ink-soft text-sm">Retry when you’re ready.</p>
          </div>
        )}
        {failed && action === "install" ? (
          <>
            <InstallForMe
              tool={tool}
              locus={locus}
              owner={owner}
              label={`Install ${TOOL_NAME[tool]} for me`}
            />
            {locusFailed ? (
              <p className="flex flex-wrap items-center gap-2 text-ink-soft text-sm">
                Rennet couldn't tell which machine this project is on.
                <Button variant="ghost" size="xs" onClick={rereadLocus}>
                  Check again
                </Button>
              </p>
            ) : null}
          </>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {failed && action === "install" && tool === "git-lfs" ? (
            <SkipLargeFiles sessionId={session.id} />
          ) : null}
          {failed && action === "choose-large-files" ? (
            <ChooseLargeFiles session={session} />
          ) : null}
          {failed && action === "sign-in" ? <SignIn /> : null}
          <Button
            variant={retryPrimary ? "accent" : "outline"}
            size="sm"
            data-testid="workspace-retry"
            data-emphasis={retryPrimary ? "primary" : "secondary"}
            disabled={retry.pending}
            onClick={retryNow}
          >
            {retry.pending ? "Retrying…" : "Retry"}
          </Button>
        </div>
        <ActionFailureLine message={retryFailure} />
        {copy?.detail !== undefined ? <FailureDetail detail={copy.detail} /> : null}
      </section>
    </div>
  );
}

/**
 * The other way forward when Git LFS is missing: skip large files. It is the same answer as
 * the large-file dialog's "Skip large files" and says so in the same words — remembered for
 * the project, changeable in Settings — so the two never disagree about what was decided.
 */
function SkipLargeFiles({ sessionId }: { readonly sessionId: string }) {
  const choose = useMutation("session.chooseLargeFileMode", { invalidates: ["session.list"] });
  const skipFailure = useActionFailure();
  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={choose.pending}
          onClick={() => {
            skipFailure.run(
              () =>
                choose.mutate({
                  sessionId,
                  mode: "skip",
                  commandId: newCommandId(),
                  remember: true,
                }),
              "Rennet couldn't record that choice. Try again.",
            );
          }}
        >
          Skip large files
        </Button>
      </div>
      <p data-slot="skip-remembered" className="text-ink-soft text-xs">
        {LARGE_FILE_REMEMBERED}
      </p>
      <ActionFailureLine message={skipFailure.message} />
    </div>
  );
}

function ChooseLargeFiles({ session }: { readonly session: SidebarSession }) {
  const [open, setOpen] = useState(false);
  const { locus } = useProjectLocus(session.projectId);
  const lfsAvailable = useLfsAvailable(locus);
  return (
    <>
      <Button variant="accent" size="sm" onClick={() => setOpen(true)}>
        Choose large-file mode
      </Button>
      <LargeFileChoice
        sessionId={session.id}
        open={open}
        onOpenChange={setOpen}
        // Unknown reads as available: the failure was about large files, not a missing
        // tool, and a guess of "missing" would invent an install the reviewer does not need.
        lfsAvailable={lfsAvailable ?? true}
        locus={locus}
      />
    </>
  );
}

function SignIn() {
  const [, navigate] = useLocation();
  return (
    <Button variant="accent" size="sm" onClick={() => navigate(settingsPath("environments"))}>
      Sign in
    </Button>
  );
}
