import { newCommandId, type SessionPreparation, type SidebarSession } from "@rennet/protocol";
import { Button, cn } from "@rennet/ui";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { Icon } from "../components/icon";
import { InstallForMe, TOOL_NAME } from "../components/install-for-me";
import { useMutation } from "../data";
import { settingsPath } from "../routes/url";
import { LargeFileChoice } from "./large-file-choice";
import { useLfsAvailable, useProjectLocus } from "./session-locus";

// ─────────────────────────────────────────────────────────────────────────────
// THE PREPARATION FAILURE BLOCK (review-preparation-reliability D5/D6, task 3.3).
//
// One block for a preparation that stopped — failed or cancelled — in place of the thin
// strip that used to sit over an empty board. Rai, on the build it replaces: a pull request
// that "didn't look like it was working at all", then a raw git error. So:
//
//   • The message is the daemon's plain sentence (`reason`), never the tool's output.
//   • The action is the one the failure's kind calls for: Install for me (streaming its
//     output, with the command shown), Choose large-file mode (the large-file choice), or
//     Sign in (the GitHub account rows in Settings → Environments). Retry is always there.
//   • A missing Git LFS also offers Skip large files: skipping needs no Git LFS at all, so
//     it is a real way forward rather than a detour through an install.
//   • The raw output sits behind a details disclosure, rendered only when opened.
//
// A cancelled run is calm: it says so and offers Retry. Nothing here names a stage or a
// step; the stage is the daemon's bookkeeping, not something the reviewer acts on.
// ─────────────────────────────────────────────────────────────────────────────

type Stopped = Extract<SessionPreparation, { status: "failed" | "cancelled" }>;

export function PreparationFailure({
  session,
  preparation,
}: {
  readonly session: SidebarSession;
  readonly preparation: Stopped;
}) {
  const retry = useMutation("session.retryPreparation", { invalidates: ["session.list"] });
  const locus = useProjectLocus(session.projectId);
  const retryNow = () => void retry.mutate({ sessionId: session.id, commandId: newCommandId() });
  const failed = preparation.status === "failed";
  // Absent `kind` reads as unknown and absent `action` as retry (protocol D5).
  const action = failed ? (preparation.action ?? "retry") : "retry";

  return (
    <div className="border-line border-b bg-surface/60">
      <section
        data-testid="preparation-failure"
        data-status={preparation.status}
        data-failure-kind={failed ? (preparation.kind ?? "unknown") : undefined}
        data-action={action}
        role={failed ? "alert" : "status"}
        className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-8 py-6"
      >
        {failed ? (
          <p className="font-medium text-base text-ink">{preparation.reason}</p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="font-medium text-base text-ink">Cancelled</p>
            <p className="text-ink-soft text-sm">Retry when you’re ready.</p>
          </div>
        )}
        {failed && action === "install" ? (
          <InstallForMe
            tool={preparation.tool ?? "git-lfs"}
            locus={locus}
            label={`Install ${TOOL_NAME[preparation.tool ?? "git-lfs"]} for me`}
            onInstalled={retryNow}
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {failed && action === "install" && (preparation.tool ?? "git-lfs") === "git-lfs" ? (
            <SkipLargeFiles sessionId={session.id} />
          ) : null}
          {failed && action === "choose-large-files" ? (
            <ChooseLargeFiles session={session} />
          ) : null}
          {failed && action === "sign-in" ? <SignIn /> : null}
          <Button
            variant={action === "retry" ? "accent" : "outline"}
            size="sm"
            data-testid="workspace-retry"
            disabled={retry.pending}
            onClick={retryNow}
          >
            {retry.pending ? "Retrying…" : "Retry"}
          </Button>
        </div>
        {failed && preparation.detail !== undefined ? (
          <FailureDetail detail={preparation.detail} />
        ) : null}
      </section>
    </div>
  );
}

function SkipLargeFiles({ sessionId }: { readonly sessionId: string }) {
  const choose = useMutation("session.chooseLargeFileMode", { invalidates: ["session.list"] });
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={choose.pending}
      onClick={() => void choose.mutate({ sessionId, mode: "skip", commandId: newCommandId() })}
    >
      Skip large files
    </Button>
  );
}

function ChooseLargeFiles({ session }: { readonly session: SidebarSession }) {
  const [open, setOpen] = useState(false);
  const locus = useProjectLocus(session.projectId);
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

/** The raw tool output, behind a disclosure. Rendered only while open, so it is never on
 *  the page — or in a screen reader's way — until the reviewer asks for it. */
function FailureDetail({ detail }: { readonly detail: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      data-slot="failure-detail"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group text-sm"
    >
      <summary className="flex w-fit cursor-default list-none items-center gap-1 text-ink-soft text-xs hover:text-ink [&::-webkit-details-marker]:hidden">
        <Icon
          icon={ChevronRight}
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
        Details
      </summary>
      {open ? (
        <pre
          data-slot="failure-detail-output"
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-raised p-3 font-mono text-2xs text-ink-soft"
        >
          {detail}
        </pre>
      ) : null}
    </details>
  );
}
