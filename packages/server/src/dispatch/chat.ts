import { basename } from "node:path";
import { parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { ThreadBinding } from "../t3/threads";
import type { CommandHandler, DispatchRuntime } from "./runtime";

/**
 * The session's bound workspace as `threadFor` takes it (session-bound-workspace 5.2). The
 * review's own thread — the one chat and the handoff share — runs in the workspace the session
 * is bound to, not the repository root, so a PR snapshot's chat reads the reviewed head and a
 * branch review's chat reads the branch. A host with no resolver wired answers nothing and the
 * thread falls back to the project root, exactly as before the binding existed.
 */
async function boundWorkspaceInput(
  rt: DispatchRuntime,
  reviewId: string,
): Promise<{ worktreePath?: string; branch?: string }> {
  const bound = await rt.deps.boundWorkspaceForReview?.(reviewId);
  if (bound === undefined) return {};
  return {
    worktreePath: bound.root,
    ...(bound.branch === undefined ? {} : { branch: bound.branch }),
  };
}

/**
 * The review's own T3 thread — the ONE the chat dock, `chat.t3Send` and the handoff share.
 *
 * Every caller goes through here, and that is the point: the binding key root is the bound
 * WORKSPACE when the session has one and the repository otherwise (`keyRootOf` in
 * ../t3/threads), so a caller that assembled the input differently would key a SECOND
 * thread for the same review and split the transcript between them. `review.capture` now
 * binds this ahead of the dock (#849), which is exactly the situation that makes one
 * assembly point load-bearing rather than tidy.
 *
 * Keyed on the review's REPOSITORY ROOT and the review id — never the project — so two
 * repos on one branch get two threads (t3code-sidecar-chat 3.2).
 */
export async function bindReviewThread(
  rt: DispatchRuntime,
  reviewId: string,
): Promise<ThreadBinding> {
  const sidecar = rt.deps.t3Sidecar;
  if (!sidecar) throw new Error("this daemon has no T3 Code sidecar composed");
  const review = rt.requireReviewById(reviewId);
  return sidecar.threadFor({
    repositoryRoot: review.repositoryRoot,
    key: { kind: "session", sessionId: reviewId },
    title: basename(review.repositoryRoot) || "review",
    ...(await boundWorkspaceInput(rt, reviewId)),
  });
}

/** A thrown thing as a sentence a reviewer can read. Same shape as `t3/threads.ts`. */
export const describeThreadError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function chatHandlers(rt: DispatchRuntime) {
  const { deps } = rt;
  return {
    "chat.t3Session": async (rawInput) => {
      const name = "chat.t3Session" as const;
      // Broker sidecar access to a client (t3code-sidecar-chat, 2.4): the daemon owns the
      // credential, the client never reads the token file. The sidecar is already coming up
      // — the daemon started it at launch (#849) — so this usually joins a bring-up that is
      // finished or nearly so rather than beginning one; it still starts one when it has to,
      // with no gate and no confirmation (Rule Zero). Absent supervisor ⇒ this daemon was
      // composed without a vendored bundle; say so.
      const input = parseCommandInput(name, rawInput);
      if (!deps.t3Sidecar) {
        throw new Error("chat.t3Session: this daemon has no T3 Code sidecar composed");
      }
      const session = await deps.t3Sidecar.session();
      if (input.reviewId === undefined) return parseCommandOutput(name, session);
      // With a review: its own thread, through the one assembly point. `review.capture`
      // has normally bound it already, so this reads the existing row.
      //
      // A FAILED BIND IS A REPORTED STATE, NOT A REJECTION (#872). The environment and the
      // bearer above are good whatever the bind does, and throwing here threw them away
      // too: an unknown review id, or a bound workspace that has been deleted, surfaced in
      // the dock as "T3 Code sidecar unavailable" over a perfectly healthy sidecar, and the
      // mount never rendered. The reviewer gets the session, plus the reason in the arm.
      try {
        const binding = await bindReviewThread(rt, input.reviewId);
        return parseCommandOutput(name, {
          ...session,
          thread: {
            status: "bound",
            threadId: binding.threadId,
            threadUrl: `${session.origin}/${session.environmentId}/${binding.threadId}`,
          },
        });
      } catch (error) {
        return parseCommandOutput(name, {
          ...session,
          thread: { status: "unavailable", reason: describeThreadError(error) },
        });
      }
    },
    // chat.t3Send (t3-lens-threads 4.2): start a turn on the review's bound thread with the
    // client's text. The anchored ask's path — it replaces `review.ask`, whose orchestrator
    // session is retired. Same binding rule as `chat.t3Session`: keyed on the review's
    // REPOSITORY ROOT, so two repos on one branch never share a thread.
    "chat.t3Send": async (rawInput) => {
      const name = "chat.t3Send" as const;
      const input = parseCommandInput(name, rawInput);
      if (!deps.t3Sidecar) {
        throw new Error("chat.t3Send: this daemon has no T3 Code sidecar composed");
      }
      // A FAILED ASK IS A REPORTED STATE, NOT A REJECTION — the #872 ruling `chat.t3Session`
      // already follows twenty lines up, applied to the send. It threw here, so the IDENTICAL
      // condition (a deleted bound workspace, an unknown review, a sidecar that will not come
      // up) rendered calmly in the dock on the read and became an untyped rejection on the
      // send. The client had nowhere to put an untyped rejection and dropped it on the floor:
      // the dock opened, nothing streamed, and the reviewer concluded "explain no longer
      // works" (#888) while their own question sat in the quote thread looking delivered.
      //
      // The reason travels verbatim so the reviewer can tell the two apart — a sidecar that
      // is not built ("the vendored T3 Code server bundle is not built") reads nothing like a
      // daemon whose descriptors ran out ("spawn EBADF"), and only one of those is worth
      // retrying. Nothing here fabricates a reply; it reports that the question did not go.
      try {
        const binding = await bindReviewThread(rt, input.reviewId);
        const client = await deps.t3Sidecar.client();
        await client.startTurn({ threadId: binding.threadId, text: input.text });
        return parseCommandOutput(name, { status: "sent", threadId: binding.threadId });
      } catch (error) {
        return parseCommandOutput(name, {
          status: "unavailable",
          reason: describeThreadError(error),
        });
      }
    },
  } satisfies Record<string, CommandHandler>;
}
